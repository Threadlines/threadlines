import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadSearchInput,
  type OrchestrationThreadShell,
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

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { ThreadTurnStartCommand } from "../orchestration/Services/ThreadBootstrap.ts";
import { makeConnectLimits } from "./connectLimits.ts";
import { makeConnectToolHandlers } from "./connectToolHandlers.ts";
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
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  }) as unknown as OrchestrationThread;

const shellOf = (thread: OrchestrationThread): OrchestrationThreadShell =>
  ({
    ...thread,
    hasPendingApprovals: thread.activities.some(
      (activity) => activity.kind === "approval.requested",
    ),
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
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
    const projects = [project(APP, "app"), project(PRIVATE, "private")];
    const dispatched: OrchestrationCommand[] = [];
    const bootstrapped: ThreadTurnStartCommand[] = [];
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    let gate: Deferred.Deferred<void> | null = null;
    const requests = makeRequests();
    const searched: OrchestrationThreadSearchInput[] = [];

    const touch = (threadId: ThreadId) =>
      PubSub.publish(events, {
        aggregateKind: "thread",
        aggregateId: threadId,
        sequence: 1,
        type: "thread.session-set",
      } as unknown as OrchestrationEvent);

    const handlers = yield* makeConnectToolHandlers({
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
            if (gate !== null) yield* Deferred.await(gate);
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
            return thread === undefined || thread.archivedAt != null ? undefined : shellOf(thread);
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
          }),
      },
      requests: requests.store,
      limits: makeConnectLimits(),
    });
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
      hold: () =>
        Effect.map(Deferred.make<void>(), (deferred) => {
          gate = deferred;
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
