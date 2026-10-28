import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OutsideAgentConnectionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-10-25T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const projectId = ProjectId.make("project-1");
const THREAD = ThreadId.make("new-thread");
const START = CommandId.make("client-first-send");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const WORKTREE = { branch: "threadlines/1a2b3c4d", worktreePath: "/repo-worktrees/1a2b3c4d" };

const emptyModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: now,
  projects: [
    {
      id: projectId,
      kind: "workspace",
      title: "threadlines",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [],
};

type Planned = Omit<OrchestrationEvent, "sequence">;

/** Decide a command, project its events, and hand back both. */
async function run(current: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<Planned>;
  let next = current;
  let sequence = current.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { events, model: { ...next, snapshotSequence: sequence } };
}

/** The decider's refusal, in its words. */
async function refusal(current: OrchestrationReadModel, command: OrchestrationCommand) {
  const exit = await Effect.runPromiseExit(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected a refusal");
  return (Cause.squash(exit.cause) as { detail: string }).detail;
}

const firstTurn = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => ({
  type: "thread.turn.start",
  commandId: START,
  threadId: THREAD,
  message: { messageId: MessageId.make("first"), role: "user", text: "Ship it", attachments: [] },
  modelSelection: model,
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: at(5),
  ...overrides,
});

const createThread = {
  projectId,
  title: "Ship it",
  modelSelection: model,
  runtimeMode: "full-access" as const,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  ...WORKTREE,
  createdAt: at(1),
};

const setupClaim = {
  id: EventId.make("setup-claim"),
  tone: "info" as const,
  kind: "setup-script.requested",
  summary: "Starting setup script",
  payload: { worktreePath: WORKTREE.worktreePath },
  turnId: null,
  createdAt: at(4),
};

describe("decider thread.start", () => {
  it("makes the thread in its worktree, starts its first turn and claims its setup script in one decision", async () => {
    const started = await run(emptyModel, {
      type: "thread.start",
      commandId: START,
      threadId: THREAD,
      create: createThread,
      setupScriptClaim: setupClaim,
      first: firstTurn(),
    });

    const types = started.events.map((event) => event.type);
    expect(types[0]).toBe("thread.created");
    // The setup rows sit with the agent's first reply, after the user's message.
    expect(types.indexOf("thread.activity-appended")).toBeGreaterThan(
      types.indexOf("thread.turn-start-requested"),
    );
    expect(started.events.every((event) => event.commandId === START)).toBe(true);
    const thread = started.model.threads.find((entry) => entry.id === THREAD);
    expect(thread?.worktreePath).toBe(WORKTREE.worktreePath);
    expect(thread?.branch).toBe(WORKTREE.branch);
    expect(thread?.messages.map((message) => message.text)).toEqual(["Ship it"]);
    expect(thread?.activities.map((activity) => activity.kind)).toContain("setup-script.requested");
  });

  it("makes a thread whose first work is a goal in its worktree, in one decision", async () => {
    const started = await run(emptyModel, {
      type: "thread.start",
      commandId: START,
      threadId: THREAD,
      create: createThread,
      setupScriptClaim: setupClaim,
      first: {
        type: "thread.goal.set",
        commandId: START,
        threadId: THREAD,
        objective: "Get the flaky test green",
        createdAt: at(5),
      },
    });

    expect(started.events.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.goal-set-requested",
      "thread.activity-appended",
    ]);
    const thread = started.model.threads.find((entry) => entry.id === THREAD);
    expect(thread?.worktreePath).toBe(WORKTREE.worktreePath);
    expect(thread?.messages).toEqual([]);
  });

  it("refuses the whole start when any step is refused, so no thread is made", async () => {
    // An outside agent whose ceiling is below the thread's access.
    const connection = OutsideAgentConnectionId.make("connection-1");
    expect(
      await refusal(emptyModel, {
        type: "thread.start",
        commandId: START,
        threadId: THREAD,
        create: { ...createThread, outsideOrigin: { connectionId: connection, name: "Codex" } },
        first: firstTurn({
          fromOutside: {
            connectionId: connection,
            name: "Codex",
            maxRuntimeMode: "approval-required",
          },
        }),
      }),
    ).toMatch(/above what Codex may use/);
    // A start whose turn is not its own.
    expect(
      await refusal(emptyModel, {
        type: "thread.start",
        commandId: START,
        threadId: THREAD,
        create: createThread,
        first: firstTurn({ commandId: CommandId.make("someone-else") }),
      }),
    ).toMatch(/its own first work/);
    // A thread that already exists is never created again.
    const existing = await run(emptyModel, {
      ...createThread,
      type: "thread.create",
      commandId: CommandId.make("goal-flow-create"),
      threadId: THREAD,
      branch: null,
      worktreePath: null,
    });
    expect(
      await refusal(existing.model, {
        type: "thread.start",
        commandId: START,
        threadId: THREAD,
        create: createThread,
        first: firstTurn(),
      }),
    ).toMatch(/already exists/);
    // First work that asks for a worktree never runs without it, in the
    // project folder, when it reaches the decider by another way.
    const worktreeSetup = {
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
      runSetupScript: true,
    };
    expect(await refusal(existing.model, { ...firstTurn(), bootstrap: worktreeSetup })).toMatch(
      /needs the app's connection/,
    );
    expect(
      await refusal(existing.model, {
        type: "thread.goal.set",
        commandId: START,
        threadId: THREAD,
        objective: "Get the flaky test green",
        bootstrap: worktreeSetup,
        createdAt: at(5),
      }),
    ).toMatch(/needs the app's connection/);
  });

  it("gives a thread made without a message its worktree with its first turn, unless it already started", async () => {
    const existing = await run(emptyModel, {
      ...createThread,
      type: "thread.create",
      commandId: CommandId.make("goal-flow-create"),
      threadId: THREAD,
      branch: null,
      worktreePath: null,
    });
    const started = await run(existing.model, {
      type: "thread.start",
      commandId: START,
      threadId: THREAD,
      checkout: WORKTREE,
      first: firstTurn(),
    });
    const types = started.events.map((event) => event.type);
    expect(types.indexOf("thread.meta-updated")).toBeLessThan(
      types.indexOf("thread.turn-start-requested"),
    );
    expect(started.model.threads.find((entry) => entry.id === THREAD)?.worktreePath).toBe(
      WORKTREE.worktreePath,
    );

    // Another window's message got there first: the start is refused rather
    // than moving that work's thread under it.
    const sentElsewhere = await run(existing.model, {
      ...firstTurn({
        commandId: CommandId.make("other-window"),
        message: { messageId: MessageId.make("other"), role: "user", text: "hi", attachments: [] },
      }),
    });
    expect(
      await refusal(sentElsewhere.model, {
        type: "thread.start",
        commandId: START,
        threadId: THREAD,
        checkout: WORKTREE,
        first: firstTurn(),
      }),
    ).toBe("This thread already started.");
  });
});
