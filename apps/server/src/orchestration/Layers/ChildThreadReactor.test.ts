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
  options: {
    readonly setupFails?: boolean;
    readonly completedTurnFor?: MessageId;
    /** "Threads can share a checkout" (default off, as the setting is). */
    readonly shareWorktrees?: boolean;
  },
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
              parentThreadId: entry.parentThreadId,
              attachedToParent: entry.attachedToParent,
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
        runGoalStart: () => Effect.die("not used"),
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
      ServerSettingsService.layerTest(
        options.shareWorktrees === true ? { agentThreadsShareWorktrees: true } : {},
      ),
    );
    // This process starts after everything the fixtures wrote.
    yield* TestClock.setTime(Date.parse(now) + 60_000);
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

  it.effect("after a restart, settles each report a child still owed, once", () =>
    withReactor(
      [
        parentWith([]),
        thread(CHILD, {
          childRequests: {
            ...EMPTY_CHILD_REQUEST_STATE,
            owedReports: [
              // Its turn completed before the crash: delivered.
              { messageId: CHILD_MESSAGE, deliveryEpoch: 0, attachmentEpoch: 0, createdAt: now },
              // A check-back the restart cut off.
              {
                turnId: TurnId.make("child-turn-2"),
                deliveryEpoch: 0,
                attachmentEpoch: 0,
                createdAt: now,
              },
            ],
          },
          messages: [
            {
              id: MessageId.make("answer"),
              role: "assistant",
              text: "Release notes checked again: nothing new.",
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
          const reports = harness.dispatched.filter(
            (command) => command.type === "thread.child-report.settle",
          );
          expect(reports).toMatchObject([
            {
              threadId: CHILD,
              owed: { messageId: CHILD_MESSAGE },
              turnId: TurnId.make("child-turn-1"),
              text: "Release notes checked again: nothing new.",
            },
            {
              threadId: CHILD,
              owed: { turnId: TurnId.make("child-turn-2") },
              text: "'Write the changelog' was interrupted by a Threadlines restart. Send it a message with thread_send to continue.",
            },
          ]);
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

  it.effect(
    "keeps an answer waiting on background work when its runtime errors and then exits without a Stop (finding 9)",
    () => {
      const childWith = (status: "error" | "stopped") =>
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
            status,
            providerName: "claudeAgent",
            runtimeMode: "auto-accept-edits",
            activeTurnId: null,
            awaitedBackgroundTaskCount: 0,
            lastError: status === "error" ? "runtime crashed" : null,
            updatedAt: now,
          },
          messages: [
            {
              id: MessageId.make("candidate"),
              role: "assistant",
              text: "Done; tests still running.",
              turnId: TurnId.make("child-turn-1"),
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
      return withReactor([parentWith([]), childWith("error")], {}, (harness) =>
        Effect.gen(function* () {
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
          // The runtime exits before the error's grace is up.
          harness.threads.set(CHILD, childWith("stopped"));
          yield* TestClock.adjust(Duration.seconds(6));
          yield* settle;
          expect(settles(harness).filter((entry) => entry.outcome === "failed")).toEqual([]);
          yield* TestClock.adjust(Duration.seconds(10));
          yield* settle;
          expect(settles(harness)).toMatchObject([{ outcome: "answered" }]);
        }),
      );
    },
  );

  describe("a child errored on a usage limit (docs/design/lead-chat.md, ruling 3)", () => {
    const erroredTurn = TurnId.make("child-turn-1");
    const asked = {
      id: CHILD_MESSAGE,
      role: "user" as const,
      text: "Write it.",
      fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" as const },
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    };
    const errored = (overrides: Partial<OrchestrationThread> = {}) =>
      thread(CHILD, {
        messages: [asked],
        latestTurn: {
          turnId: erroredTurn,
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: CHILD,
          status: "error",
          providerName: "codex",
          runtimeMode: "auto-accept-edits",
          activeTurnId: null,
          lastError: "You've hit your usage limit",
          updatedAt: now,
        },
        ...overrides,
      });
    const sessionChanged = (harness: Harness) =>
      PubSub.publish(harness.events, {
        type: "thread.session-set",
        payload: { threadId: CHILD },
      } as unknown as OrchestrationEvent);

    it.effect("waits for a late turn end that arms the wait, and then holds the request", () =>
      withReactor([parentWith([]), errored()], {}, (harness) =>
        Effect.gen(function* () {
          // The request opens after startup, so no restart pass settles it.
          harness.threads.set(PARENT, parentWith([request()]));
          yield* sessionChanged(harness);
          yield* settle;
          // Past today's 5 s: its turn hasn't ended, so nothing settles yet.
          yield* TestClock.adjust(Duration.seconds(6));
          yield* settle;
          expect(settles(harness)).toEqual([]);
          // The turn's end arrives with the reset: the wait is armed.
          harness.threads.set(
            CHILD,
            errored({
              latestTurn: {
                turnId: erroredTurn,
                state: "error",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                assistantMessageId: null,
              },
              session: {
                threadId: CHILD,
                status: "error",
                providerName: "codex",
                runtimeMode: "auto-accept-edits",
                activeTurnId: null,
                lastError: "You've hit your usage limit",
                continueAtReset: { resetsAt: now, at: now },
                updatedAt: now,
              },
            }),
          );
          yield* TestClock.adjust(Duration.seconds(15));
          yield* settle;
          expect(settles(harness)).toEqual([]);
        }),
      ),
    );

    it.effect("settles the request failed at the bound when the turn's end never comes", () =>
      withReactor([parentWith([]), errored()], {}, (harness) =>
        Effect.gen(function* () {
          // The request opens after startup, so no restart pass settles it.
          harness.threads.set(PARENT, parentWith([request()]));
          yield* sessionChanged(harness);
          yield* settle;
          yield* TestClock.adjust(Duration.seconds(19));
          yield* settle;
          expect(settles(harness)).toEqual([]);
          yield* TestClock.adjust(Duration.seconds(2));
          yield* settle;
          expect(settles(harness)).toMatchObject([{ outcome: "failed" }]);
        }),
      ),
    );

    it.effect("keeps a held request across a restart", () =>
      withReactor(
        [
          parentWith([request()]),
          errored({
            latestTurn: {
              turnId: erroredTurn,
              state: "error",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              assistantMessageId: null,
            },
            session: {
              threadId: CHILD,
              status: "error",
              providerName: "codex",
              runtimeMode: "auto-accept-edits",
              activeTurnId: null,
              lastError: "You've hit your usage limit",
              continueAtReset: { resetsAt: now, at: now },
              updatedAt: now,
            },
          }),
        ],
        {},
        (harness) =>
          Effect.gen(function* () {
            yield* settle;
            expect(settles(harness)).toEqual([]);
          }),
      ),
    );
  });

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

  it.effect(
    "checks a lent checkout again when the child is set up: the setting, then its thread",
    () => {
      const CODER = ThreadId.make("coder");
      const inCoderCheckout = request({
        status: "starting",
        launch: {
          ...request().launch!,
          title: "Review the retry",
          // The project folder: nothing on disk to look for here.
          checkout: { threadId: CODER, title: "Build the retry", worktreePath: null, branch: null },
        },
      });
      const coder = (overrides: Partial<OrchestrationThread> = {}) =>
        thread(CODER, {
          title: "Build the retry",
          parentThreadId: PARENT,
          attachedToParent: true,
          ...overrides,
        });
      const run = (
        threads: ReadonlyArray<OrchestrationThread>,
        shareWorktrees: boolean,
        check: (harness: Harness) => void,
      ) =>
        withReactor(threads, { shareWorktrees }, (harness) =>
          Effect.gen(function* () {
            yield* settle;
            check(harness);
          }),
        );
      return Effect.gen(function* () {
        // Asked while it was allowed, approved after it was turned off.
        yield* run([parentWith([inCoderCheckout]), coder()], false, (harness) => {
          expect(harness.startChildCalls).toEqual([]);
          expect(settles(harness)).toMatchObject([{ outcome: "failed" }]);
          expect(settles(harness)[0]?.reply?.text).toContain("turned off in Settings");
        });
        // Its thread took up work again while the user decided.
        const working = coder({
          session: { status: "running", activeTurnId: TurnId.make("coder-turn") } as never,
        });
        yield* run([parentWith([inCoderCheckout]), working], true, (harness) => {
          expect(harness.startChildCalls).toEqual([]);
          expect(settles(harness)[0]?.reply?.text).toContain(
            "'Build the retry' is working in that checkout now",
          );
        });
        yield* run([parentWith([inCoderCheckout]), coder()], true, (harness) => {
          expect(harness.startChildCalls).toEqual([REQUEST]);
          expect(settles(harness)).toEqual([]);
        });
      });
    },
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
