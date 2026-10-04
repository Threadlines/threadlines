import { describe, expect, it } from "@effect/vitest";
import {
  ChildRequestBatchId,
  ChildRequestId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  MessageId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ChildBootstrapError, ThreadBootstrap } from "../Services/ThreadBootstrap.ts";
import { makeChildThreadReactor } from "./ChildThreadReactor.ts";

const now = "2026-10-04T10:00:00.000Z";
const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");
const REQUEST = ChildRequestId.make("request-1");
const CHILD_MESSAGE = MessageId.make("child-message-1");
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-5-5" };

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId: ProjectId.make("project-1"),
    title: id === PARENT ? "Ship the release" : "Write the changelog",
    modelSelection: model,
    runtimeMode: "auto-accept-edits",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    pullRequestAutoFix: false,
    pullRequestAutoMerge: null,
    linkedPullRequests: [],
    agentRequests: EMPTY_AGENT_REQUEST_STATE,
    parentThreadId: id === CHILD ? PARENT : null,
    parentTurnId: null,
    attachedToParent: id === CHILD,
    parentAttachmentEpoch: 0,
    handedBackAt: null,
    handedBackTurnId: null,
    archivedWithParentAt: null,
    childRequests: EMPTY_CHILD_REQUEST_STATE,
    participants: [],
    doneOverride: null,
    lastSeenAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    diffStatBaselineTurnCount: 0,
    session: null,
    ...overrides,
  };
}

const request = (
  overrides: Partial<OrchestrationChildRequest> = {},
): OrchestrationChildRequest => ({
  requestId: REQUEST,
  batchId: ChildRequestBatchId.make("batch-1"),
  kind: "start",
  from: { participantId: null },
  callerTurnId: TurnId.make("parent-turn"),
  deliveryEpoch: 0,
  status: "running",
  childThreadId: CHILD,
  childMessageId: CHILD_MESSAGE,
  launch: {
    title: "Write the changelog",
    prompt: "Write it.",
    modelSelection: model,
    runtimeMode: "auto-accept-edits",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    reportBack: true,
    runSetup: false,
    workspace: { kind: "project_folder" },
  },
  createdAt: now,
  ...overrides,
});

const parentWith = (open: ReadonlyArray<OrchestrationChildRequest>) =>
  thread(PARENT, { childRequests: { ...EMPTY_CHILD_REQUEST_STATE, open } });

interface Harness {
  readonly threads: Map<ThreadId, OrchestrationThread>;
  readonly dispatched: OrchestrationCommand[];
  readonly startChildCalls: ChildRequestId[];
  readonly startChildRuntimeModes: string[];
  readonly events: PubSub.PubSub<OrchestrationEvent>;
}

/** The reactor over fakes: threads in a map, dispatches recorded, setup scripted. */
function withReactor<A, E>(
  threads: ReadonlyArray<OrchestrationThread>,
  options: { readonly setupFails?: boolean; readonly completedTurnFor?: MessageId },
  body: (harness: Harness) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const harness: Harness = {
      threads: new Map(threads.map((entry) => [entry.id, entry])),
      dispatched: [],
      startChildCalls: [],
      startChildRuntimeModes: [],
      events: yield* PubSub.unbounded<OrchestrationEvent>(),
    };
    const layers = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            return { sequence: harness.dispatched.length };
          }),
        subscribeDomainEvents: Effect.map(PubSub.subscribe(harness.events), (subscription) =>
          Stream.fromSubscription(subscription),
        ),
      } as unknown as OrchestrationEngineShape),
      Layer.succeed(ProjectionSnapshotQuery, {
        getThreadDetailById: (id: ThreadId) =>
          Effect.succeed(Option.fromNullishOr(harness.threads.get(id))),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [...harness.threads.values()].map((entry) => ({
              id: entry.id,
              queuedFollowUps: entry.queuedFollowUps ?? [],
              session: entry.session,
              awaitedChildThreadCount: entry.childRequests.open.filter(
                (open) => open.status !== "awaiting_user",
              ).length,
              pendingChildApproval: entry.childRequests.open.some(
                (open) => open.status === "awaiting_user",
              ),
            })),
            updatedAt: now,
          }),
      } as unknown as ProjectionSnapshotQueryShape),
      Layer.succeed(ThreadBootstrap, {
        runTurnStart: () => Effect.die("not used"),
        startChild: (input) =>
          Effect.suspend(() => {
            harness.startChildCalls.push(input.requestId);
            harness.startChildRuntimeModes.push(input.launch.runtimeMode);
            return options.setupFails === true
              ? Effect.fail(
                  new ChildBootstrapError({
                    stage: "worktree",
                    detail: "Couldn't set up its worktree: disk full",
                  }),
                )
              : Effect.succeed({ sequence: 1 });
          }),
      }),
      Layer.succeed(ProjectionTurnRepository, {
        listByThreadId: () =>
          Effect.succeed(
            options.completedTurnFor === undefined
              ? []
              : [
                  {
                    threadId: CHILD,
                    turnId: TurnId.make("child-turn-1"),
                    pendingMessageId: options.completedTurnFor,
                    state: "completed",
                  },
                ],
          ),
      } as unknown as ProjectionTurnRepositoryShape),
      ServerSettingsService.layerTest(),
    );
    return yield* Effect.gen(function* () {
      const reactor = yield* makeChildThreadReactor;
      yield* reactor.start();
      return yield* body(harness);
    }).pipe(Effect.provide(layers), Effect.scoped);
  });
}

const settles = (harness: Harness) =>
  harness.dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.child-request.settle" }> =>
      command.type === "thread.child-request.settle",
  );

/** Let forked work run. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

describe("ChildThreadReactor", () => {
  it.effect(
    "after a restart, reports an answer that was cut off and takes back its queued message",
    () =>
      withReactor(
        [
          parentWith([request({ status: "queued" })]),
          thread(CHILD, {
            queuedFollowUps: [
              {
                messageId: CHILD_MESSAGE,
                text: "Write it.",
                attachments: [],
                fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
                runtimeMode: "auto-accept-edits",
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                createdAt: now,
              },
            ],
          }),
        ],
        {},
        (harness) =>
          Effect.sync(() => {
            expect(settles(harness)).toMatchObject([{ requestId: REQUEST, outcome: "failed" }]);
            expect(settles(harness)[0]?.reply?.text).toContain(
              "interrupted by a Threadlines restart",
            );
            expect(harness.dispatched.map((command) => command.type)).toContain(
              "thread.follow-up.unqueue",
            );
          }),
      ),
  );

  it.effect("after a restart, delivers an answer whose turn finished before the crash", () =>
    withReactor(
      [
        parentWith([request({ status: "running" })]),
        thread(CHILD, {
          messages: [
            {
              id: MessageId.make("answer"),
              role: "assistant",
              text: "Changelog written.",
              turnId: TurnId.make("child-turn-1"),
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      ],
      { completedTurnFor: CHILD_MESSAGE },
      (harness) =>
        Effect.sync(() => {
          expect(settles(harness)).toMatchObject([{ outcome: "answered" }]);
          expect(settles(harness)[0]?.reply?.text).toBe("Changelog written.");
        }),
    ),
  );

  it.effect("resumes a setup the previous process left unfinished", () =>
    withReactor([parentWith([request({ status: "starting" })])], {}, (harness) =>
      Effect.gen(function* () {
        yield* settle;
        expect(harness.startChildCalls).toEqual([REQUEST]);
      }),
    ),
  );

  it.effect("tells the agent that asked when a child could not be set up", () =>
    withReactor(
      [parentWith([request({ status: "awaiting_user" })])],
      { setupFails: true },
      (harness) =>
        Effect.gen(function* () {
          harness.threads.set(PARENT, parentWith([request({ status: "starting" })]));
          yield* PubSub.publish(harness.events, {
            type: "thread.child-request-updated",
            payload: { threadId: PARENT, requestId: REQUEST, status: "starting", updatedAt: now },
          } as unknown as OrchestrationEvent);
          yield* settle;
          expect(settles(harness)).toMatchObject([{ outcome: "failed" }]);
          expect(settles(harness)[0]?.reply?.text).toContain("disk full");
        }),
    ),
  );

  it.effect("lets a quiet child's answer so far stand only after the grace period", () =>
    withReactor(
      [
        parentWith([]),
        thread(CHILD, {
          latestTurn: {
            turnId: TurnId.make("child-turn-1"),
            state: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          },
          session: {
            threadId: CHILD,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "auto-accept-edits",
            activeTurnId: null,
            awaitedBackgroundTaskCount: 0,
            lastError: null,
            updatedAt: now,
          },
          messages: [
            {
              id: MessageId.make("candidate"),
              role: "assistant",
              text: "Done; both helpers reported back.",
              turnId: TurnId.make("child-turn-1"),
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      ],
      {},
      (harness) =>
        Effect.gen(function* () {
          // The answer started waiting on background work after startup.
          harness.threads.set(
            PARENT,
            parentWith([
              request({
                status: "awaiting_background",
                candidateTurnId: TurnId.make("child-turn-1"),
              }),
            ]),
          );
          yield* PubSub.publish(harness.events, {
            type: "thread.session-set",
            payload: { threadId: CHILD },
          } as unknown as OrchestrationEvent);
          yield* settle;
          expect(settles(harness)).toEqual([]);
          yield* TestClock.adjust(Duration.seconds(16));
          yield* settle;
          expect(settles(harness)).toMatchObject([{ outcome: "answered" }]);
          expect(settles(harness)[0]?.reply?.text).toBe("Done; both helpers reported back.");
        }),
    ),
  );

  it.effect("starts a child with no more access than its parent has now", () =>
    withReactor(
      [
        thread(PARENT, {
          runtimeMode: "approval-required",
          childRequests: {
            ...EMPTY_CHILD_REQUEST_STATE,
            open: [
              request({
                status: "starting",
                launch: { ...request().launch!, runtimeMode: "full-access" },
              }),
            ],
          },
        }),
      ],
      {},
      (harness) =>
        Effect.gen(function* () {
          yield* settle;
          expect(harness.startChildRuntimeModes).toEqual(["approval-required"]);
        }),
    ),
  );

  it.effect("after a restart, sends a report that was queued but never sent", () =>
    withReactor(
      [
        thread(PARENT, {
          session: {
            threadId: PARENT,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "auto-accept-edits",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          queuedFollowUps: [
            {
              messageId: MessageId.make("child-report:request-1"),
              text: "Changelog written.",
              attachments: [],
              fromThread: { threadId: CHILD, requestId: REQUEST, kind: "report" },
              runtimeMode: "auto-accept-edits",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: now,
            },
          ],
        }),
      ],
      {},
      (harness) =>
        Effect.sync(() => {
          expect(
            harness.dispatched
              .filter((command) => command.type === "thread.follow-up.send-queued")
              .map((command) => (command as { messageId: string }).messageId),
          ).toEqual(["child-report:request-1"]);
        }),
    ),
  );
});
