import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OutsideAgentConnectionRepository } from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FINISHED_HOLD_MS } from "../pushAlerts/pushAlertRules.ts";
import {
  AssistantEventRepository,
  AssistantEventRepositoryLive,
} from "./AssistantEventRepository.ts";
import { AssistantEvents } from "./AssistantEvents.ts";
import { AssistantEventsLayer } from "./AssistantEventsLive.ts";

const THREAD = ThreadId.make("thread-1");
const PROJECT = ProjectId.make("project-app");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD,
    projectId: PROJECT,
    title: "Fix the build",
    activities: [],
    proposedPlans: [],
    latestTurn: null,
    session: null,
    queuedFollowUps: [],
    sideTurn: null,
    childRequests: {
      open: [],
      deliveryEpoch: 0,
      startsSinceUser: 0,
      sendsSinceUser: 0,
      pendingNotes: [],
    },
    ...overrides,
  } as unknown as OrchestrationThread;
}

/**
 * A computer with an assistant connected: the event log and the thread as
 * the projections read it are fakes the test drives; the record's storage is
 * real SQLite, kept across `restart`s.
 */
const makeHarness = Effect.gen(function* () {
  const events: OrchestrationEvent[] = [];
  const published = yield* PubSub.unbounded<OrchestrationEvent>();
  const state = { thread: makeThread(), assistants: 1 };
  const storage = yield* Layer.build(SqlitePersistenceMemory);
  // The real storage, but the event log is the fake's: its newest event is where a record starts.
  const repository = Layer.effect(
    AssistantEventRepository,
    Effect.gen(function* () {
      const real = yield* AssistantEventRepository;
      return AssistantEventRepository.of({
        ...real,
        latestEventSequence: Effect.sync(() => events.at(-1)?.sequence ?? 0),
      });
    }),
  ).pipe(Layer.provide(AssistantEventRepositoryLive));
  const layer = AssistantEventsLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        repository,
        Layer.mock(OutsideAgentConnectionRepository)({
          countLive: () => Effect.sync(() => state.assistants),
        }),
        Layer.mock(OrchestrationEngineService)({
          readEvents: (after) => Stream.fromIterable(events.filter((e) => e.sequence > after)),
          streamDomainEvents: Stream.fromPubSub(published),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.sync(() => Option.some(state.thread)),
        }),
      ),
    ),
    Layer.provide(Layer.succeedContext(storage)),
  );
  /** Starts the record in its own scope; closing it is the process stopping. */
  const boot = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    const record = yield* AssistantEvents.pipe(Effect.provide(context));
    yield* record.start().pipe(Scope.provide(scope));
    return { record, stop: Scope.close(scope, Exit.void) };
  });
  return { events, published, state, boot };
});

type Harness = Effect.Success<typeof makeHarness>;

let sequence = 0;
const appended = (harness: Harness, type: OrchestrationEvent["type"], payload: object) =>
  Effect.gen(function* () {
    sequence += 1;
    const event = {
      sequence,
      eventId: EventId.make(`event-${sequence}`),
      type,
      aggregateKind: "thread",
      aggregateId: THREAD,
      occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      commandId: CommandId.make(`command-${sequence}`),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload,
    } as OrchestrationEvent;
    harness.events.push(event);
    yield* PubSub.publish(harness.published, event);
    return event;
  });

/** Lets the record's loops run: time moves on in small steps. */
const settle = (ms = 500) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
    }
  });

const approvalRequested = (requestId: string) => ({
  threadId: THREAD,
  activity: {
    id: `activity-${requestId}`,
    tone: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: { requestId, requestKind: "command" },
    turnId: "turn-1",
    createdAt: "2026-10-23T12:00:00.000Z",
  },
});

const turnCompleted = (turnId: string, state: "completed" | "error" = "completed") => ({
  threadId: THREAD,
  turnId,
  state,
  completedAt: "2026-10-23T12:00:00.000Z",
});

const recorded = (record: Effect.Success<Harness["boot"]>["record"]) =>
  record.since({ after: 0, limit: 100 }).pipe(Effect.map((page) => page.events));

it.layer(NodeServices.layer)("AssistantEvents", (it) => {
  it.effect(
    "records with no phone at all, for a thread being looked at, and for an event read late",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          yield* TestClock.adjust("1 hour");
          const { record } = yield* harness.boot;
          yield* settle();

          harness.state.thread = makeThread({
            latestTurn: { turnId: "turn-1", state: "completed" } as never,
          });
          const completed = yield* appended(
            harness,
            "thread.turn-completed",
            turnCompleted("turn-1"),
          );
          // Opened right away (the app stamps the visit with the turn's
          // completion): phones would stay quiet; the record still gets it, as seen.
          yield* appended(harness, "thread.seen-set", {
            threadId: THREAD,
            at: completed.occurredAt,
          });
          yield* settle(FINISHED_HOLD_MS + 1_000);
          const [finished] = yield* recorded(record);
          assert.strictEqual(finished?.name, "thread.finished");
          assert.strictEqual(finished?.projectId, PROJECT);
          assert.strictEqual(finished?.resolvedReason, "seen");

          // "Mark unread" stamps a moment before the completion: not seen.
          harness.state.thread = makeThread({
            latestTurn: { turnId: "turn-2", state: "completed" } as never,
          });
          const second = yield* appended(harness, "thread.turn-completed", turnCompleted("turn-2"));
          yield* appended(harness, "thread.seen-set", {
            threadId: THREAD,
            at: new Date(Date.parse(second.occurredAt) - 1).toISOString(),
          });
          yield* settle(FINISHED_HOLD_MS + 1_000);
          assert.strictEqual((yield* recorded(record))[1]?.resolvedReason, null);

          // Read an hour late (the computer slept): still recorded.
          const late = yield* appended(
            harness,
            "thread.activity-appended",
            approvalRequested("r1"),
          );
          harness.events[harness.events.indexOf(late)] = {
            ...late,
            occurredAt: new Date((yield* Clock.currentTimeMillis) - 3_600_000).toISOString(),
          };
          harness.state.thread = makeThread({
            activities: [approvalRequested("r1").activity] as never,
          });
          yield* settle();
          const names = (yield* recorded(record)).map((event) => event.name);
          assert.deepStrictEqual(names, ["thread.finished", "thread.finished", "thread.needs_you"]);
        }),
      ),
  );

  it.effect("finishes a settle a restart cut short, with nothing lost or recorded twice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* TestClock.adjust("1 hour");
        const first = yield* harness.boot;
        yield* settle();
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-1", state: "completed" } as never,
        });
        yield* appended(harness, "thread.turn-completed", turnCompleted("turn-1"));
        yield* settle(2_000);
        yield* first.stop;
        assert.deepStrictEqual(yield* recorded(first.record), []);

        const second = yield* harness.boot;
        yield* settle(FINISHED_HOLD_MS);
        // The same event delivered again after the restart changes nothing.
        yield* PubSub.publish(harness.published, harness.events.at(-1)!);
        yield* settle(FINISHED_HOLD_MS);
        const events = yield* recorded(second.record);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0]?.seq, 1);
      }),
    ),
  );

  it.effect("drops a turn the user stopped while it settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* TestClock.adjust("1 hour");
        const { record } = yield* harness.boot;
        yield* settle();
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-1", state: "error" } as never,
        });
        yield* appended(harness, "thread.turn-completed", turnCompleted("turn-1", "error"));
        yield* settle(1_000);
        yield* appended(harness, "thread.turn-interrupt-requested", {
          threadId: THREAD,
          turnId: "turn-1",
        });
        yield* settle(5_000);
        assert.deepStrictEqual(yield* recorded(record), []);
      }),
    ),
  );

  it.effect("numbers events in the order they became final", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* TestClock.adjust("1 hour");
        const { record } = yield* harness.boot;
        yield* settle();
        const asked = approvalRequested("r1");
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-1", state: "completed" } as never,
          activities: [asked.activity] as never,
        });
        yield* appended(harness, "thread.turn-completed", turnCompleted("turn-1"));
        yield* settle(2_000);
        // Asked while the finished turn still settles: final first, so numbered first.
        yield* appended(harness, "thread.activity-appended", asked);
        yield* settle(1_000);
        // Answered: the finished turn has nothing left going, and the request stops standing.
        const answered = {
          ...asked.activity,
          id: "activity-r1-resolved",
          kind: "approval.resolved",
          payload: { requestId: "r1", decision: "accept" },
        };
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-1", state: "completed" } as never,
          activities: [asked.activity, answered] as never,
        });
        yield* appended(harness, "thread.activity-appended", {
          threadId: THREAD,
          activity: answered,
        });
        yield* settle(FINISHED_HOLD_MS);
        const events = yield* recorded(record);
        assert.deepStrictEqual(
          events.map((event) => [event.seq, event.name, event.resolvedReason]),
          [
            [1, "thread.needs_you", "answered"],
            [2, "thread.finished", null],
          ],
        );
        // And the cursor reads only what came after it.
        const after = yield* record.since({ after: 1, limit: 10 });
        assert.deepStrictEqual(
          after.events.map((event) => event.seq),
          [2],
        );
        assert.strictEqual(after.upTo, 2);
      }),
    ),
  );

  it.effect("records a plan left to review as needs-you, resolved once it's dismissed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* TestClock.adjust("1 hour");
        const { record } = yield* harness.boot;
        yield* settle();
        const plan = {
          id: "plan-1",
          turnId: "turn-1",
          planMarkdown: "# Move the cache",
          implementedAt: null,
          implementationThreadId: null,
          dismissedAt: null,
          createdAt: "2026-10-23T12:00:00.000Z",
          updatedAt: "2026-10-23T12:00:00.000Z",
        };
        harness.state.thread = makeThread({
          latestTurn: { turnId: "turn-1", state: "completed" } as never,
          proposedPlans: [plan] as never,
        });
        yield* appended(harness, "thread.turn-completed", turnCompleted("turn-1"));
        yield* settle(FINISHED_HOLD_MS + 1_000);
        const [needsYou] = yield* recorded(record);
        assert.strictEqual(needsYou?.name, "thread.needs_you");
        assert.strictEqual(needsYou?.reason, "plan");
        assert.strictEqual(needsYou?.resolvedAt, null);

        yield* appended(harness, "thread.proposed-plan-upserted", {
          threadId: THREAD,
          proposedPlan: { ...plan, dismissedAt: "2026-10-23T12:05:00.000Z" },
        });
        yield* settle();
        const [after] = yield* recorded(record);
        assert.strictEqual(after?.resolvedReason, "plan_closed");
      }),
    ),
  );

  it.effect("keeps nothing from before it turned on, and forgets events after 7 days", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.state.assistants = 0;
        yield* TestClock.adjust("1 hour");
        const { record } = yield* harness.boot;
        harness.state.thread = makeThread({
          activities: [approvalRequested("before").activity] as never,
        });
        yield* appended(harness, "thread.activity-appended", approvalRequested("before"));
        yield* settle();
        assert.isFalse((yield* record.position).running);

        // An assistant connects: the record starts from the newest event.
        harness.state.assistants = 1;
        yield* PubSub.publish(harness.published, harness.events.at(-1)!);
        yield* settle();
        assert.isTrue((yield* record.position).running);
        harness.state.thread = makeThread({
          activities: [
            approvalRequested("before").activity,
            approvalRequested("after").activity,
          ] as never,
        });
        yield* appended(harness, "thread.activity-appended", approvalRequested("after"));
        yield* settle();
        assert.strictEqual((yield* recorded(record)).length, 1);

        yield* TestClock.adjust("8 days");
        yield* settle(31_000);
        assert.deepStrictEqual(yield* recorded(record), []);
        const position = yield* record.position;
        assert.strictEqual(position.prunedThroughSeq, 1);
        assert.strictEqual(position.lastSeq, 1);
      }),
    ),
  );
});
