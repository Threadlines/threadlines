import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideTurnId,
  ThreadId,
  ThreadMoveId,
  ThreadMoveRequestId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ThreadPendingMoveMode,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { threadMoveGuardRefusal } from "./threadMoveDecisions.ts";

const now = "2026-10-22T10:00:00.000Z";
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};
const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const TRANSFER = ThreadMoveId.make("transfer-1");
const MAC_MINI = { environmentId: EnvironmentId.make("environment-mac-mini"), label: "Mac mini" };

let sequence = 0;
let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-${(commandCount += 1)}`);

/** Decides `command` and projects what it planned; the refusal's words when it is refused. */
async function apply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{ readonly model: OrchestrationReadModel; readonly refusal: string | null }> {
  const decided = await Effect.runPromise(
    Effect.result(decideOrchestrationCommand({ command, readModel })),
  );
  if (decided._tag === "Failure") return { model: readModel, refusal: decided.failure.message };
  const planned = Array.isArray(decided.success) ? decided.success : [decided.success];
  let model = readModel;
  for (const event of planned) {
    sequence += 1;
    model = await Effect.runPromise(
      projectEvent(model, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { model, refusal: null };
}

async function seeded(): Promise<OrchestrationReadModel> {
  let model = createEmptyReadModel(now);
  ({ model } = await apply(model, {
    type: "project.create",
    commandId: nextCommandId(),
    projectId: PROJECT,
    title: "Threadlines",
    workspaceRoot: "/repo",
    createdAt: now,
  }));
  ({ model } = await apply(model, {
    type: "thread.create",
    commandId: nextCommandId(),
    threadId: THREAD,
    projectId: PROJECT,
    title: "Fix the flaky test",
    modelSelection,
    runtimeMode: "auto",
    interactionMode: "default",
    branch: "fix/flaky",
    worktreePath: "/worktrees/fix-flaky",
    createdAt: now,
  }));
  return model;
}

const rename = (title: string): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: nextCommandId(),
  threadId: THREAD,
  title,
});

const startMove = (threadId: ThreadId = THREAD): OrchestrationCommand => ({
  type: "thread.move.start",
  commandId: nextCommandId(),
  threadId,
  transferId: TRANSFER,
  target: MAC_MINI,
  agent: modelSelection,
  createdAt: now,
});

/** Projects an event as the engine would store it. */
async function project(
  model: OrchestrationReadModel,
  type: OrchestrationEvent["type"],
  payload: Record<string, unknown>,
): Promise<OrchestrationReadModel> {
  sequence += 1;
  return Effect.runPromise(
    projectEvent(model, {
      sequence,
      eventId: EventId.make(`evt-${sequence}`),
      aggregateKind: "thread",
      aggregateId: payload.threadId,
      type,
      occurredAt: now,
      commandId: nextCommandId(),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload,
    } as OrchestrationEvent),
  );
}

/** A user message sent on the computer a thread moved to. */
const sentHere = (id: string, text: string) => ({
  threadId: ThreadId.make("thread-arrived"),
  messageId: MessageId.make(id),
  role: "user",
  text,
  turnId: null,
  streaming: false,
  createdAt: now,
  updatedAt: now,
});

const threadOf = (model: OrchestrationReadModel, threadId = THREAD) =>
  model.threads.find((thread) => thread.id === threadId)!;

describe("moving a thread to a linked computer", () => {
  it("freezes the thread while it moves, and unfreezes it only when the move is dropped", async () => {
    let { model } = await apply(await seeded(), startMove());
    expect(threadOf(model).move).toMatchObject({
      transferId: TRANSFER,
      phase: "exporting",
      target: MAC_MINI,
    });

    const frozen = await apply(model, rename("Something else"));
    expect(frozen.refusal).toContain("moving to Mac mini");
    // Filing it away still works, and the move runs on while it's archived.
    for (const type of ["thread.pin", "thread.archive"] as const) {
      expect(
        (
          await apply(model, {
            type,
            commandId: nextCommandId(),
            threadId: THREAD,
            createdAt: now,
          } as OrchestrationCommand)
        ).refusal,
      ).toBeNull();
    }

    ({ model } = await apply(model, {
      type: "thread.move.abort",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      reason: "Mac mini didn't allow the move.",
      createdAt: now,
    }));
    expect(threadOf(model).move ?? null).toBeNull();
    expect(threadOf(model).activities.at(-1)).toMatchObject({
      kind: "thread.move-failed",
      summary: "Couldn't move to Mac mini",
    });
    expect((await apply(model, rename("Something else"))).refusal).toBeNull();
  });

  it("keeps a moved thread read-only for good", async () => {
    let { model } = await apply(await seeded(), startMove());
    ({ model } = await apply(model, {
      type: "thread.move.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      movedThreadId: ThreadId.make("thread-there"),
      createdAt: now,
    }));
    expect(threadOf(model).move?.movedAway).toMatchObject({ threadId: "thread-there" });
    expect((await apply(model, rename("x"))).refusal).toContain("moved to Mac mini");
    // A late abort can't undo it, and a cancel has nothing to stop.
    expect(
      (
        await apply(model, {
          type: "thread.move.abort",
          commandId: nextCommandId(),
          threadId: THREAD,
          transferId: TRANSFER,
          reason: "late",
          createdAt: now,
        })
      ).refusal,
    ).toContain("can't be undone");
  });

  it("refuses to freeze a thread that can't move, and a frozen parent takes no child", async () => {
    let model = await seeded();
    // A child attached to its parent can't move on its own.
    ({ model } = await apply(model, {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: ThreadId.make("thread-child"),
      projectId: PROJECT,
      title: "Child",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      parentThreadId: THREAD,
      attachedToParent: true,
      createdAt: now,
    } as OrchestrationCommand));
    expect((await apply(model, startMove(ThreadId.make("thread-child")))).refusal).toContain(
      "belongs to the thread that started it",
    );
    // Nor can the parent, while it has the child.
    expect((await apply(model, startMove())).refusal).toContain("started other threads");

    let lone = await seeded();
    ({ model: lone } = await apply(lone, startMove()));
    const child = await apply(lone, {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: ThreadId.make("thread-late-child"),
      projectId: PROJECT,
      title: "Late child",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      parentThreadId: THREAD,
      attachedToParent: true,
      createdAt: now,
    } as OrchestrationCommand);
    expect(child.refusal).toContain("moving to Mac mini");
  });

  it("refuses to move a thread while a switch on any of its pull requests is on", async () => {
    // The server that watches it stays behind, so the switch would do nothing.
    const fixing = (autoFix: boolean): OrchestrationCommand => ({
      type: "thread.pull-request-automation.set",
      commandId: nextCommandId(),
      threadId: THREAD,
      pullRequestNumber: 294,
      pullRequestUrl: "https://github.com/acme/widgets/pull/294",
      autoFix,
    });
    let { model } = await apply(await seeded(), fixing(true));
    expect((await apply(model, startMove())).refusal).toContain(
      "Turn off pull request auto-fix and auto-merge",
    );
    ({ model } = await apply(model, fixing(false)));
    expect((await apply(model, startMove())).refusal).toBeNull();
  });

  it("imports a moved thread with its history once, owing its agent the conversation", async () => {
    const model = await seeded();
    const ARRIVED = ThreadId.make("thread-arrived");
    const importCommand = (): OrchestrationCommand => ({
      type: "thread.import",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      projectId: PROJECT,
      title: "Fix the flaky test",
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      branch: "fix/flaky",
      worktreePath: "/worktrees/moved-1",
      movedFrom: {
        environmentId: EnvironmentId.make("environment-windows"),
        label: "Windows PC",
        threadId: THREAD,
        movedAt: now,
      },
      messages: [
        {
          messageId: MessageId.make("moved-message-1"),
          role: "user",
          text: "Why does it flake?",
          turnId: null,
          createdAt: now,
        },
        {
          messageId: MessageId.make("moved-message-2"),
          role: "assistant",
          text: "A timer races the click.",
          turnId: TurnId.make("moved-turn-1"),
          createdAt: now,
        },
      ],
      activities: [
        {
          id: EventId.make("moved-activity-1"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran the test",
          payload: {},
          turnId: TurnId.make("moved-turn-1"),
          createdAt: now,
        },
      ],
      createdAt: now,
    });
    const { model: after, refusal } = await apply(model, importCommand());
    expect(refusal).toBeNull();
    const arrived = threadOf(after, ARRIVED);
    expect(arrived.movedFrom).toMatchObject({ label: "Windows PC", threadId: THREAD });
    expect(arrived.historySeedOwed).toBe(true);
    expect(arrived.messages.map((message) => [message.text, message.imported])).toEqual([
      ["Why does it flake?", true],
      ["A timer races the click.", true],
    ]);
    // Tool steps carry no turn of this computer's, so every revert keeps them.
    expect(arrived.activities.map((activity) => [activity.kind, activity.turnId])).toEqual([
      ["tool.completed", null],
      ["thread.moved-in", null],
    ]);
    expect((await apply(after, importCommand())).refusal).toContain("already exists");

    // Its first turn here went out without the conversation (another agent
    // in the room spoke first, or the history couldn't be read); the second
    // carried it.
    let here = await project(after, "thread.message-sent", sentHere("b-first", "Run the tests"));
    here = await project(here, "thread.message-sent", sentHere("b-second", "Now fix it"));
    ({ model: here } = await apply(here, {
      type: "thread.history-seed.delivered",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      messageId: MessageId.make("b-second"),
      createdAt: now,
    }));
    expect(threadOf(here, ARRIVED).historySeedOwed).toBe(false);

    // Undoing the turn that carried it owes it again; the history stays.
    const undone = await project(here, "thread.reverted", { threadId: ARRIVED, turnCount: 1 });
    expect(threadOf(undone, ARRIVED).historySeedOwed).toBe(true);
    expect(threadOf(undone, ARRIVED).messages.map((message) => message.text)).toEqual([
      "Why does it flake?",
      "A timer races the click.",
      "Run the tests",
    ]);
    // An undo that keeps it owes nothing.
    const kept = await project(here, "thread.reverted", { threadId: ARRIVED, turnCount: 2 });
    expect(threadOf(kept, ARRIVED).historySeedOwed).toBe(false);
  });
});

describe("a move that waits for the thread to be free", () => {
  const REQUEST = ThreadMoveRequestId.make("request-1");
  const queue = (
    mode: ThreadPendingMoveMode = "when-done",
    requestId = REQUEST,
  ): OrchestrationCommand => ({
    type: "thread.move.queue",
    commandId: nextCommandId(),
    threadId: THREAD,
    requestId,
    target: MAC_MINI,
    agent: modelSelection,
    mode,
    requestedBy: { kind: "user" },
    createdAt: now,
  });
  const startQueued = (queuedRequestId = REQUEST): OrchestrationCommand => ({
    type: "thread.move.start",
    commandId: nextCommandId(),
    threadId: THREAD,
    transferId: TRANSFER,
    target: MAC_MINI,
    agent: modelSelection,
    queuedRequestId,
    createdAt: now,
  });
  const quiesce = (requestId = REQUEST): OrchestrationCommand => ({
    type: "thread.move.quiesce",
    commandId: nextCommandId(),
    threadId: THREAD,
    requestId,
    createdAt: now,
  });
  const withSession = (
    model: OrchestrationReadModel,
    status: OrchestrationSession["status"],
    activeTurnId: TurnId | null = null,
  ) =>
    project(model, "thread.session-set", {
      threadId: THREAD,
      session: {
        threadId: THREAD,
        status,
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId,
        lastError: null,
        updatedAt: now,
      },
    });
  const decided = (model: OrchestrationReadModel, command: OrchestrationCommand) =>
    Effect.runPromise(decideOrchestrationCommand({ command, readModel: model })).then((events) =>
      (Array.isArray(events) ? events : [events]).map((event) => event.type),
    );
  const turnStart = (): OrchestrationCommand =>
    ({
      type: "thread.turn.start",
      commandId: nextCommandId(),
      threadId: THREAD,
      message: { messageId: MessageId.make("m-new"), role: "user", text: "more", attachments: [] },
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
    }) as OrchestrationCommand;

  it("queues while a turn runs, refuses new work meanwhile, and lets the running turn finish", async () => {
    const working = await withSession(await seeded(), "running", TurnId.make("turn-1"));
    const { model, refusal } = await apply(working, queue());
    expect(refusal).toBeNull();
    expect(threadOf(model).pendingMove).toMatchObject({
      requestId: REQUEST,
      stage: "waiting",
      mode: "when-done",
      waitsFor: [{ code: "turn", words: "when this turn ends" }],
    });

    expect((await apply(model, turnStart())).refusal).toContain(
      "waiting to move to Mac mini. Cancel the move to keep working here.",
    );
    const sendWhenDone = {
      type: "thread.follow-up.submit",
      commandId: nextCommandId(),
      threadId: THREAD,
      turnId: TurnId.make("turn-1"),
      message: {
        messageId: MessageId.make("m-queued"),
        role: "user",
        text: "then this",
        attachments: [],
      },
      delivery: "queue",
      createdAt: now,
    } as OrchestrationCommand;
    expect(threadMoveGuardRefusal(model, sendWhenDone)).toContain("waiting to move");
    // What the running turn needs still goes through.
    for (const command of [
      {
        type: "thread.turn.interrupt",
        commandId: nextCommandId(),
        threadId: THREAD,
        createdAt: now,
      },
      {
        type: "thread.approval.respond",
        commandId: nextCommandId(),
        threadId: THREAD,
        requestId: "approval-1",
        decision: "accept",
        createdAt: now,
      },
    ] as OrchestrationCommand[]) {
      expect(threadMoveGuardRefusal(model, command)).toBeNull();
    }
    // A second move can't queue behind it, and a direct one can't jump it.
    expect(
      (await apply(model, queue("when-done", ThreadMoveRequestId.make("request-2")))).refusal,
    ).toContain("already waiting");
    expect((await apply(model, startMove())).refusal).toContain("already waiting");
  });

  it("refuses to queue what only the user can clear, even behind a running turn", async () => {
    let model = await withSession(await seeded(), "running", TurnId.make("turn-1"));
    ({ model } = await apply(model, {
      type: "thread.pull-request-automation.set",
      commandId: nextCommandId(),
      threadId: THREAD,
      pullRequestNumber: 294,
      pullRequestUrl: "https://github.com/acme/widgets/pull/294",
      autoFix: true,
    }));
    expect((await apply(model, queue())).refusal).toContain(
      "Turn off pull request auto-fix and auto-merge",
    );
  });

  it("freezes only once its sessions are stopped, ending the queued move in the same decision", async () => {
    let model = await withSession(await seeded(), "ready");
    ({ model } = await apply(model, queue()));
    // Not quiesced yet: the fence isn't up.
    expect((await apply(model, startQueued())).refusal).toContain("hasn't stopped yet");
    expect(await decided(model, quiesce())).toEqual([
      "thread.move-quiescing",
      "thread.session-stop-requested",
    ]);
    ({ model } = await apply(model, quiesce()));
    expect(threadOf(model).pendingMove?.stage).toBe("quiescing");
    // The session still shows as ready.
    expect((await apply(model, startQueued())).refusal).toContain("hasn't stopped yet");
    // A start from an older queued move never goes ahead.
    expect(
      (await apply(model, startQueued(ThreadMoveRequestId.make("request-old")))).refusal,
    ).toContain("cancelled or replaced");

    model = await withSession(model, "stopped");
    expect(await decided(model, startQueued())).toEqual([
      "thread.move-queue-ended",
      "thread.move-started",
    ]);
    ({ model } = await apply(model, startQueued()));
    expect(threadOf(model).pendingMove ?? null).toBeNull();
    expect(threadOf(model).move).toMatchObject({ transferId: TRANSFER, queuedRequestId: REQUEST });
  });

  it("stop and move now ends every runtime of the thread at once", async () => {
    const running = await withSession(await seeded(), "running", TurnId.make("turn-1"));
    const answering = {
      ...running,
      threads: running.threads.map((thread) =>
        thread.id === THREAD
          ? ({ ...thread, sideTurn: { sideTurnId: SideTurnId.make("side-1") } } as typeof thread)
          : thread,
      ),
    };
    expect(await decided(answering, queue("stop-now"))).toEqual([
      "thread.move-queued",
      "thread.session-stop-requested",
      "thread.side-turn-interrupt-requested",
    ]);
    const { model } = await apply(answering, queue("stop-now"));
    expect(threadOf(model).pendingMove?.stage).toBe("quiescing");
  });

  it("a cancel or an end naming an older request changes nothing", async () => {
    let { model } = await apply(await seeded(), queue());
    const old = ThreadMoveRequestId.make("request-old");
    for (const command of [
      {
        type: "thread.move.unqueue",
        commandId: nextCommandId(),
        threadId: THREAD,
        requestId: old,
        createdAt: now,
      },
      {
        type: "thread.move.queue-end",
        commandId: nextCommandId(),
        threadId: THREAD,
        requestId: old,
        reason: "blocked",
        words: "This thread's agent set itself a time to come back. Cancel it first.",
        createdAt: now,
      },
    ] as OrchestrationCommand[]) {
      expect(await decided(model, command)).toEqual([]);
    }
    expect(threadOf(model).pendingMove?.requestId).toBe(REQUEST);

    ({ model } = await apply(model, {
      type: "thread.move.queue-end",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      reason: "blocked",
      words: "This thread's agent set itself a time to come back. Cancel it first.",
      createdAt: now,
    }));
    expect(threadOf(model).pendingMove ?? null).toBeNull();
    expect(threadOf(model).activities.at(-1)).toMatchObject({
      kind: "thread.move-not-started",
      summary: "Didn't move to Mac mini",
      payload: { reason: "blocked", targetLabel: "Mac mini" },
    });
    // The thread works again.
    expect((await apply(model, rename("Back to work"))).refusal).toBeNull();
    expect(threadMoveGuardRefusal(model, turnStart())).toBeNull();
  });
});
