import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadSearchInput,
  type OrchestrationThreadShell,
  type PullRequestListEntry,
  type ScheduledTaskRequest,
  OutsideAgentConnectionId as ConnectionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";

import type { AssistantEvent, AssistantEventsShape } from "../assistants/AssistantEvents.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { hasActionableProposedPlan } from "../orchestration/proposedPlans.ts";
import type { PullRequestServiceShape } from "../pullRequest/PullRequestService.ts";
import type { ThreadTurnStartCommand } from "../orchestration/Services/ThreadBootstrap.ts";
import { makeConnectLimits } from "./connectLimits.ts";
import { type ConnectToolDoor, makeConnectToolHandlers } from "./connectToolHandlers.ts";
import type { OutsideAgentCaller, OutsideAgentLiveGrant } from "./OutsideAgentConnections.ts";
import type { OutsideAgentRequestRow, OutsideAgentRequestsShape } from "./OutsideAgentRequests.ts";

const AT = "2026-10-23T10:00:00.000Z";
const APP = ProjectId.make("project-app");
const PRIVATE = ProjectId.make("project-private");
const CONNECTION = ConnectionId.make("connection-1");
const CALLER: OutsideAgentCaller = { connectionId: CONNECTION, name: "Claude Code" };
const USER_THREAD = ThreadId.make("user-thread");
const HEAD = "c".repeat(40);

const PROVIDERS = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro Subscription" },
    models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false }],
  },
] as unknown as ReadonlyArray<ServerProvider>;

const project = (id: ProjectId, title: string): OrchestrationProjectShell =>
  ({
    id,
    kind: "workspace",
    title,
    workspaceRoot: `/repos/${title}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: AT,
    updatedAt: AT,
  }) as OrchestrationProjectShell;

const makeThread = (patch: Partial<OrchestrationThread>): OrchestrationThread =>
  ({
    id: USER_THREAD,
    projectId: APP,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    session: null,
    latestTurn: null,
    participants: [],
    parentThreadId: null,
    attachedToParent: false,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  }) as unknown as OrchestrationThread;

/** The thread's sidebar summary, as the projections fold it. */
const shellOf = (thread: OrchestrationThread): OrchestrationThreadShell =>
  ({
    cumulativeDiffStat: null,
    ...thread,
    diffStatBaselineTurnCount: thread.diffStatBaselineTurnCount ?? 0,
    linkedPullRequests: thread.linkedPullRequests ?? [],
    effectiveCwd: thread.effectiveCwd ?? null,
    hasPendingApprovals:
      collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS).length > 0,
    hasPendingUserInput:
      collectOpenPendingRequests(thread.activities, USER_INPUT_ACTIVITY_KINDS).length > 0,
    hasActionableProposedPlan: hasActionableProposedPlan({
      latestTurnId: thread.latestTurn?.turnId ?? null,
      proposedPlans: thread.proposedPlans,
      idOf: (plan) => plan.id,
    }),
    pendingChildApproval: false,
    awaitedChildThreadCount: 0,
    doneOverride: null,
  }) as unknown as OrchestrationThreadShell;

/** A thread the connection started, idle after its first turn. */
const ownThread = (id: string, patch: Partial<OrchestrationThread> = {}) =>
  makeThread({
    id: ThreadId.make(id),
    title: id,
    outsideOrigin: { connectionId: CONNECTION, name: "Claude Code" },
    messages: [
      {
        id: `${id}-first` as never,
        role: "user",
        text: "Go",
        fromOutside: { connectionId: CONNECTION, name: "Claude Code" },
        turnId: null,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    ...patch,
  });

const running = {
  threadId: USER_THREAD,
  status: "running",
  providerName: "codex",
  runtimeMode: "auto-accept-edits",
  activeTurnId: TurnId.make("turn-running"),
  lastError: null,
  updatedAt: AT,
} as OrchestrationThread["session"];

/** The request store, in memory, as the SQL one behaves. */
const makeRequests = () => {
  const rows = new Map<string, OutsideAgentRequestRow>();
  const key = (connectionId: string, requestId: string) => `${connectionId}\u0000${requestId}`;
  const store: OutsideAgentRequestsShape = {
    get: (input) =>
      Effect.sync(() => Option.fromNullishOr(rows.get(key(input.connectionId, input.requestId)))),
    claim: (row) =>
      Effect.sync(() => {
        if (rows.has(key(row.connectionId, row.requestId))) return false;
        rows.set(key(row.connectionId, row.requestId), {
          ...row,
          state: "starting",
          resultJson: null,
        });
        return true;
      }),
    finish: (input) =>
      Effect.sync(() => {
        const row = rows.get(key(input.connectionId, input.requestId));
        if (row !== undefined) {
          rows.set(key(input.connectionId, input.requestId), {
            ...row,
            state: "done",
            resultJson: input.resultJson,
          });
        }
      }),
    fail: (input) =>
      Effect.sync(() => {
        const row = rows.get(key(input.connectionId, input.requestId));
        if (row !== undefined) {
          rows.set(key(input.connectionId, input.requestId), {
            ...row,
            state: "failed",
            resultJson: input.resultJson,
          });
        }
      }),
    findStart: (input) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          [...rows.values()].find(
            (row) =>
              row.connectionId === input.connectionId &&
              row.threadId === input.threadId &&
              row.tool === "thread_start",
          ),
        ),
      ),
    release: (input) =>
      Effect.sync(() => {
        rows.delete(key(input.connectionId, input.requestId));
      }),
    countStartsSince: (input) =>
      Effect.sync(
        () =>
          [...rows.values()].filter(
            (row) =>
              row.connectionId === input.connectionId &&
              row.tool === "thread_start" &&
              row.createdAt >= input.since,
          ).length,
      ),
    prune: () => Effect.void,
  };
  return { store, rows };
};

/**
 * The tools over a small world: two projects, the threads in them, an engine
 * that records what it is asked, and a bootstrap that makes the thread it is
 * asked for (held at `gate`, when set).
 */
const makeWorld = (
  options: {
    readonly grant?: Partial<OutsideAgentLiveGrant>;
    readonly threads?: ReadonlyArray<OrchestrationThread>;
    /** The decider's typed refusal of every command of this type. */
    readonly refuse?: {
      readonly type: OrchestrationCommand["type"];
      readonly refusal: "thread_busy" | "above_ceiling";
    };
    /** The door the calls come through (assistants: docs/design/assistants.md). */
    readonly door?: ConnectToolDoor;
    /** The bootstrap fails before it makes the thread (a worktree that couldn't be cut). */
    readonly failSetup?: boolean;
    /** Each git command takes 20 s. */
    readonly slowGit?: boolean;
    /** Agents' scheduled-task changes waiting for the user. */
    readonly scheduleRequests?: ReadonlyArray<ScheduledTaskRequest>;
    /** The assistants' event record, for `inbox`. */
    readonly record?: Pick<AssistantEventsShape, "position" | "since">;
    /** The pull request records, for `thread_changes`. */
    readonly pullRequests?: Pick<PullRequestServiceShape, "list" | "lookup">;
  } = {},
) =>
  Effect.gen(function* () {
    let grant: OutsideAgentLiveGrant | null = {
      connectionId: CONNECTION,
      name: "Claude Code",
      access: "start",
      maxRuntimeMode: "auto-accept-edits",
      projectIds: [APP],
      ...options.grant,
    };
    const threads = new Map<string, OrchestrationThread>(
      (options.threads ?? []).map((thread) => [thread.id, thread]),
    );
    const projects = [
      {
        ...project(APP, "app"),
        repositoryIdentity: {
          canonicalKey: "github.com/acme/app",
          provider: "github",
          owner: "acme",
          name: "app",
        } as never,
      },
      project(PRIVATE, "private"),
    ];
    const dispatched: OrchestrationCommand[] = [];
    const bootstrapped: ThreadTurnStartCommand[] = [];
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    let gate: Deferred.Deferred<void> | null = null;
    /** Whether `gate` holds the bootstrap before the thread exists, or after. */
    let gateBeforeThread = false;
    const requests = makeRequests();
    const searched: OrchestrationThreadSearchInput[] = [];

    const touch = (threadId: ThreadId) =>
      PubSub.publish(events, {
        aggregateKind: "thread",
        aggregateId: threadId,
        sequence: 1,
        type: "thread.session-set",
      } as unknown as OrchestrationEvent);

    const handlers = yield* makeConnectToolHandlers(
      {
        connections: { grant: () => Effect.sync(() => grant) },
        engine: {
          dispatch: (command) =>
            Effect.gen(function* () {
              if (options.refuse !== undefined && command.type === options.refuse.type) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Refused by the decider.",
                  refusal: options.refuse.refusal,
                });
              }
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          getCommandReceipt: () => Effect.succeed(Option.none()),
        },
        bootstrap: {
          runTurnStart: (command) =>
            Effect.gen(function* () {
              bootstrapped.push(command);
              if (gate !== null && gateBeforeThread) yield* Deferred.await(gate);
              if (options.failSetup === true) {
                return yield* new OrchestrationDispatchCommandError({
                  message: "The worktree couldn't be made.",
                });
              }
              const create = command.bootstrap!.createThread!;
              threads.set(
                command.threadId,
                makeThread({
                  id: command.threadId,
                  projectId: create.projectId,
                  title: create.title,
                  runtimeMode: create.runtimeMode,
                  ...(create.outsideOrigin !== undefined
                    ? { outsideOrigin: create.outsideOrigin }
                    : {}),
                  session: { ...running!, threadId: command.threadId, status: "starting" },
                }),
              );
              if (gate !== null && !gateBeforeThread) yield* Deferred.await(gate);
              return { sequence: 1 };
            }),
        },
        projects: Effect.succeed(projects),
        // As ProjectionSnapshotQuery.listThreadShells picks them.
        listThreads: (input) =>
          Effect.sync(() =>
            [...threads.values()]
              .filter((thread) => input.includeArchived === true || thread.archivedAt == null)
              .filter(
                (thread) =>
                  input.projectIds === undefined || input.projectIds.includes(thread.projectId),
              )
              .filter(
                (thread) => input.threadIds === undefined || input.threadIds.includes(thread.id),
              )
              .filter(
                (thread) =>
                  input.outsideConnectionId === undefined ||
                  thread.outsideOrigin?.connectionId === input.outsideConnectionId,
              )
              .map(shellOf),
          ),
        threadProject: (threadId) => Effect.sync(() => threads.get(threadId)?.projectId),
        readProject: (projectId) =>
          Effect.sync(() => projects.find((entry) => entry.id === projectId)),
        readThread: (threadId) =>
          Effect.sync(() => {
            const thread = threads.get(threadId);
            return thread?.archivedAt != null ? undefined : thread;
          }),
        status: {
          subscribeEvents: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          readShell: (threadId) =>
            Effect.sync(() => {
              const thread = threads.get(threadId);
              return thread === undefined || thread.archivedAt != null
                ? undefined
                : shellOf(thread);
            }),
          scheduleAnswerWaiting: Effect.succeed(new Set()),
          scheduleAnswerChanges: Stream.empty,
        },
        providers: Effect.succeed(PROVIDERS),
        userDefaultModel: Effect.succeed(null),
        searchThreads: (input) =>
          Effect.sync(() => {
            searched.push(input);
            return [];
          }),
        git: {
          execute: (input) =>
            Effect.succeed({
              exitCode: 0 as never,
              stdout: input.args.includes("--is-inside-work-tree")
                ? "true\n"
                : input.args.includes("symbolic-ref")
                  ? "main\n"
                  : `${HEAD}\n`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }).pipe(Effect.delay(options.slowGit ? "20 seconds" : 0)),
          resolveBaseBranchName: () => Effect.succeed("main"),
        },
        requests: requests.store,
        limits: makeConnectLimits(),
        scheduleRequests: Effect.succeed(options.scheduleRequests ?? []),
        threadLink: (threadId) => Effect.succeed(`https://app.threadlines.dev/env-mac/${threadId}`),
        ...(options.record !== undefined ? { record: options.record } : {}),
        ...(options.pullRequests !== undefined ? { pullRequests: options.pullRequests } : {}),
      },
      { door: options.door ?? "local" },
    );
    return {
      handlers,
      dispatched,
      bootstrapped,
      searched,
      threads,
      requests,
      setGrant: (next: OutsideAgentLiveGrant | null) => {
        grant = next;
      },
      hold: (where: "after_thread" | "before_thread" = "after_thread") =>
        Effect.map(Deferred.make<void>(), (deferred) => {
          gate = deferred;
          gateBeforeThread = where === "before_thread";
          return deferred;
        }),
      update: (thread: OrchestrationThread) =>
        Effect.gen(function* () {
          threads.set(thread.id, thread);
          yield* touch(thread.id);
        }),
    };
  });

const start = (patch: Record<string, unknown> = {}) => ({
  project: "app",
  prompt: "Fix the flaky test in the sidebar.",
  ...patch,
});

describe("connect tools: access", () => {
  it.effect(
    "reaches the user's threads at Work, answers questions by order, never approvals or forms",
    () =>
      Effect.gen(function* () {
        const activity = (id: string, kind: string, payload: object) => ({
          id,
          kind,
          tone: kind === "approval.requested" ? "approval" : "info",
          summary: kind,
          payload,
          turnId: "turn-1",
          createdAt: AT,
        });
        const thread = makeThread({
          activities: [
            activity("question", "user-input.requested", {
              requestId: "q-1",
              questions: [
                {
                  id: "Which colour?",
                  header: "Colour",
                  question: "Which colour?",
                  options: [{ label: "Red" }, { label: "Blue" }],
                  multiSelect: false,
                },
                {
                  id: "Extras?",
                  header: "Extras",
                  question: "Extras?",
                  options: [{ label: "Fries" }, { label: "Soda" }],
                  multiSelect: true,
                },
              ],
            }),
            activity("approval", "approval.requested", {
              requestId: "a-1",
              requestType: "command_execution_approval",
            }),
            activity("form", "user-input.requested", {
              requestId: "f-1",
              questions: [],
              elicitation: { mode: "form" },
            }),
          ] as never,
        });
        const start = yield* makeWorld({ threads: [thread] });
        expect(
          (yield* start.handlers.thread_answer(CALLER, {
            threadId: USER_THREAD,
            waitingId: "q-1",
            answers: ["Red", ["Fries"]],
          })).outcome,
        ).toBe("not_allowed");
        expect(
          (yield* start.handlers.thread_send(CALLER, { threadId: USER_THREAD, message: "more" }))
            .outcome,
        ).toBe("not_yours");

        const world = yield* makeWorld({ grant: { access: "work" }, threads: [thread] });
        const answer = (
          waitingId: string,
          answers: ReadonlyArray<string | ReadonlyArray<string>>,
        ) => world.handlers.thread_answer(CALLER, { threadId: USER_THREAD, waitingId, answers });
        expect((yield* answer("a-1", ["yes"])).outcome).toBe("not_allowed");
        expect(yield* answer("f-1", ["x"])).toMatchObject({
          outcome: "invalid",
          detail: expect.stringContaining("form"),
        });
        expect((yield* answer("q-1", ["Red"])).detail).toContain("one answer per question");
        expect((yield* answer("q-1", ["Red", ["Burger"]])).detail).toContain(
          "isn't one of the options",
        );
        expect((yield* answer("q-1", [["Red", "Blue"], "Fries"])).detail).toContain("Pick one");
        expect(world.dispatched).toHaveLength(0);

        // Free text where one option is picked, labels where several may be.
        expect((yield* answer("q-1", ["Green, actually", ["Fries", "Soda"]])).outcome).toBe(
          "answered",
        );
        expect(world.dispatched).toEqual([
          expect.objectContaining({
            type: "thread.user-input.respond",
            threadId: USER_THREAD,
            requestId: "q-1",
            answers: { "Which colour?": "Green, actually", "Extras?": ["Fries", "Soda"] },
            fromOutside: expect.objectContaining({ connectionId: CONNECTION, access: "work" }),
          }),
        ]);
        // Work reaches the thread the user started: it's busy with its question, not someone else's.
        expect(
          (yield* world.handlers.thread_send(CALLER, { threadId: USER_THREAD, message: "more" }))
            .outcome,
        ).toBe("busy");
      }),
  );

  it.effect("refuses a See connection's start, send and stop, whatever its tool list showed", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        grant: { access: "see" },
        threads: [ownThread("mine")],
      });
      const outcomes = [
        (yield* world.handlers.thread_start(CALLER, start())).outcome,
        (yield* world.handlers.thread_send(CALLER, { threadId: "mine", message: "more" })).outcome,
        (yield* world.handlers.thread_stop(CALLER, { threadId: "mine" })).outcome,
      ];
      expect(outcomes).toEqual(["not_allowed", "not_allowed", "not_allowed"]);
      expect(world.bootstrapped).toHaveLength(0);
      expect(world.dispatched).toHaveLength(0);
      // A Remove applies at the next call.
      world.setGrant(null);
      expect((yield* world.handlers.projects(CALLER)).outcome).toBe("not_allowed");
    }),
  );

  it.effect("reads a thread outside the connection's projects as not found", () =>
    Effect.gen(function* () {
      const hidden = makeThread({ id: ThreadId.make("hidden"), projectId: PRIVATE });
      const world = yield* makeWorld({ threads: [hidden, makeThread({ title: "Visible" })] });
      expect((yield* world.handlers.thread_read(CALLER, { threadId: "hidden" })).outcome).toBe(
        "not_found",
      );
      expect((yield* world.handlers.thread_wait(CALLER, { threadId: "hidden" })).outcome).toBe(
        "not_found",
      );
      expect(
        (yield* world.handlers.thread_start(CALLER, start({ project: "private" }))).outcome,
      ).toBe("not_found");
      const listed = yield* world.handlers.threads_list(CALLER, {});
      expect(listed.threads.map((thread) => thread.title)).toEqual(["Visible"]);
      expect((yield* world.handlers.projects(CALLER)).projects.map((entry) => entry.name)).toEqual([
        "app",
      ]);
    }),
  );

  it.effect(
    "starts a labelled thread, capped at the connection's ceiling, the way the app does",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const result = yield* world.handlers.thread_start(CALLER, start({ access: "full-access" }));
        expect(result).toMatchObject({
          outcome: "started",
          thread: { access: "auto-accept-edits", workspace: "worktree", model: "GPT-6 Astra" },
        });
        const [command] = world.bootstrapped;
        expect(command).toMatchObject({
          runtimeMode: "auto-accept-edits",
          fromOutside: { ...CALLER, maxRuntimeMode: "auto-accept-edits" },
          bootstrap: {
            createThread: {
              projectId: APP,
              runtimeMode: "auto-accept-edits",
              outsideOrigin: CALLER,
            },
            prepareWorktree: { projectCwd: "/repos/app", baseBranch: "main" },
            runSetupScript: true,
          },
        });
      }),
  );

  it.effect("sends only to threads this connection started", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ threads: [makeThread({}), ownThread("mine")] });
      const theirs = yield* world.handlers.thread_send(CALLER, {
        threadId: USER_THREAD,
        message: "Also fix the other one.",
      });
      expect(theirs.outcome).toBe("not_yours");
      const mine = yield* world.handlers.thread_send(CALLER, { threadId: "mine", message: "More" });
      expect(mine.outcome).toBe("sent");
      expect(world.dispatched).toMatchObject([
        {
          type: "thread.turn.start",
          threadId: "mine",
          fromOutside: { ...CALLER, maxRuntimeMode: "auto-accept-edits" },
        },
      ]);
    }),
  );

  it.effect("refuses a send when the user raised the thread above the ceiling", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        threads: [ownThread("raised", { runtimeMode: "full-access" })],
      });
      const result = yield* world.handlers.thread_send(CALLER, {
        threadId: "raised",
        message: "Go",
      });
      expect(result.outcome).toBe("not_allowed");
      expect(result.detail).toContain("above what Claude Code may use");
      expect(world.dispatched).toHaveLength(0);
    }),
  );
});

describe("connect tools: busy and limits", () => {
  it.effect(
    "answers busy while a turn runs or an approval waits, and when the decider says so",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld({
          threads: [
            ownThread("working", { session: { ...running!, threadId: ThreadId.make("working") } }),
            ownThread("asking", {
              activities: [
                {
                  id: EventId.make("approval-1"),
                  tone: "approval",
                  kind: "approval.requested",
                  summary: "Run the tests",
                  payload: { requestId: "request-1" },
                  turnId: null,
                  createdAt: AT,
                },
              ],
            }),
          ],
        });
        const working = yield* world.handlers.thread_send(CALLER, {
          threadId: "working",
          message: "x",
        });
        const asking = yield* world.handlers.thread_send(CALLER, {
          threadId: "asking",
          message: "x",
        });
        expect([working.outcome, asking.outcome]).toEqual(["busy", "busy"]);
        expect(world.dispatched).toHaveLength(0);

        // The user's own send landed in between: the decider refuses, by type.
        const raced = yield* makeWorld({
          threads: [ownThread("idle")],
          refuse: { type: "thread.turn.start", refusal: "thread_busy" },
        });
        const result = yield* raced.handlers.thread_send(CALLER, {
          threadId: "idle",
          message: "x",
          requestId: "send-1",
        });
        expect(result.outcome).toBe("busy");
        // Nothing happened, so the same request id may try again.
        expect(raced.requests.rows.size).toBe(0);
      }),
  );

  it.live("holds the running cap when starts arrive together", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const gate = yield* world.hold();
      const starts = [];
      for (let index = 0; index < 6; index += 1) {
        starts.push(
          yield* world.handlers
            .thread_start(CALLER, start({ requestId: `start-${index}`, title: `Task ${index}` }))
            .pipe(Effect.forkChild),
        );
      }
      // Let every call reach the bootstrap or its refusal before releasing it.
      yield* Effect.yieldNow;
      yield* Effect.sleep("50 millis");
      yield* Deferred.succeed(gate, undefined);
      const results = yield* Effect.forEach(starts, Fiber.join);
      const outcomes = results.map((result) => result.outcome).toSorted();
      expect(outcomes).toEqual(["limit", "limit", "started", "started", "started", "started"]);
      const refused = results.find((result) => result.outcome === "limit");
      expect(refused?.detail).toContain("the most at once is 4");
    }),
  );

  it.effect("answers limit with when to try again past 120 calls a minute", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      for (let call = 0; call < 120; call += 1) {
        expect((yield* world.handlers.projects(CALLER)).outcome).toBe("ok");
      }
      const over = yield* world.handlers.agents(CALLER, {});
      expect(over.outcome).toBe("limit");
      expect(over.retryAfterSeconds).toBeGreaterThan(0);
    }),
  );
});

describe("connect tools: request ids", () => {
  it.effect("answers a retry from the first call, and refuses the id for other work", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const first = yield* world.handlers.thread_start(CALLER, start({ requestId: "same" }));
      const retry = yield* world.handlers.thread_start(CALLER, start({ requestId: "same" }));
      expect(retry).toEqual(first);
      expect(world.bootstrapped).toHaveLength(1);

      const other = yield* world.handlers.thread_start(
        CALLER,
        start({ requestId: "same", prompt: "Something else" }),
      );
      expect(other.outcome).toBe("conflict");
      expect(world.bootstrapped).toHaveLength(1);
    }),
  );

  it.effect("never runs a start a restart cut off again, and names what it left", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const first = yield* world.handlers.thread_start(CALLER, start({ requestId: "cut-off" }));
      expect(first.outcome).toBe("started");
      // A restart before it answered: the startup sweep marked its row failed.
      const key = `${CONNECTION}\u0000cut-off`;
      world.requests.rows.set(key, {
        ...world.requests.rows.get(key)!,
        state: "failed",
        resultJson: null,
      });

      const retry = yield* world.handlers.thread_start(CALLER, start({ requestId: "cut-off" }));
      expect(retry.outcome).toBe("failed");
      expect(retry.detail).toContain(first.thread!.threadId);
      expect(retry.detail).toContain("new requestId");
      expect(world.bootstrapped).toHaveLength(1);
      // Nor can it take a message: it never finished setting up.
      const made = world.threads.get(first.thread!.threadId)!;
      yield* world.update({ ...made, session: null });
      const send = yield* world.handlers.thread_send(CALLER, {
        threadId: made.id,
        message: "Go",
      });
      expect(send.outcome).toBe("failed");
    }),
  );
});

describe("connect tools: review fixes", () => {
  it.effect(
    "gives a request id reused after its row is gone new ids, never the old message's",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld({ threads: [ownThread("mine")] });
        const forgetRows = () => world.requests.rows.clear();
        yield* world.handlers.thread_send(CALLER, {
          threadId: "mine",
          message: "Go",
          requestId: "r",
        });
        forgetRows();
        yield* world.handlers.thread_send(CALLER, {
          threadId: "mine",
          message: "Go",
          requestId: "r",
        });
        const [first, second] = world.dispatched.filter(
          (command) => command.type === "thread.turn.start",
        ) as ReadonlyArray<Extract<OrchestrationCommand, { type: "thread.turn.start" }>>;
        expect(second?.message.messageId).not.toBe(first?.message.messageId);
        expect(second?.commandId).not.toBe(first?.commandId);

        const started = yield* world.handlers.thread_start(CALLER, start({ requestId: "s" }));
        forgetRows();
        const again = yield* world.handlers.thread_start(CALLER, start({ requestId: "s" }));
        expect(again.thread?.threadId).not.toBe(started.thread?.threadId);
      }),
  );

  it.live("answers conflict to other work under a request id still in flight", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ threads: [ownThread("mine")] });
      const gate = yield* world.hold();
      const first = yield* world.handlers
        .thread_start(CALLER, start({ requestId: "same" }))
        .pipe(Effect.forkChild);
      yield* Effect.sleep("20 millis");
      const otherStart = yield* world.handlers.thread_start(
        CALLER,
        start({ requestId: "same", prompt: "Something else" }),
      );
      const send = yield* world.handlers.thread_send(CALLER, {
        threadId: "mine",
        message: "More",
        requestId: "same",
      });
      expect([otherStart.outcome, send.outcome]).toEqual(["conflict", "conflict"]);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(first)).outcome).toBe("started");
      expect(world.bootstrapped).toHaveLength(1);
    }),
  );

  it.effect("won't replay a request whose thread left the connection's projects", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      expect((yield* world.handlers.thread_start(CALLER, start({ requestId: "r" }))).outcome).toBe(
        "started",
      );
      world.setGrant({
        connectionId: CONNECTION,
        name: "Claude Code",
        access: "start",
        maxRuntimeMode: "auto-accept-edits",
        projectIds: [PRIVATE],
      });
      const retry = yield* world.handlers.thread_start(CALLER, start({ requestId: "r" }));
      expect(retry.outcome).toBe("not_found");
      expect(retry.thread).toBeUndefined();
    }),
  );

  it.effect("counts a running thread toward the cap after it was archived", () =>
    Effect.gen(function* () {
      const archivedRunning = (id: string) =>
        ownThread(id, {
          archivedAt: AT,
          session: { ...running!, threadId: ThreadId.make(id) },
        });
      const world = yield* makeWorld({
        threads: ["a", "b", "c", "d"].map(archivedRunning),
      });
      expect((yield* world.handlers.thread_start(CALLER, start())).outcome).toBe("limit");
    }),
  );

  it.effect("doesn't name running threads in projects the connection no longer sees", () =>
    Effect.gen(function* () {
      const runningIn = (id: string, projectId: ProjectId) =>
        ownThread(id, {
          projectId,
          title: `secret ${id}`,
          session: { ...running!, threadId: ThreadId.make(id) },
        });
      const world = yield* makeWorld({
        threads: [runningIn("a", PRIVATE), runningIn("b", PRIVATE), runningIn("c", APP)].concat(
          runningIn("d", APP),
        ),
      });
      const refused = yield* world.handlers.thread_start(CALLER, start());
      expect(refused.outcome).toBe("limit");
      expect(refused.detail).toContain('"secret c"');
      expect(refused.detail).not.toContain("secret a");
      expect(refused.detail).toContain("2 threads in projects you can no longer see");
    }),
  );

  it.effect("searches only the projects the connection sees", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      yield* world.handlers.threads_list(CALLER, { query: "flaky" });
      expect(world.searched).toMatchObject([{ query: "flaky", projectIds: [APP] }]);
    }),
  );

  it.effect("won't stop a thread the user raised above the ceiling", () =>
    Effect.gen(function* () {
      const raised = ownThread("raised", {
        runtimeMode: "full-access",
        session: { ...running!, threadId: ThreadId.make("raised") },
      });
      const world = yield* makeWorld({ threads: [raised] });
      expect((yield* world.handlers.thread_stop(CALLER, { threadId: "raised" })).outcome).toBe(
        "not_allowed",
      );
      expect(world.dispatched).toHaveLength(0);

      // Raised between the check and the stop: the decider refuses it, by type.
      const racing = yield* makeWorld({
        threads: [
          ownThread("racing", { session: { ...running!, threadId: ThreadId.make("racing") } }),
        ],
        refuse: { type: "thread.turn.interrupt", refusal: "above_ceiling" },
      });
      expect((yield* racing.handlers.thread_stop(CALLER, { threadId: "racing" })).outcome).toBe(
        "not_allowed",
      );
    }),
  );
});

describe("thread_wait", () => {
  it.live("returns when the thread stops working, with its newest reply", () =>
    Effect.gen(function* () {
      const busy = ownThread("busy", { session: { ...running!, threadId: ThreadId.make("busy") } });
      const world = yield* makeWorld({ threads: [busy] });
      const waiting = yield* world.handlers
        .thread_wait(CALLER, { threadId: "busy", seconds: 5 })
        .pipe(Effect.forkChild);
      yield* Effect.sleep("20 millis");
      yield* world.update({
        ...busy,
        session: { ...running!, threadId: busy.id, status: "ready", activeTurnId: null },
        messages: [
          ...busy.messages,
          {
            id: "reply" as never,
            role: "assistant",
            text: "Fixed: the test waited on a timer.",
            turnId: null,
            streaming: false,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      });
      const result = yield* Fiber.join(waiting);
      expect(result).toMatchObject({
        outcome: "done",
        thread: { status: "idle" },
        reply: "Fixed: the test waited on a timer.",
      });
    }),
  );
});

describe("connect tools: the assistants door", () => {
  /** Runs `read` until `done` holds of it, letting the setup fiber run in between. */
  const until = <A>(read: Effect.Effect<A>, done: (value: A) => boolean) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const value = yield* read;
        if (done(value)) return value;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error("never happened"));
    });

  it.effect(
    "answers a start before its setup, with the thread id a retry and a read agree on",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld({ door: "assistant" });
        const gate = yield* world.hold("before_thread");
        const first = yield* world.handlers.thread_start(CALLER, start({ requestId: "start-1" }));
        expect(first).toMatchObject({ outcome: "starting", thread: { workspace: "worktree" } });
        const threadId = first.thread!.threadId;
        // The setup hasn't made the thread, and the answer is already back.
        expect(world.threads.has(threadId)).toBe(false);
        expect(world.requests.rows.get(`${CONNECTION}\u0000start-1`)).toMatchObject({
          state: "starting",
          threadId,
        });
        expect(yield* world.handlers.thread_read(CALLER, { threadId })).toMatchObject({
          outcome: "starting",
        });
        expect(
          (yield* world.handlers.threads_list(CALLER, {})).starting?.map((entry) => entry.threadId),
        ).toEqual([threadId]);
        const retried = yield* world.handlers.thread_start(CALLER, start({ requestId: "start-1" }));
        expect(retried).toMatchObject({ outcome: "starting", thread: { threadId } });
        expect(
          yield* world.handlers.thread_send(CALLER, {
            threadId,
            message: "more",
            requestId: "send-1",
          }),
        ).toMatchObject({ outcome: "busy" });

        yield* Deferred.succeed(gate, undefined);
        yield* until(
          world.handlers.thread_read(CALLER, { threadId }),
          (read) => read.outcome === "ok",
        );
        yield* until(
          Effect.sync(() => world.requests.rows.get(`${CONNECTION}\u0000start-1`)?.state),
          (state) => state === "done",
        );
        const afterSetup = yield* world.handlers.thread_start(
          CALLER,
          start({ requestId: "start-1" }),
        );
        expect(afterSetup).toMatchObject({ outcome: "started", thread: { threadId } });
        expect(world.bootstrapped).toHaveLength(1);
      }),
  );

  it.effect("records a setup that failed before its thread, for reads and waits", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ door: "assistant", failSetup: true });
      const started = yield* world.handlers.thread_start(CALLER, start({ requestId: "start-1" }));
      const threadId = started.thread!.threadId;
      const read = yield* until(
        world.handlers.thread_read(CALLER, { threadId }),
        (answer) => answer.outcome === "failed",
      );
      expect(read.detail).toContain("The worktree couldn't be made.");
      expect(yield* world.handlers.thread_wait(CALLER, { threadId })).toMatchObject({
        outcome: "failed",
      });
      expect(world.requests.rows.get(`${CONNECTION}\u0000start-1`)).toMatchObject({
        state: "failed",
      });
    }),
  );

  it.effect("refuses a start, send or stop without a requestId", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ door: "assistant", threads: [ownThread("mine")] });
      const answers = [
        yield* world.handlers.thread_start(CALLER, start()),
        yield* world.handlers.thread_send(CALLER, { threadId: "mine", message: "more" }),
        yield* world.handlers.thread_stop(CALLER, { threadId: "mine" }),
      ];
      for (const answer of answers) {
        expect(answer).toMatchObject({ outcome: "failed" });
        expect(answer.detail).toContain("requestId");
      }
      expect(world.bootstrapped).toHaveLength(0);
      expect(world.dispatched).toHaveLength(0);
    }),
  );

  it.effect("answers an assistant's start before the relay's timeout, even with slow git", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ door: "assistant", slowGit: true });
      const starting = yield* world.handlers
        .thread_start(CALLER, start({ requestId: "start-1" }))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const answer = yield* Fiber.join(starting);
      expect(answer).toMatchObject({ outcome: "failed" });
      expect(answer.detail).toContain("took too long");
      // Nothing was made or recorded: the same requestId may try again.
      expect(world.bootstrapped).toHaveLength(0);
      expect(world.requests.rows.get(`${CONNECTION}\u0000start-1`)).toBeUndefined();
    }),
  );

  it.effect("holds a wait at most 25 seconds", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        door: "assistant",
        threads: [ownThread("mine", { session: { ...running!, threadId: ThreadId.make("mine") } })],
      });
      const waiting = yield* world.handlers
        .thread_wait(CALLER, { threadId: "mine", seconds: 60 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("25 seconds");
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "still_working" });
    }),
  );
});

// ---------------------------------------------------------------------------
// inbox, thread_changes, and what a thread waits on
// ---------------------------------------------------------------------------

const approval = (requestId: string, payload: Record<string, unknown> = {}) => ({
  id: `approval-${requestId}`,
  tone: "approval",
  kind: "approval.requested",
  summary: "Command approval requested",
  payload: { requestId, requestKind: "command", ...payload },
  turnId: "turn-1",
  createdAt: AT,
});

/** The assistants' record over a list, as AssistantEvents.since reads it. */
const makeRecord = (
  events: Array<AssistantEvent>,
  options: { readonly prunedThroughSeq?: () => number; readonly running?: boolean } = {},
): Pick<AssistantEventsShape, "position" | "since"> => {
  const lastSeq = () => events.reduce((max, event) => Math.max(max, event.seq), 0);
  return {
    position: Effect.sync(() => ({
      recordId: "record-1",
      running: options.running ?? true,
      lastSeq: lastSeq(),
      prunedThroughSeq: options.prunedThroughSeq?.() ?? 0,
    })),
    since: (input) =>
      Effect.sync(() => {
        const matching = events.filter(
          (event) =>
            event.seq > input.after &&
            (input.names === undefined || input.names.includes(event.name)) &&
            (input.projectIds === undefined || input.projectIds.includes(event.projectId)),
        );
        const more = matching.length > input.limit;
        const page = matching.slice(0, input.limit);
        return { events: page, more, upTo: more ? page.at(-1)!.seq : lastSeq() };
      }),
  };
};

const recordedEvent = (seq: number, patch: Partial<AssistantEvent> = {}): AssistantEvent => ({
  eventId: `event-${seq}`,
  seq,
  name: "thread.finished",
  reason: "finished",
  threadId: USER_THREAD,
  projectId: APP,
  occurredAt: AT,
  recordedAt: AT,
  resolvedAt: null,
  resolvedReason: null,
  ...patch,
});

describe("inbox", () => {
  it.effect(
    "lists what needs the user live, and what finished or failed since the cursor, in its projects",
    () =>
      Effect.gen(function* () {
        const hidden = makeThread({
          id: ThreadId.make("hidden"),
          projectId: PRIVATE,
          activities: [approval("hidden-request")] as never,
        });
        const asking = makeThread({
          title: "Fix the build",
          activities: [approval("r1")] as never,
        });
        const events = [
          recordedEvent(1),
          recordedEvent(2, {
            name: "thread.failed",
            reason: "error",
            threadId: hidden.id,
            projectId: PRIVATE,
          }),
          recordedEvent(3, {
            name: "thread.failed",
            reason: "error",
            resolvedAt: AT,
            resolvedReason: "seen",
          }),
        ];
        const world = yield* makeWorld({
          grant: { access: "see" },
          threads: [asking, hidden],
          record: makeRecord(events),
        });

        const first = yield* world.handlers.inbox(CALLER, {});
        expect(first.needsYou).toEqual([
          {
            threadId: USER_THREAD,
            title: "Fix the build",
            projectId: APP,
            project: "app",
            kind: "approval",
            requestId: "r1",
            summary: "Wants to run a command",
            askedAt: AT,
            link: `https://app.threadlines.dev/env-mac/${USER_THREAD}`,
          },
        ]);
        expect(first.finished.map((event) => [event.threadId, event.summary])).toEqual([
          [USER_THREAD, "Finished"],
        ]);
        expect(first.failed).toMatchObject([
          { threadId: USER_THREAD, reason: "error", seenInThreadlines: true },
        ]);
        expect(first).toMatchObject({ more: false, recordKept: true });

        // Answered in Threadlines: gone from needsYou at once. Nothing new since the cursor.
        yield* world.update(
          makeThread({
            title: "Fix the build",
            activities: [
              approval("r1"),
              { ...approval("r1"), id: "resolved-r1", kind: "approval.resolved" },
            ] as never,
          }),
        );
        const again = yield* world.handlers.inbox(CALLER, { since: first.cursor! });
        expect(again).toMatchObject({ needsYou: [], finished: [], failed: [], more: false });

        // A later finish shows up after the cursor, and only that one.
        events.push(recordedEvent(4, { occurredAt: "2026-10-23T11:00:00.000Z" }));
        const later = yield* world.handlers.inbox(CALLER, { since: again.cursor! });
        expect(later.finished.map((event) => event.at)).toEqual(["2026-10-23T11:00:00.000Z"]);
      }),
  );

  it.effect("leaves out a thread that moved out of the connection's projects since its event", () =>
    Effect.gen(function* () {
      // Recorded while the thread was in "app"; it lives in a private project now.
      const moved = makeThread({ title: "Secret plans", projectId: PRIVATE });
      const world = yield* makeWorld({
        grant: { access: "see", projectIds: [APP] },
        threads: [moved],
        record: makeRecord([recordedEvent(1, { threadId: moved.id, projectId: APP })]),
      });
      const result = yield* world.handlers.inbox(CALLER, {});
      expect(result.finished).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("Secret plans");
    }),
  );

  it.effect("pages through many events, and starts over from a cursor it no longer keeps", () =>
    Effect.gen(function* () {
      const events = Array.from({ length: 57 }, (_, index) => recordedEvent(index + 1));
      let pruned = 0;
      const world = yield* makeWorld({
        threads: [makeThread({})],
        record: makeRecord(events, { prunedThroughSeq: () => pruned }),
      });
      const first = yield* world.handlers.inbox(CALLER, {});
      expect(first.finished).toHaveLength(50);
      expect(first.more).toBe(true);
      const rest = yield* world.handlers.inbox(CALLER, { since: first.cursor! });
      expect(rest.finished).toHaveLength(7);
      expect(rest.more).toBe(false);
      expect(rest.truncated).toBeUndefined();

      // Older than what is kept, or not a cursor this computer gave out: from the start.
      pruned = 52;
      const old = yield* world.handlers.inbox(CALLER, { since: first.cursor! });
      expect(old).toMatchObject({ truncated: true });
      expect(old.finished).toHaveLength(50);
      expect(yield* world.handlers.inbox(CALLER, { since: "junk" })).toMatchObject({
        truncated: true,
      });
    }),
  );

  it.effect(
    "says the record isn't kept while no assistant is connected, and still lists what needs the user",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld({
          threads: [makeThread({ activities: [approval("r1")] as never })],
          record: makeRecord([recordedEvent(1)], { running: false }),
        });
        const result = yield* world.handlers.inbox(CALLER, {});
        expect(result).toMatchObject({ recordKept: false, finished: [], failed: [] });
        expect(result.needsYou).toHaveLength(1);
      }),
  );
});

describe("thread_changes", () => {
  const checkpoint = (turnCount: number, files: ReadonlyArray<[string, number, number]>) => ({
    turnId: TurnId.make(`turn-${turnCount}`),
    checkpointTurnCount: turnCount,
    checkpointRef: `refs/threadlines/${turnCount}`,
    status: "ready",
    files: files.map(([path, additions, deletions]) => ({
      path,
      kind: "modified",
      additions,
      deletions,
    })),
    assistantMessageId: null,
    completedAt: AT,
  });

  const openPullRequest = {
    provider: "github",
    projectId: APP,
    projectTitle: "app",
    repository: "Acme/App",
    number: 42,
    title: "Fix the build",
    url: "https://github.com/acme/app/pull/42",
    author: null,
    headBranch: "fix/build",
    baseBranch: "release",
    state: "open",
    isDraft: false,
    additions: 30,
    deletions: 4,
    createdAt: AT,
    updatedAt: AT,
    viewerIsAuthor: true,
    viewerReviewRequested: false,
    reviewDecision: "approved",
    checksState: "failure",
    mergeability: "conflicting",
    labels: [],
    origin: "workspace",
  } as unknown as PullRequestListEntry;

  it.effect(
    "sums the counted turns' files, most changed first, with the pull request from its branch",
    () =>
      Effect.gen(function* () {
        const thread = makeThread({
          branch: "fix/build",
          checkpoints: [
            checkpoint(1, [["old.ts", 99, 99]]),
            checkpoint(2, [
              ["src/a.ts", 10, 2],
              ["src/b.ts", 1, 0],
            ]),
            checkpoint(3, [["src/a.ts", 5, 5]]),
          ] as never,
          // Turn 1 was committed: the sidebar counts from turn 2.
          diffStatBaselineTurnCount: 1,
          cumulativeDiffStat: { additions: 14, deletions: 6 },
        } as never);
        const asked: Array<unknown> = [];
        const world = yield* makeWorld({
          grant: { access: "see" },
          threads: [thread, makeThread({ id: ThreadId.make("hidden"), projectId: PRIVATE })],
          pullRequests: {
            list: (input) =>
              Effect.sync(() => {
                asked.push(input);
                return { viewer: "will", entries: [openPullRequest], errors: [] };
              }),
            lookup: () => Effect.succeed({ supported: true, answers: [] }),
          },
        });
        const result = yield* world.handlers.thread_changes(CALLER, { threadId: USER_THREAD });
        expect(result).toMatchObject({
          outcome: "ok",
          branch: "fix/build",
          base: "release",
          files: [
            { path: "src/a.ts", additions: 15, deletions: 7 },
            { path: "src/b.ts", additions: 1, deletions: 0 },
          ],
          totals: { files: 2, additions: 14, deletions: 6 },
          pullRequest: {
            number: 42,
            state: "open",
            checks: "failure",
            reviewDecision: "approved",
            mergeability: "conflicting",
          },
        });
        expect(asked).toEqual([{ state: "open", projectId: APP, includeAuthored: false }]);
        expect((yield* world.handlers.thread_changes(CALLER, { threadId: "hidden" })).outcome).toBe(
          "not_found",
        );
      }),
  );

  it.effect("lists at most 200 files, and answers null for a branch without a pull request", () =>
    Effect.gen(function* () {
      const files = Array.from(
        { length: 205 },
        (_, index) =>
          [`file-${String(index).padStart(3, "0")}.ts`, 1, 0] as [string, number, number],
      );
      const world = yield* makeWorld({
        threads: [
          makeThread({ branch: "feature/x", checkpoints: [checkpoint(1, files)] as never }),
        ],
        pullRequests: {
          list: () => Effect.succeed({ viewer: null, entries: [openPullRequest], errors: [] }),
          lookup: (input) =>
            Effect.succeed({
              supported: true,
              answers: input.items.map((item) => ({ item, pullRequest: null, answeredAt: AT })),
            }),
        },
      });
      const result = yield* world.handlers.thread_changes(CALLER, { threadId: USER_THREAD });
      expect(result.files).toHaveLength(200);
      expect(result.moreFiles).toBe(5);
      expect(result.totals).toEqual({ files: 205, additions: 205, deletions: 0 });
      // No pull request: the base is the repository's default branch.
      expect(result).toMatchObject({ pullRequest: null, base: "main" });
    }),
  );

  it.effect("keeps the open pull request it already listed when the lookup is slow", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        threads: [makeThread({ branch: "fix/build" })],
        pullRequests: {
          list: () => Effect.succeed({ viewer: null, entries: [openPullRequest], errors: [] }),
          lookup: () => Effect.never,
        },
      });
      const changes = yield* world.handlers
        .thread_changes(CALLER, { threadId: USER_THREAD })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("7 seconds");
      const result = yield* Fiber.join(changes);
      expect(result.pullRequest).toMatchObject({ number: openPullRequest.number });
    }),
  );
});

describe("what a thread waits on", () => {
  it.effect("details an approval, a question and a plan, in thread_read and thread_wait", () =>
    Effect.gen(function* () {
      const command = `npm run test -- ${"x".repeat(400)}`;
      const asking = makeThread({
        activities: [
          approval("r1", { toolName: "Bash", detail: command }),
          {
            id: "question-q1",
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "q1",
              questions: [
                {
                  id: "db",
                  header: "Database",
                  question: "Which database should it use?",
                  options: [
                    { label: "SQLite", description: "Local file" },
                    { label: "Postgres", description: "The shared server" },
                  ],
                },
              ],
            },
            turnId: "turn-1",
            createdAt: AT,
          },
        ] as never,
      });
      const planning = makeThread({
        id: ThreadId.make("planning"),
        latestTurn: { turnId: TurnId.make("turn-1"), state: "completed" } as never,
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Move the cache\n\n1. First",
            implementedAt: null,
            implementationThreadId: null,
            dismissedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
        ] as never,
      });
      const world = yield* makeWorld({ threads: [asking, planning] });

      const read = yield* world.handlers.thread_read(CALLER, { threadId: USER_THREAD });
      expect(read.waitingOn).toBe("approval");
      const [approvalItem, questionItem] = read.waiting ?? [];
      expect(approvalItem).toMatchObject({
        kind: "approval",
        requestId: "r1",
        asks: "command",
        tool: "Bash",
        summary: "Wants to run a command",
      });
      expect(approvalItem?.detail?.length).toBe(300);
      expect(approvalItem?.detail?.startsWith("npm run test")).toBe(true);
      expect(questionItem).toMatchObject({
        kind: "question",
        requestId: "q1",
        questions: [
          {
            header: "Database",
            question: "Which database should it use?",
            options: [
              { label: "SQLite", description: "Local file" },
              { label: "Postgres", description: "The shared server" },
            ],
            multiSelect: false,
          },
        ],
      });

      const waited = yield* world.handlers.thread_wait(CALLER, { threadId: "planning" });
      expect(waited).toMatchObject({
        waitingOn: "plan",
        waiting: [{ kind: "plan", requestId: "plan-1", title: "Move the cache" }],
      });
    }),
  );
});
