import { describe, expect, it } from "@effect/vitest";
import {
  type AgentThreadsMode,
  EMPTY_AGENT_REQUEST_STATE,
  EnvironmentId,
  type PeerDescriptor,
  EMPTY_CHILD_REQUEST_STATE,
  MessageId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  SideTurnId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { makeRoomRequestRegistry } from "./roomRequests.ts";
import { roomToolsFor, THREAD_TOOL_NAMES } from "./roomToolAccess.ts";
import { linkThreadId } from "../links/linkIds.ts";
import { makeThreadToolHandlers, type ThreadToolLinks } from "./threadToolHandlers.ts";

const PROJECT = ProjectId.make("project-1");
const PARENT = ThreadId.make("0f8f5a52-4d0e-4c1b-9d56-1e7c1f9b7a01");
const CHILD = ThreadId.make("5b7e9c1d-3f2a-4e6b-8d0c-1a2b3c4d5e6f");
const STRANGER = ThreadId.make("9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
const TURN = TurnId.make("turn-1");
const AT = "2026-10-04T10:00:00.000Z";
const HEAD = "c".repeat(40);

const provider = (
  instanceId: string,
  driver: string,
  patch: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro Subscription" },
    models: [{ slug: `${instanceId}-model`, name: `${instanceId} model`, isCustom: false }],
    ...patch,
  }) as unknown as ServerProvider;

const PROVIDERS = [
  provider("codex", "codex", {
    models: [
      { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
    ] as never,
  }),
  provider("claudeAgent", "claudeAgent"),
  provider("claudeApi", "claudeAgent", {
    auth: { status: "authenticated", type: "apiKey", label: "API key" },
  }),
  // A gateway-sized list: more models than thread_agents shows at once.
  provider("cursor", "cursor", {
    models: [
      { slug: "cursor-model", name: "cursor model", isCustom: false },
      ...Array.from({ length: 14 }, (_, index) => ({
        slug: `cursor-extra-${index}`,
        name: `Cursor extra ${index}`,
        isCustom: false,
      })),
    ] as never,
  }),
];

/** The calling thread: Codex, working in its own turn, no family yet. */
const makeThread = (patch: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: PARENT,
    projectId: PROJECT,
    title: "Parent",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    participants: [],
    session: {
      threadId: PARENT,
      status: "running",
      providerName: "codex",
      runtimeMode: "auto-accept-edits",
      participantId: null,
      activeTurnId: TURN,
      lastError: null,
      updatedAt: AT,
    },
    latestTurn: null,
    agentRequests: EMPTY_AGENT_REQUEST_STATE,
    childRequests: EMPTY_CHILD_REQUEST_STATE,
    parentThreadId: null,
    attachedToParent: false,
    archivedAt: null,
    messages: [],
    queuedFollowUps: [],
    effectiveCwd: null,
    worktreePath: "/checkout",
    branch: "main",
    ...patch,
  }) as unknown as OrchestrationThread;

/** One of the parent's threads, idle. */
const makeChild = (patch: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  makeThread({
    id: CHILD,
    title: "Child",
    parentThreadId: PARENT,
    attachedToParent: true,
    session: null,
    worktreePath: "/worktrees/child",
    ...patch,
  });

const shellOf = (thread: OrchestrationThread): OrchestrationThreadShell =>
  ({
    ...thread,
    createdAt: AT,
    updatedAt: AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingChildApproval: false,
    awaitedChildThreadCount: 0,
    doneOverride: null,
  }) as unknown as OrchestrationThreadShell;

const mainCaller = (): McpInvocationScope => ({
  threadId: PARENT,
  sessionKey: PARENT,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  commands: false,
  roomTools: new Set(roomToolsFor(undefined)),
});

/**
 * The thread tools over fakes: an engine that records commands and, for a
 * start, records the requests the way the decider would, a git that knows
 * one repository, and a project of threads.
 */
const makeTools = (options: {
  readonly caller?: OrchestrationThread;
  readonly others?: ReadonlyArray<OrchestrationThread>;
  readonly mode?: AgentThreadsMode;
  readonly gitRepository?: boolean;
  readonly links?: ThreadToolLinks;
}) =>
  Effect.gen(function* () {
    let caller = options.caller ?? makeThread();
    const others = new Map((options.others ?? []).map((thread) => [thread.id, thread]));
    const dispatched: OrchestrationCommand[] = [];
    const read = (threadId: ThreadId) => (threadId === caller.id ? caller : others.get(threadId));
    const handlers = makeThreadToolHandlers({
      engine: {
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (command.type === "thread.child.start") {
              const open = command.children.map((child): OrchestrationChildRequest => ({
                requestId: child.requestId,
                batchId: command.batchId,
                kind: "start",
                from: command.from,
                callerTurnId: command.callerTurnId,
                deliveryEpoch: 0,
                status: command.mode === "ask" ? "awaiting_user" : "starting",
                childThreadId: child.childThreadId,
                childMessageId: child.childMessageId,
                launch: child.launch,
                createdAt: command.createdAt,
              }));
              caller = {
                ...caller,
                childRequests: {
                  ...caller.childRequests,
                  open: [...caller.childRequests.open, ...open],
                  startsSinceUser: caller.childRequests.startsSinceUser + open.length,
                },
              };
            }
            return { sequence: dispatched.length };
          }),
      },
      readThread: (threadId) => Effect.sync(() => read(threadId)),
      readThreadShell: (threadId) =>
        Effect.sync(() => {
          const thread = read(threadId);
          return thread !== undefined ? shellOf(thread) : undefined;
        }),
      listProjectThreads: () =>
        Effect.sync(() =>
          [caller, ...others.values()]
            .filter((thread) => thread.projectId === PROJECT)
            .map(shellOf),
        ),
      readProject: () => Effect.succeed({ kind: "workspace" as const, workspaceRoot: "/project" }),
      providers: Effect.succeed(PROVIDERS),
      threadsMode: Effect.succeed(options.mode ?? "auto"),
      git: {
        execute: (input) =>
          Effect.succeed({
            exitCode: (options.gitRepository === false ? 128 : 0) as never,
            stdout: input.args.includes("--is-inside-work-tree") ? "true\n" : `${HEAD}\n`,
            stderr:
              options.gitRepository === false ? "fatal: not a git repository (or any parent)" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      },
      requests: makeRoomRequestRegistry(yield* Effect.scope),
      ...(options.links !== undefined ? { links: options.links } : {}),
    });
    return {
      handlers,
      dispatched,
      caller: () => caller,
      setCaller: (next: OrchestrationThread) => {
        caller = next;
      },
    };
  });

const ofType = <T extends OrchestrationCommand["type"]>(
  dispatched: ReadonlyArray<OrchestrationCommand>,
  type: T,
) =>
  dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: T }> => command.type === type,
  );

const oneThread = { threads: [{ title: "Check the migration", prompt: "Is it safe?" }] };

describe("thread tool access", () => {
  it("never lists the thread tools for a side runtime", () => {
    for (const kind of ["ask", "review"] as const) {
      expect(roomToolsFor(kind).some((tool) => tool.startsWith("thread_"))).toBe(false);
    }
    expect(THREAD_TOOL_NAMES.every((tool) => roomToolsFor(undefined).includes(tool))).toBe(true);
  });

  it.effect("refuses a side runtime that calls one anyway", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({});
      const side: McpInvocationScope = {
        ...mainCaller(),
        side: { sideTurnId: SideTurnId.make("11111111-2222-4333-8444-555555555555"), kind: "ask" },
      };
      const result = yield* tools.handlers.thread_start(side, oneThread);
      expect(result.outcome).toBe("not_allowed");
      expect(tools.dispatched).toHaveLength(0);
    }),
  );

  it.effect("answers `off` from every tool when the setting is off", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ mode: "off" });
      const scope = mainCaller();
      const outcomes = [
        (yield* tools.handlers.thread_agents(scope)).outcome,
        (yield* tools.handlers.thread_start(scope, oneThread)).outcome,
        (yield* tools.handlers.thread_list(scope, {})).outcome,
        (yield* tools.handlers.thread_read(scope, { threadId: CHILD })).outcome,
        (yield* tools.handlers.thread_send(scope, { threadId: CHILD, message: "more" })).outcome,
        (yield* tools.handlers.thread_stop(scope, { threadId: CHILD })).outcome,
      ];
      expect(outcomes).toEqual(["off", "off", "off", "off", "off", "off"]);
      expect(tools.dispatched).toHaveLength(0);
    }),
  );
});

describe("thread_agents", () => {
  it.effect("lists ready plan-billed providers and says why the others are out", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ caller: makeThread({ interactionMode: "plan" }) });
      const result = yield* tools.handlers.thread_agents(mainCaller());

      expect(result.agents.map((agent) => agent.instanceId)).toEqual(["codex", "claudeAgent"]);
      expect(result.unavailable.map((entry) => entry.instanceId)).toEqual(["claudeApi", "cursor"]);
      expect(result.yours).toEqual({ instanceId: "codex", model: "gpt-6-astra" });
    }),
  );

  it.effect("cuts a long model list and lists all of one provider when named", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({});
      const all = yield* tools.handlers.thread_agents(mainCaller());
      const cursor = all.agents.find((agent) => agent.instanceId === "cursor");
      expect(cursor?.models).toHaveLength(12);
      expect(cursor?.moreModels).toBe(3);
      expect(all.agents.find((agent) => agent.instanceId === "codex")?.moreModels).toBeUndefined();

      const named = yield* tools.handlers.thread_agents(mainCaller(), { instanceId: "cursor" });
      expect(named.agents.map((agent) => agent.instanceId)).toEqual(["cursor"]);
      expect(named.agents[0]?.models).toHaveLength(15);
      expect(named.agents[0]?.moreModels).toBeUndefined();
      expect(named.unavailable).toEqual([]);

      const unknown = yield* tools.handlers.thread_agents(mainCaller(), { instanceId: "grok" });
      expect(unknown.outcome).toBe("refused");
      expect(unknown.detail).toContain("without an instanceId");
    }),
  );
});

describe("thread_start", () => {
  it.effect("starts threads at once in auto mode, each in a worktree off the caller's commit", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ mode: "auto" });
      const result = yield* tools.handlers.thread_start(mainCaller(), {
        threads: [
          { title: "Check the migration", prompt: "Is it safe?" },
          {
            title: "Write the docs",
            prompt: "Document the flag.",
            agent: { instanceId: "claudeAgent", model: "claudeAgent-model" },
            runSetup: false,
          },
        ],
      });

      expect(result.outcome).toBe("started");
      expect(result.detail).toContain("end your turn");
      const [start] = ofType(tools.dispatched, "thread.child.start");
      expect(start).toMatchObject({
        threadId: PARENT,
        mode: "auto",
        callerTurnId: TURN,
        from: { participantId: null },
        commandId: `server:child-request:${start!.batchId}:start`,
      });
      expect(start!.children.map((child) => child.launch)).toEqual([
        {
          title: "Check the migration",
          prompt: "Is it safe?",
          modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          reportBack: true,
          runSetup: true,
          workspace: { kind: "worktree", projectCwd: "/project", baseRef: HEAD },
        },
        expect.objectContaining({
          modelSelection: { instanceId: "claudeAgent", model: "claudeAgent-model" },
          runSetup: false,
        }),
      ]);
      expect(result.threads?.map((thread) => thread.threadId)).toEqual(
        start!.children.map((child) => child.childThreadId),
      );
    }),
  );

  it.effect("asks the user in ask mode", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ mode: "ask" });
      const result = yield* tools.handlers.thread_start(mainCaller(), oneThread);

      expect(result.outcome).toBe("asked_user");
      expect(ofType(tools.dispatched, "thread.child.start")[0]?.mode).toBe("ask");
    }),
  );

  it.effect("answers a retried call with the first call's threads and no second command", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({});
      const five = {
        threads: Array.from({ length: 5 }, (_, index) => ({
          title: `Part ${index + 1}`,
          prompt: `Do part ${index + 1}.`,
        })),
      };
      const first = yield* tools.handlers.thread_start(mainCaller(), five);
      // The five it started used up the per-message budget; a retry is not a new ask.
      const retry = yield* tools.handlers.thread_start(mainCaller(), five);

      expect(first.outcome).toBe("started");
      expect(retry.outcome).toBe("started");
      expect(retry.threads?.map((thread) => thread.threadId)).toEqual(
        first.threads?.map((thread) => thread.threadId),
      );
      expect(ofType(tools.dispatched, "thread.child.start")).toHaveLength(1);
    }),
  );

  it.effect("refuses past the per-message limit, counting what was already asked", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({
        caller: makeThread({
          childRequests: { ...EMPTY_CHILD_REQUEST_STATE, startsSinceUser: 4 },
        }),
      });
      const result = yield* tools.handlers.thread_start(mainCaller(), {
        threads: [
          { title: "One", prompt: "First." },
          { title: "Two", prompt: "Second." },
        ],
      });

      expect(result.outcome).toBe("limit");
      expect(tools.dispatched).toHaveLength(0);
    }),
  );

  it.effect("refuses agents billed per use or unable to plan when the caller plans", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ caller: makeThread({ interactionMode: "plan" }) });
      const perUse = yield* tools.handlers.thread_start(mainCaller(), {
        threads: [
          {
            title: "One",
            prompt: "First.",
            agent: { instanceId: "claudeApi", model: "claudeApi-model" },
          },
        ],
      });
      const noPlan = yield* tools.handlers.thread_start(mainCaller(), {
        threads: [
          {
            title: "One",
            prompt: "First.",
            agent: { instanceId: "cursor", model: "cursor-model" },
          },
        ],
      });

      expect(perUse.outcome).toBe("unavailable_agent");
      expect(perUse.detail).toContain("per use");
      expect(noPlan.outcome).toBe("unavailable_agent");
      expect(noPlan.detail).toContain("plan mode");
      expect(tools.dispatched).toHaveLength(0);
    }),
  );

  it.effect("shares the project folder when the project has no git repository, and says so", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ gitRepository: false });
      const result = yield* tools.handlers.thread_start(mainCaller(), oneThread);

      expect(result.outcome).toBe("started");
      expect(result.detail).toContain("no git repository");
      expect(
        ofType(tools.dispatched, "thread.child.start")[0]?.children[0]?.launch.workspace,
      ).toEqual({ kind: "project_folder" });
    }),
  );
});

describe("depth", () => {
  it.effect("lets an attached child read and list threads but not start, message or stop any", () =>
    Effect.gen(function* () {
      const attached = makeThread({ parentThreadId: STRANGER, attachedToParent: true });
      const tools = yield* makeTools({ caller: attached, others: [makeChild()] });
      const scope = mainCaller();

      expect((yield* tools.handlers.thread_start(scope, oneThread)).outcome).toBe("not_allowed");
      expect(
        (yield* tools.handlers.thread_send(scope, { threadId: CHILD, message: "more" })).outcome,
      ).toBe("not_allowed");
      expect((yield* tools.handlers.thread_stop(scope, { threadId: CHILD })).outcome).toBe(
        "not_allowed",
      );
      expect((yield* tools.handlers.thread_list(scope, { scope: "project" })).outcome).toBe("ok");
      expect((yield* tools.handlers.thread_read(scope, { threadId: CHILD })).outcome).toBe("ok");
      expect(tools.dispatched).toHaveLength(0);
    }),
  );
});

describe("thread_send", () => {
  it.effect("refuses a thread the caller did not start", () =>
    Effect.gen(function* () {
      const stranger = makeChild({ id: STRANGER, parentThreadId: null, attachedToParent: false });
      const tools = yield* makeTools({ others: [stranger] });
      const result = yield* tools.handlers.thread_send(mainCaller(), {
        threadId: STRANGER,
        message: "Do this instead.",
      });

      expect(result.outcome).toBe("not_yours");
      expect(tools.dispatched).toHaveLength(0);
    }),
  );

  it.effect("sends to an idle child and queues behind a busy one", () =>
    Effect.gen(function* () {
      const idle = yield* makeTools({ others: [makeChild()] });
      const sent = yield* idle.handlers.thread_send(mainCaller(), {
        threadId: CHILD,
        message: "Now the tests.",
      });
      const [send] = ofType(idle.dispatched, "thread.child.send");
      expect(sent.outcome).toBe("sent");
      expect(send).toMatchObject({
        threadId: PARENT,
        childThreadId: CHILD,
        text: "Now the tests.",
        commandId: `server:child-request:${send!.requestId}:send`,
      });

      const busyChild = makeChild({
        latestTurn: {
          turnId: TurnId.make("child-turn"),
          state: "running",
          requestedAt: AT,
          startedAt: AT,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const busy = yield* makeTools({ others: [busyChild] });
      const queued = yield* busy.handlers.thread_send(mainCaller(), {
        threadId: CHILD,
        message: "Now the tests.",
      });
      expect(queued.outcome).toBe("queued");
    }),
  );
});

describe("thread_stop", () => {
  it.effect("stops a working child, and says when there is nothing to stop", () =>
    Effect.gen(function* () {
      const idle = yield* makeTools({ others: [makeChild()] });
      const notRunning = yield* idle.handlers.thread_stop(mainCaller(), { threadId: CHILD });
      expect(notRunning.outcome).toBe("not_running");
      expect(idle.dispatched).toHaveLength(0);

      const working = makeChild({
        session: {
          threadId: CHILD,
          status: "running",
          providerName: "codex",
          runtimeMode: "auto-accept-edits",
          activeTurnId: TurnId.make("child-turn"),
          lastError: null,
          updatedAt: AT,
        },
      });
      const busy = yield* makeTools({ others: [working] });
      const stopped = yield* busy.handlers.thread_stop(mainCaller(), { threadId: CHILD });
      expect(stopped.outcome).toBe("stopped");
      expect(ofType(busy.dispatched, "thread.children.stop")[0]).toMatchObject({
        threadId: PARENT,
        childThreadIds: [CHILD],
      });
    }),
  );
});

describe("a thread still being set up", () => {
  it.effect("is listed and read as setting up, takes no message, and stops by its request", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({});
      const started = yield* tools.handlers.thread_start(mainCaller(), oneThread);
      const childId = started.threads?.[0]?.threadId;
      if (childId === undefined) throw new Error("no thread started");
      // Its thread isn't made until its worktree is ready; its request is all there is.
      const listed = yield* tools.handlers.thread_list(mainCaller(), {});
      expect(listed.threads).toContainEqual(
        expect.objectContaining({
          threadId: childId,
          title: "Check the migration",
          status: "working",
        }),
      );
      const read = yield* tools.handlers.thread_read(mainCaller(), { threadId: childId });
      expect(read).toMatchObject({ outcome: "ok", messages: [] });
      expect(read.detail).toMatch(/still being set up/);
      const sent = yield* tools.handlers.thread_send(mainCaller(), {
        threadId: childId,
        message: "Also check the rollback.",
      });
      expect(sent.outcome).toBe("refused");
      expect(ofType(tools.dispatched, "thread.child.send")).toEqual([]);
      const stopped = yield* tools.handlers.thread_stop(mainCaller(), { threadId: childId });
      expect(stopped.outcome).toBe("stopped");
      expect(ofType(tools.dispatched, "thread.children.stop")[0]).toMatchObject({
        threadId: PARENT,
        childThreadIds: [childId],
      });
    }),
  );
});

describe("thread_read", () => {
  it.effect("never labels another thread's request or report as the user's", () =>
    Effect.gen(function* () {
      const message = (patch: Partial<OrchestrationMessage>): OrchestrationMessage => ({
        id: MessageId.make(`message-${patch.eventSequence}`),
        role: "user",
        text: "text",
        turnId: null,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
        ...patch,
      });
      const child = makeChild({
        messages: [
          message({
            eventSequence: 1,
            text: "Check the migration.",
            fromThread: {
              threadId: PARENT,
              requestId: "request-1" as never,
              kind: "request",
            },
          }),
          message({ eventSequence: 2, text: "Also look at the index." }),
          message({ eventSequence: 3, role: "assistant", text: "It is safe." }),
        ],
      });
      const tools = yield* makeTools({ others: [child] });
      const result = yield* tools.handlers.thread_read(mainCaller(), { threadId: CHILD });

      expect(result.messages.map((entry) => [entry.origin, entry.author])).toEqual([
        ["thread_request", `Request from thread "Parent" (${PARENT})`],
        ["user", "User"],
        ["agent", "GPT-6 Astra"],
      ]);
      expect(result.thread).toMatchObject({ threadId: CHILD, startedBy: "you", attached: true });
      expect(result.next).toBe(3);

      const later = yield* tools.handlers.thread_read(mainCaller(), {
        threadId: CHILD,
        after: 2,
      });
      expect(later.messages.map((entry) => entry.sequence)).toEqual([3]);
    }),
  );

  it.effect("names an outside agent's thread and messages by the agent, never the user", () =>
    Effect.gen(function* () {
      const agent = { connectionId: "connection-1" as never, name: "Claude Code" };
      const outside = makeThread({
        id: STRANGER,
        title: "Started from outside",
        session: null,
        outsideOrigin: agent,
        messages: [
          {
            id: MessageId.make("outside-1"),
            eventSequence: 1,
            role: "user",
            text: "Fix the flaky test.",
            fromOutside: agent,
            turnId: null,
            streaming: false,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      });
      const tools = yield* makeTools({ others: [outside] });
      const result = yield* tools.handlers.thread_read(mainCaller(), { threadId: STRANGER });

      // `user` with the agent's name: linked computers on older versions know no other word.
      expect(result.messages.map((entry) => [entry.origin, entry.author])).toEqual([
        ["user", "Claude Code (outside agent)"],
      ]);
      expect(result.thread).toMatchObject({ startedBy: "Claude Code (outside agent)" });
    }),
  );

  it.effect("refuses a thread in another project", () =>
    Effect.gen(function* () {
      const elsewhere = makeChild({ projectId: ProjectId.make("project-2") });
      const tools = yield* makeTools({ others: [elsewhere] });
      const result = yield* tools.handlers.thread_read(mainCaller(), { threadId: CHILD });

      expect(result.outcome).toBe("refused");
      expect(result.messages).toEqual([]);
    }),
  );
});

describe("thread_list", () => {
  it.effect("lists the caller's threads, attached and separated, with plain status words", () =>
    Effect.gen(function* () {
      const separated = makeChild({
        id: STRANGER,
        title: "Separated",
        attachedToParent: false,
        latestTurn: {
          turnId: TurnId.make("separated-turn"),
          state: "error",
          requestedAt: AT,
          startedAt: AT,
          completedAt: AT,
          assistantMessageId: null,
        },
      });
      const tools = yield* makeTools({ others: [makeChild(), separated] });
      const result = yield* tools.handlers.thread_list(mainCaller(), {});

      expect(
        result.threads.map((thread) => [thread.title, thread.attached, thread.status]),
      ).toEqual([
        ["Child", true, "idle"],
        ["Separated", false, "failed"],
      ]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Linked computers (docs/design/fleet.md, Part 2)
// ---------------------------------------------------------------------------

const MAC_MINI = EnvironmentId.make("env-mac-mini");
const MAC_DESCRIPTOR: PeerDescriptor = {
  environmentId: MAC_MINI,
  label: "Mac mini",
  platform: "macOS",
  serverVersion: "0.0.0",
  directRoutes: [],
  access: "allowed",
  maxRuntimeMode: "auto",
  agents: [
    {
      instanceId: "mac-claude",
      name: "Claude",
      billing: "Claude Max",
      models: [{ model: "opus-5-5", name: "Opus 5.5" }],
      driver: "claudeAgent",
    },
    {
      instanceId: "mac-codex",
      name: "Codex",
      billing: "ChatGPT Pro",
      models: [{ model: "gpt-6-astra", name: "GPT-6 Astra" }],
      driver: "codex",
    },
  ],
  defaultAgent: { instanceId: "mac-claude", model: "opus-5-5" },
  projects: [{ name: "threadlines", canonicalKey: "github.com/threadlines/threadlines" }],
};

const fakeLinks = (patch: Partial<ThreadToolLinks> = {}): ThreadToolLinks => ({
  computers: Effect.succeed([
    {
      environmentId: MAC_MINI,
      label: "Mac mini",
      deviceId: "device-1",
      reachable: true,
      descriptor: MAC_DESCRIPTOR,
    },
  ]),
  describe: () => Effect.succeed(MAC_DESCRIPTOR),
  read: () => Effect.succeed({ unavailable: "it is offline" }),
  projectPlace: () =>
    Effect.succeed({
      canonicalKey: "github.com/threadlines/threadlines",
      subdirectory: "",
      rootPath: "/repo",
    }),
  ...patch,
});

describe("thread tools across linked computers", () => {
  it.effect("starts a thread on a linked computer with that computer's own agent", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ links: fakeLinks() });
      const result = yield* tools.handlers.thread_start(mainCaller(), {
        ...oneThread,
        computer: "mac mini",
      });
      expect(result.outcome).toBe("started");
      expect(result.threads?.[0]).toMatchObject({ workspace: "remote", computer: "Mac mini" });
      // Its branch isn't pushed: the agent hears its changes aren't there.
      expect(result.detail).toContain("unpushed");
      const [start] = ofType(tools.dispatched, "thread.child.start");
      const child = start?.children[0];
      // The caller's own instance id means nothing there: the same kind of
      // agent there is picked.
      expect(child?.launch.modelSelection).toMatchObject({
        instanceId: "mac-codex",
        model: "gpt-6-astra",
      });
      expect(child?.launch.target).toEqual({ environmentId: MAC_MINI, label: "Mac mini" });
      expect(child?.launch.workspace).toEqual({
        kind: "remote",
        projectKey: "github.com/threadlines/threadlines",
        projectSubdirectory: "",
        checkout: "worktree",
      });
      // The child's id is the one that computer makes for this link and request.
      expect(child?.childThreadId).toBe(linkThreadId("device-1", child!.requestId));
    }),
  );

  it.effect("refuses an unknown computer or one without the project, saying which there are", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ links: fakeLinks() });
      const unknown = yield* tools.handlers.thread_start(mainCaller(), {
        ...oneThread,
        computer: "Laptop",
      });
      expect(unknown.outcome).toBe("refused");
      expect(unknown.detail).toContain("Mac mini");

      const missing = yield* makeTools({
        links: fakeLinks({ describe: () => Effect.succeed({ ...MAC_DESCRIPTOR, projects: [] }) }),
      });
      const noProject = yield* missing.handlers.thread_start(mainCaller(), {
        ...oneThread,
        computer: "Mac mini",
      });
      expect(noProject).toMatchObject({
        outcome: "refused",
        detail:
          "Mac mini doesn't have this project. The user can set it up there from the project's menu.",
      });
      expect(ofType(missing.dispatched, "thread.child.start")).toEqual([]);
    }),
  );

  it.effect("lists linked computers and their agents", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({ links: fakeLinks() });
      const result = yield* tools.handlers.thread_agents(mainCaller(), {});
      expect(result.computers).toEqual([
        {
          name: "Mac mini",
          environmentId: MAC_MINI,
          reachable: true,
          agents: MAC_DESCRIPTOR.agents.map(({ driver: _driver, ...agent }) => agent),
        },
      ]);
    }),
  );

  it.effect("lists a child on a linked computer, and says plainly when it can't be read", () =>
    Effect.gen(function* () {
      const remoteChildId = ThreadId.make("remote-child");
      const tools = yield* makeTools({
        links: fakeLinks(),
        caller: makeThread({
          childRequests: {
            ...EMPTY_CHILD_REQUEST_STATE,
            remoteChildren: [
              {
                environmentId: MAC_MINI,
                label: "Mac mini",
                threadId: remoteChildId,
                handle: "Codex",
                title: "Write the changelog",
                attachmentEpoch: 0,
                cachedStatus: "working",
                updatedAt: AT,
              },
            ],
          },
        }),
      });
      const listed = yield* tools.handlers.thread_list(mainCaller(), {});
      expect(listed.threads).toContainEqual(
        expect.objectContaining({
          threadId: remoteChildId,
          status: "working",
          computer: "Mac mini",
          startedBy: "you",
        }),
      );
      const read = yield* tools.handlers.thread_read(mainCaller(), { threadId: remoteChildId });
      expect(read.outcome).toBe("refused");
      expect(read.detail).toContain("Mac mini can't be reached right now");
      // Stopping it names the computer that is told.
      const stopped = yield* tools.handlers.thread_stop(mainCaller(), { threadId: remoteChildId });
      expect(stopped.outcome).toBe("stopped");
      expect(stopped.detail).toContain("Stopped. Mac mini is told to stop it");
    }),
  );

  it.effect("gives a thread a linked computer started no thread tools", () =>
    Effect.gen(function* () {
      const tools = yield* makeTools({
        links: fakeLinks(),
        caller: makeThread({
          remoteOrigin: {
            linkDeviceId: "device-windows",
            environmentId: EnvironmentId.make("env-windows"),
            environmentLabel: "Windows PC",
            threadId: ThreadId.make("windows-parent"),
            threadTitle: "Ship the release",
          },
        }),
      });
      const listed = yield* tools.handlers.thread_list(mainCaller(), { scope: "project" });
      const started = yield* tools.handlers.thread_start(mainCaller(), oneThread);
      expect(listed.outcome).toBe("not_allowed");
      expect(listed.threads).toEqual([]);
      expect(started.outcome).toBe("not_allowed");
      expect(tools.dispatched).toEqual([]);
    }),
  );
});
