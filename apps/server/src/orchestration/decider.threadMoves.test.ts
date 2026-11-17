import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideTurnId,
  ThreadId,
  ThreadMoveBatchId,
  ThreadMoveId,
  ThreadMoveRequestId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationQueuedFollowUp,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadGoal,
  type ThreadGoalStatus,
  type ThreadMoveTakes,
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
        // Never reached the agent there: it stays unsent here.
        {
          messageId: MessageId.make("moved-message-3"),
          role: "user",
          text: "Run the migration.",
          turnId: null,
          notSent: true,
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
    expect(
      arrived.messages.map((message) => [message.text, message.imported, message.notSent ?? false]),
    ).toEqual([
      ["Why does it flake?", true, false],
      ["A timer races the click.", true, false],
      ["Run the migration.", true, true],
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
      "Run the migration.",
      "Run the tests",
    ]);
    // An undo that keeps it owes nothing.
    const kept = await project(here, "thread.reverted", { threadId: ARRIVED, turnCount: 2 });
    expect(threadOf(kept, ARRIVED).historySeedOwed).toBe(false);
  });

  it("a carried session owes the conversation until a turn succeeds on it, and falls back once", async () => {
    const model = await seeded();
    const ARRIVED = ThreadId.make("thread-carried");
    const imported = (
      await apply(model, {
        type: "thread.import",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        projectId: PROJECT,
        title: "Fix the flaky test",
        modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        branch: "fix/flaky",
        worktreePath: "/worktrees/moved-2",
        movedFrom: {
          environmentId: EnvironmentId.make("environment-windows"),
          label: "Windows PC",
          threadId: THREAD,
          movedAt: now,
        },
        messages: [],
        activities: [],
        nativeSession: "carried",
        createdAt: now,
      })
    ).model;
    const carried = threadOf(imported, ARRIVED);
    expect(carried.nativeSession).toBe("carried");
    expect(carried.historySeedOwed).toBe(true);
    // The moved-in line says the agent kept its memory.
    expect(carried.activities.at(-1)?.payload).toMatchObject({ nativeSession: "carried" });

    const resumed = (
      await apply(imported, {
        type: "thread.history-seed.delivered",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        messageId: MessageId.make("first-here"),
        nativeSession: "resumed",
        createdAt: now,
      })
    ).model;
    expect(threadOf(resumed, ARRIVED)).toMatchObject({
      nativeSession: "resumed",
      historySeedOwed: false,
    });

    const fallBack = (): OrchestrationCommand => ({
      type: "thread.native-session.fall-back",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      reason: "turn_failed",
      resendMessageId: MessageId.make("first-here"),
      createdAt: now,
    });
    // Once it resumed, nothing falls back.
    const afterResumed = (await apply(resumed, fallBack())).model;
    expect(threadOf(afterResumed, ARRIVED).nativeSession).toBe("resumed");

    // A carried session that fails falls back once, still owing the summary.
    const fellBack = (await apply(imported, fallBack())).model;
    const thread = threadOf(fellBack, ARRIVED);
    expect(thread.nativeSession).toBe("fell_back");
    expect(thread.historySeedOwed).toBe(true);
    expect(thread.activities.at(-1)).toMatchObject({
      kind: "thread.native-session-fell-back",
      summary: "Couldn't resume the agent's session here, so it got a summary instead.",
      payload: { reason: "turn_failed", resendMessageId: "first-here" },
    });
    const again = (await apply(fellBack, fallBack())).model;
    expect(threadOf(again, ARRIVED).activities).toHaveLength(thread.activities.length);
    // A success reported late for the dropped session pays nothing.
    const late = (
      await apply(fellBack, {
        type: "thread.history-seed.delivered",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        messageId: MessageId.make("first-here"),
        nativeSession: "resumed",
        createdAt: now,
      })
    ).model;
    expect(threadOf(late, ARRIVED)).toMatchObject({
      nativeSession: "fell_back",
      historySeedOwed: true,
    });
  });
});

describe("a move that waits for the thread to be free", () => {
  const REQUEST = ThreadMoveRequestId.make("request-1");
  const BATCH = ThreadMoveBatchId.make("batch-1");
  const queue = (
    mode: ThreadPendingMoveMode = "when-done",
    requestId = REQUEST,
    batchId?: ThreadMoveBatchId,
  ): OrchestrationCommand => ({
    type: "thread.move.queue",
    commandId: nextCommandId(),
    threadId: THREAD,
    requestId,
    target: MAC_MINI,
    agent: modelSelection,
    mode,
    requestedBy: { kind: "user" },
    ...(batchId !== undefined ? { batchId } : {}),
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

  it("stop and move now is refused while a command runs in the user's terminal", async () => {
    const running = await seeded();
    const withRun = {
      ...running,
      threads: running.threads.map((thread) =>
        thread.id === THREAD
          ? ({
              ...thread,
              commandRuns: [{ runId: "run-1", status: "running", source: { kind: "user" } }],
            } as unknown as typeof thread)
          : thread,
      ),
    };
    expect((await apply(withRun, queue("stop-now"))).refusal).toContain(
      "A command from this thread is running in your terminal. Stop it there, or move the thread when it's done.",
    );
    // Move when it's done waits for it.
    const { model, refusal } = await apply(withRun, queue("when-done"));
    expect(refusal).toBeNull();
    expect(threadOf(model).pendingMove?.waitsFor?.map((wait) => wait.code)).toEqual([
      "command_run",
    ]);
  });

  it("stop the agents and move now switches only its own waiting request", async () => {
    const running = await withSession(await seeded(), "running", TurnId.make("turn-1"));
    let { model } = await apply(running, queue("when-done", REQUEST, BATCH));
    const setMode = (requestId = REQUEST): OrchestrationCommand => ({
      type: "thread.move.set-mode",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId,
      mode: "stop-now",
      createdAt: now,
    });
    expect(await decided(model, setMode(ThreadMoveRequestId.make("request-old")))).toEqual([]);
    expect(threadOf(model).pendingMove).toMatchObject({ mode: "when-done", stage: "waiting" });
    expect(await decided(model, setMode())).toEqual([
      "thread.move-mode-set",
      "thread.session-stop-requested",
    ]);
    ({ model } = await apply(model, setMode()));
    expect(threadOf(model).pendingMove).toMatchObject({
      requestId: REQUEST,
      mode: "stop-now",
      stage: "quiescing",
      batchId: BATCH,
    });
    // Asked again, it's no news.
    expect(await decided(model, setMode())).toEqual([]);
  });

  it("every way a queued move ends leaves its outcome, which outlives the move", async () => {
    // Blocked before it started: not moved, with why, in its batch.
    let { model } = await apply(await seeded(), queue("when-done", REQUEST, BATCH));
    ({ model } = await apply(model, {
      type: "thread.move.queue-end",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      reason: "blocked",
      words: "This thread's agent set itself a time to come back. Cancel it first.",
      createdAt: now,
    }));
    expect(threadOf(model).lastMoveOutcome).toEqual({
      result: "not_moved",
      target: MAC_MINI,
      requestId: REQUEST,
      batchId: BATCH,
      words: "This thread's agent set itself a time to come back. Cancel it first.",
      reason: "blocked",
      at: now,
    });

    // Started, staged there, then refused there: the batch rides on the move.
    const second = ThreadMoveRequestId.make("request-2");
    ({ model } = await apply(model, queue("when-done", second, BATCH)));
    ({ model } = await apply(model, quiesce(second)));
    model = await withSession(model, "stopped");
    ({ model } = await apply(model, startQueued(second)));
    expect(threadOf(model).move).toMatchObject({ queuedRequestId: second, batchId: BATCH });
    // The queued move ending as it starts isn't an outcome.
    expect(threadOf(model).lastMoveOutcome?.requestId).toBe(REQUEST);
    const progress = (staged: boolean): OrchestrationCommand => ({
      type: "thread.move.progress",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      phase: "awaiting_approval",
      sentBytes: 10,
      totalBytes: 10,
      ...(staged ? { staged: true } : {}),
      createdAt: now,
    });
    // Waiting for Allow before any byte went is no answer yet.
    ({ model } = await apply(model, progress(false)));
    expect(threadOf(model).lastMoveOutcome?.requestId).toBe(REQUEST);
    ({ model } = await apply(model, progress(true)));
    expect(threadOf(model).lastMoveOutcome).toMatchObject({
      result: "awaiting_approval",
      requestId: second,
      transferId: TRANSFER,
      batchId: BATCH,
    });
    expect(threadOf(model).move?.phase).toBe("awaiting_approval");
    ({ model } = await apply(model, {
      type: "thread.move.abort",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      reason: "Mac mini didn't allow the move.",
      code: "denied",
      createdAt: now,
    }));
    expect(threadOf(model).move ?? null).toBeNull();
    expect(threadOf(model).lastMoveOutcome).toMatchObject({
      result: "not_moved",
      requestId: second,
      batchId: BATCH,
      words: "Mac mini didn't allow the move.",
      reason: "denied",
    });

    // A direct move that lands: moved, with no queued move to name.
    ({ model } = await apply(model, startMove()));
    ({ model } = await apply(model, {
      type: "thread.move.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      movedThreadId: ThreadId.make("thread-there"),
      createdAt: now,
    }));
    expect(threadOf(model).lastMoveOutcome).toEqual({
      result: "moved",
      target: MAC_MINI,
      transferId: TRANSFER,
      at: now,
    });
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

describe("a move carries what its thread had going (Part 3e)", () => {
  const REQUEST = ThreadMoveRequestId.make("request-carry");
  const TAKES_ALL = { threadState: true, generalChats: true } as const;
  const queue = (
    options: {
      readonly mode?: ThreadPendingMoveMode;
      readonly takes?: ThreadMoveTakes;
      readonly threadId?: ThreadId;
    } = {},
  ): OrchestrationCommand => ({
    type: "thread.move.queue",
    commandId: nextCommandId(),
    threadId: options.threadId ?? THREAD,
    requestId: REQUEST,
    target: MAC_MINI,
    agent: modelSelection,
    mode: options.mode ?? "when-done",
    requestedBy: { kind: "user" },
    ...(options.takes !== undefined ? { targetTakes: options.takes } : {}),
    createdAt: now,
  });
  const withThread = (
    model: OrchestrationReadModel,
    patch: Partial<OrchestrationThread>,
    threadId = THREAD,
  ): OrchestrationReadModel => ({
    ...model,
    threads: model.threads.map((thread) =>
      thread.id === threadId ? ({ ...thread, ...patch } as OrchestrationThread) : thread,
    ),
  });
  const goal = (status: ThreadGoalStatus, extra?: Partial<OrchestrationThreadGoal>) => ({
    threadId: THREAD,
    objective: "Make the suite pass",
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  const checkBack = (id: string, durable = false) => ({
    id,
    participantId: null,
    scheduledFor: "2026-10-22T10:30:00.000Z",
    exact: true,
    recurring: false,
    description: "Look at CI",
    prompt: "Look at CI on #212",
    durable,
  });
  const queued = (id: string, extra?: Record<string, unknown>) =>
    ({
      messageId: MessageId.make(id),
      text: "and then this",
      attachments: [],
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
      ...extra,
    }) as OrchestrationQueuedFollowUp;
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

  it("each thing a thread had going is refused for a computer that doesn't take it, and allowed for one that does", async () => {
    const base = await seeded();
    const latestTurn = {
      turnId: TurnId.make("turn-plan"),
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    } as OrchestrationThread["latestTurn"];
    const cases: ReadonlyArray<readonly [string, OrchestrationReadModel, string]> = [
      ["a goal", withThread(base, { goal: goal("active") }), "has a goal set"],
      ["a check-back", withThread(base, { checkBacks: [checkBack("cb-1")] }), "come back"],
      ["pull request auto-fix", withThread(base, { pullRequestAutoFix: true }), "auto-fix"],
      ["a queued message", withThread(base, { queuedFollowUps: [queued("q-1")] }), "queued"],
      [
        "a plan waiting",
        withThread(base, {
          latestTurn,
          proposedPlans: [
            {
              id: "plan-1",
              turnId: TurnId.make("turn-plan"),
              planMarkdown: "1. Fix it",
              implementedAt: null,
              implementationThreadId: null,
              dismissedAt: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
        "plan",
      ],
    ];
    for (const [what, model, words] of cases) {
      expect((await apply(model, queue())).refusal, what).toContain(words);
      expect(
        (await apply(model, queue({ takes: { threadState: true } }))).refusal,
        what,
      ).toBeNull();
    }

    // A general chat: no project to match, its own folder.
    const GENERAL = ProjectId.make("project-general-chats");
    const CHAT = ThreadId.make("thread-chat");
    let model = base;
    ({ model } = await apply(model, {
      type: "project.create",
      commandId: nextCommandId(),
      projectId: GENERAL,
      kind: "general-chat",
      title: "General Chats",
      workspaceRoot: "/state/general-chats",
      createdAt: now,
    } as OrchestrationCommand));
    ({ model } = await apply(model, {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: CHAT,
      projectId: GENERAL,
      title: "Ideas",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    }));
    expect((await apply(model, queue({ threadId: CHAT }))).refusal).toContain("General chats");
    expect(
      (await apply(model, queue({ threadId: CHAT, takes: { threadState: true } }))).refusal,
    ).toContain("General chats");
    expect((await apply(model, queue({ threadId: CHAT, takes: TAKES_ALL }))).refusal).toBeNull();
  });

  it("a message queued by a scheduled task, another thread or an assistant still keeps the thread here", async () => {
    const model = withThread(await seeded(), {
      queuedFollowUps: [queued("q-scheduled", { scheduledTaskId: "task-1" })],
    });
    expect((await apply(model, queue({ takes: TAKES_ALL }))).refusal).toContain(
      "A scheduled task's message is waiting its turn. Move once it has been sent, or remove it.",
    );
  });

  it("a check-back Claude saved to disk is named as such for a computer that can't take it", async () => {
    const model = withThread(await seeded(), { checkBacks: [checkBack("cb-saved", true)] });
    expect((await apply(model, queue())).refusal).toContain(
      "Claude saved this thread's check-back to disk. Ask the agent to delete it, then move.",
    );
  });

  it("each decision that plans the stop records what it takes, and only ever adds to it", async () => {
    const working = withThread(
      await withSession(await seeded(), "running", TurnId.make("turn-1")),
      { goal: goal("active"), checkBacks: [checkBack("cb-1")] },
    );
    // Stop and move now: at once.
    const stopNow = await apply(working, queue({ mode: "stop-now", takes: TAKES_ALL }));
    expect(threadOf(stopNow.model).pendingMove?.interrupted).toEqual({
      goalActive: true,
      checkBacks: [checkBack("cb-1")],
    });

    // Move when it's done: nothing yet, then the barrier's quiesce once it's free.
    const free = withThread(await withSession(await seeded(), "ready"), {
      goal: goal("active"),
      checkBacks: [checkBack("cb-1")],
    });
    let model = (await apply(free, queue({ takes: TAKES_ALL }))).model;
    expect(threadOf(model).pendingMove?.interrupted).toBeUndefined();
    ({ model } = await apply(model, {
      type: "thread.move.quiesce",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      createdAt: now,
    }));
    expect(threadOf(model).pendingMove?.interrupted).toMatchObject({ goalActive: true });
    // The stop paused the goal and ended the check-back; a turn slipped in
    // and set another: asked to stop again, the record keeps both and the goal.
    model = withThread(await withSession(model, "ready"), {
      goal: goal("paused"),
      checkBacks: [checkBack("cb-2")],
    });
    ({ model } = await apply(model, {
      type: "thread.move.quiesce",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      createdAt: now,
    }));
    expect(threadOf(model).pendingMove?.interrupted).toEqual({
      goalActive: true,
      checkBacks: [checkBack("cb-1"), checkBack("cb-2")],
    });

    // The freeze carries it to the move, with what the target said it takes.
    model = withThread(await withSession(model, "stopped"), { checkBacks: [] });
    ({ model } = await apply(model, {
      type: "thread.move.start",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      target: MAC_MINI,
      agent: modelSelection,
      queuedRequestId: REQUEST,
      targetTakes: TAKES_ALL,
      createdAt: now,
    }));
    expect(threadOf(model).move).toMatchObject({
      interrupted: { goalActive: true },
      targetTakes: TAKES_ALL,
    });

    // "Stop the agents and move now" on a waiting move records it too.
    const waiting = (await apply(free, queue({ takes: TAKES_ALL }))).model;
    const switched = await apply(waiting, {
      type: "thread.move.set-mode",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      mode: "stop-now",
      createdAt: now,
    });
    expect(threadOf(switched.model).pendingMove?.interrupted).toMatchObject({ goalActive: true });

    // A direct move whose session still runs records it in the freeze.
    const ready = withThread(await withSession(await seeded(), "ready"), {
      goal: goal("active"),
    });
    const direct = await apply(ready, {
      ...startMove(),
      targetTakes: TAKES_ALL,
    } as OrchestrationCommand);
    expect(direct.refusal).toBeNull();
    expect(threadOf(direct.model).move?.interrupted).toEqual({ goalActive: true });
  });

  it("a frozen thread still takes what its provider reports of its goal", async () => {
    const frozen = (
      await apply(withThread(await seeded(), { goal: goal("active") }), {
        ...startMove(),
        targetTakes: TAKES_ALL,
      } as OrchestrationCommand)
    ).model;
    const reported = await apply(frozen, {
      type: "thread.goal.state.set",
      commandId: nextCommandId(),
      threadId: THREAD,
      goal: goal("paused"),
      createdAt: now,
    });
    expect(reported.refusal).toBeNull();
    expect(threadOf(reported.model).goal?.status).toBe("paused");
  });

  it("no queued message is sent while a move waits; what goes into a running turn still does", async () => {
    const model = withThread((await apply(await seeded(), queue({ takes: TAKES_ALL }))).model, {
      queuedFollowUps: [queued("q-1")],
    });
    const send = {
      type: "thread.follow-up.send-queued",
      commandId: nextCommandId(),
      threadId: THREAD,
      messageId: MessageId.make("q-1"),
      createdAt: now,
    } as OrchestrationCommand;
    expect(threadMoveGuardRefusal(model, send)).toContain("waiting to move");
    expect(
      threadMoveGuardRefusal(model, { ...send, steeredTurnId: TurnId.make("turn-1") } as never),
    ).toBeNull();
  });

  it("the read-only copy keeps no queue and no switch on", async () => {
    let model = withThread(await seeded(), {
      queuedFollowUps: [queued("q-1")],
      pullRequestAutoFix: true,
      linkedPullRequests: [
        {
          number: 212,
          url: "https://github.com/acme/w/pull/212",
          autoFix: false,
          autoMerge: "squash",
        },
      ],
    });
    ({ model } = await apply(model, {
      ...startMove(),
      targetTakes: TAKES_ALL,
    } as OrchestrationCommand));
    ({ model } = await apply(model, {
      type: "thread.move.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      movedThreadId: ThreadId.make("thread-there"),
      createdAt: now,
    }));
    const copy = threadOf(model);
    expect(copy.queuedFollowUps ?? []).toEqual([]);
    expect(copy.pullRequestAutoFix).toBe(false);
    expect(copy.linkedPullRequests).toMatchObject([
      { number: 212, autoFix: false, autoMerge: null },
    ]);
  });

  it("a move that doesn't happen owes back what its stop took, until it is paid", async () => {
    const working = withThread(
      await withSession(await seeded(), "running", TurnId.make("turn-1")),
      { goal: goal("active"), checkBacks: [checkBack("cb-1")], queuedFollowUps: [queued("q-1")] },
    );
    let model = (await apply(working, queue({ mode: "stop-now", takes: TAKES_ALL }))).model;
    // The stop paused the goal (Codex) and ended the check-back.
    model = withThread(await withSession(model, "stopped"), {
      goal: goal("paused"),
      checkBacks: [],
    });
    ({ model } = await apply(model, {
      type: "thread.move.unqueue",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      createdAt: now,
    }));
    const owed = threadOf(model).moveRestoreOwed;
    expect(owed).toMatchObject({
      target: MAC_MINI,
      interrupted: { goalActive: true, checkBacks: [checkBack("cb-1")] },
      queued: true,
    });

    // Paid in one decision: the goal is on again, the agent's message goes
    // ahead of the user's queue, and only the goal's hand-over is left.
    ({ model } = await apply(model, {
      type: "thread.move.restore",
      commandId: nextCommandId(),
      threadId: THREAD,
      at: owed!.at,
      message: {
        messageId: MessageId.make("m-put-back"),
        text: "The move to Mac mini didn't happen.",
      },
      createdAt: now,
    }));
    const paid = threadOf(model);
    expect(paid.goal?.status).toBe("active");
    expect(paid.queuedFollowUps?.map((entry) => entry.messageId)).toEqual(["m-put-back", "q-1"]);
    expect(paid.queuedFollowUps?.[0]?.afterMove).toBe(true);
    expect(paid.moveRestoreOwed).toMatchObject({ goalOwed: true });
    // The same pay again is no news; the goal's hand-over clears it.
    const again = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "thread.move.restore",
          commandId: nextCommandId(),
          threadId: THREAD,
          at: owed!.at,
          createdAt: now,
        },
      }),
    );
    expect(Array.isArray(again) ? again : [again]).toEqual([]);
    ({ model } = await apply(model, {
      type: "thread.move.restore",
      commandId: nextCommandId(),
      threadId: THREAD,
      at: owed!.at,
      finished: true,
      createdAt: now,
    }));
    expect(threadOf(model).moveRestoreOwed ?? null).toBeNull();
  });

  it("a goal that finished stays finished, and an archived thread is owed nothing", async () => {
    const stopped = (
      await apply(
        withThread(await withSession(await seeded(), "running", TurnId.make("turn-1")), {
          goal: goal("active"),
        }),
        queue({ mode: "stop-now", takes: TAKES_ALL }),
      )
    ).model;
    // The goal was met as its agent stopped.
    let model = withThread(await withSession(stopped, "stopped"), { goal: goal("complete") });
    ({ model } = await apply(model, {
      type: "thread.move.queue-end",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      reason: "blocked",
      words: "Update Threadlines on Mac mini to move this thread: it has a goal.",
      createdAt: now,
    }));
    const owed = threadOf(model).moveRestoreOwed!;
    ({ model } = await apply(model, {
      type: "thread.move.restore",
      commandId: nextCommandId(),
      threadId: THREAD,
      at: owed.at,
      createdAt: now,
    }));
    expect(threadOf(model).goal?.status).toBe("complete");
    expect(threadOf(model).moveRestoreOwed ?? null).toBeNull();

    const gone = await apply(stopped, {
      type: "thread.move.queue-end",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST,
      reason: "gone",
      words: "This thread was archived.",
      createdAt: now,
    });
    expect(threadOf(gone.model).moveRestoreOwed ?? null).toBeNull();
  });

  it("a dropped move owes back what its stop took", async () => {
    let model = withThread(await withSession(await seeded(), "ready"), {
      goal: goal("active"),
    });
    ({ model } = await apply(model, {
      ...startMove(),
      targetTakes: TAKES_ALL,
    } as OrchestrationCommand));
    ({ model } = await apply(model, {
      type: "thread.move.abort",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      reason: "Mac mini didn't allow the move.",
      code: "denied",
      createdAt: now,
    }));
    expect(threadOf(model).moveRestoreOwed).toMatchObject({ interrupted: { goalActive: true } });
  });

  it("an import writes the goal, pull requests, plans and queue with the thread, the arrival first", async () => {
    const model = await seeded();
    const ARRIVED = ThreadId.make("thread-arrived");
    const events = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "thread.import",
          commandId: nextCommandId(),
          threadId: ARRIVED,
          projectId: PROJECT,
          title: "Fix the flaky test",
          modelSelection,
          runtimeMode: "auto",
          interactionMode: "default",
          branch: "fix/flaky",
          worktreePath: "/worktrees/moved-1",
          movedFrom: { ...MAC_MINI, threadId: THREAD, movedAt: now },
          messages: [],
          activities: [],
          goal: { ...goal("active"), threadId: ARRIVED },
          pullRequests: {
            autoFix: true,
            autoMerge: null,
            linked: [
              {
                number: 212,
                url: "https://github.com/acme/w/pull/212",
                autoFix: true,
                autoMerge: null,
              },
            ],
          },
          queuedFollowUps: [queued("q-there")],
          proposedPlans: [
            {
              id: "plan-there",
              turnId: null,
              planMarkdown: "1. Fix it",
              implementedAt: null,
              implementationThreadId: null,
              dismissedAt: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
          arrival: {
            message: { messageId: MessageId.make("m-arrival"), text: "This thread moved." },
            brought: ["its goal", "1 queued message", "auto-fix for #212"],
            left: [],
          },
          createdAt: now,
        },
      }),
    );
    const planned = Array.isArray(events) ? events : [events];
    // The pull request is linked, its switches stay off: the peer can't
    // turn one on here, whatever its command says.
    expect(planned.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.goal-state-set",
      "thread.pull-request-linked",
      "thread.proposed-plan-upserted",
      "thread.follow-up-queued",
      "thread.follow-up-queued",
      "thread.activity-appended",
    ]);
    // It arrives fenced.
    expect(planned[0]?.payload).toMatchObject({ movedFrom: { fenced: true } });
    const queuedEvents = planned.filter((event) => event.type === "thread.follow-up-queued");
    expect(queuedEvents.map((event) => event.payload)).toMatchObject([
      { imported: true, followUp: { messageId: "m-arrival", afterMove: true } },
      { imported: true, followUp: { messageId: "q-there", imported: true } },
    ]);
    expect(planned.at(-1)?.payload).toMatchObject({
      activity: {
        kind: "thread.moved-in",
        payload: { brought: ["its goal", "1 queued message", "auto-fix for #212"] },
      },
    });
  });

  it("resume on a moved thread whose agent wasn't given the conversation waits for the message that gives it", async () => {
    const ARRIVED = ThreadId.make("thread-resumed");
    const arrived = (
      await apply(await seeded(), {
        type: "thread.import",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        projectId: PROJECT,
        title: "Fix the flaky test",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "fix/flaky",
        worktreePath: "/worktrees/moved-2",
        movedFrom: { ...MAC_MINI, threadId: THREAD, movedAt: now },
        messages: [],
        activities: [],
        goal: { ...goal("paused"), threadId: ARRIVED },
        createdAt: now,
      })
    ).model;
    const resumed = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: arrived,
        command: {
          type: "thread.goal.set",
          commandId: nextCommandId(),
          threadId: ARRIVED,
          status: "active",
          createdAt: now,
        },
      }),
    );
    const planned = Array.isArray(resumed) ? resumed : [resumed];
    // No provider call: the goal reads on, and a message for its agent waits.
    expect(planned.map((event) => event.type)).toEqual([
      "thread.goal-state-set",
      "thread.follow-up-queued",
    ]);
  });
});

describe("what a moved thread is trusted with (Part 3e, security changes)", () => {
  const ARRIVED = ThreadId.make("thread-arrived-fenced");
  const PULL_REQUEST = { number: 212, url: "https://github.com/acme/w/pull/212" };
  const imported = async () =>
    (
      await apply(await seeded(), {
        type: "thread.import",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        projectId: PROJECT,
        title: "Fix the flaky test",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "fix/flaky",
        worktreePath: "/worktrees/moved-fenced",
        movedFrom: {
          ...MAC_MINI,
          threadId: THREAD,
          movedAt: now,
          pullRequestSwitches: {
            autoFix: false,
            autoMerge: null,
            linked: [{ ...PULL_REQUEST, autoFix: true, autoMerge: "squash" }],
          },
        },
        messages: [],
        activities: [],
        pullRequests: {
          autoFix: false,
          autoMerge: null,
          linked: [{ ...PULL_REQUEST, autoFix: false, autoMerge: null }],
        },
        queuedFollowUps: [
          {
            messageId: MessageId.make("q-there"),
            text: "and then this",
            attachments: [],
            runtimeMode: "auto",
            interactionMode: "default",
            createdAt: now,
          },
        ],
        arrival: {
          message: { messageId: MessageId.make("m-arrival"), text: "This thread moved." },
          brought: ["pull request #212"],
          left: [],
        },
        createdAt: now,
      })
    ).model;
  const userTurn = (extra: Record<string, unknown> = {}): OrchestrationCommand =>
    ({
      type: "thread.turn.start",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      message: {
        messageId: MessageId.make(`m-${sequence}`),
        role: "user",
        text: "Carry on",
        attachments: [],
      },
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
      ...extra,
    }) as OrchestrationCommand;
  const sendQueued = (messageId: string): OrchestrationCommand => ({
    type: "thread.follow-up.send-queued",
    commandId: nextCommandId(),
    threadId: ARRIVED,
    messageId: MessageId.make(messageId),
    createdAt: now,
  });

  it("an imported pull request switch arrives off, and the user's own turn-on works and ends the offer", async () => {
    let model = await imported();
    const arrived = threadOf(model, ARRIVED);
    expect(arrived.linkedPullRequests).toMatchObject([
      { number: 212, autoFix: false, autoMerge: null },
    ]);
    expect(arrived.movedFrom?.pullRequestSwitches?.linked).toMatchObject([
      { number: 212, autoFix: true, autoMerge: "squash" },
    ]);

    let refusal: string | null;
    ({ model, refusal } = await apply(model, {
      type: "thread.pull-request-automation.set",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      pullRequestNumber: 212,
      autoFix: true,
      autoMerge: "squash",
    }));
    expect(refusal).toBeNull();
    const turnedOn = threadOf(model, ARRIVED);
    expect(turnedOn.linkedPullRequests).toMatchObject([
      { number: 212, autoFix: true, autoMerge: "squash" },
    ]);
    expect(turnedOn.movedFrom?.pullRequestSwitches).toBeUndefined();
    expect(turnedOn.movedFrom?.fenced).toBe(true);
  });

  it("the arrival and the move's queued messages leave the fence up; the user's own message here lifts it", async () => {
    let model = await imported();
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);
    // The arrival kick, then the user's message from there.
    let refusal: string | null;
    ({ model, refusal } = await apply(model, sendQueued("m-arrival")));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).queuedFollowUps).toHaveLength(1);
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);
    model = await project(model, "thread.session-set", {
      threadId: ARRIVED,
      session: {
        threadId: ARRIVED,
        status: "ready",
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    });
    ({ model, refusal } = await apply(
      model,
      sendQueued(threadOf(model, ARRIVED).queuedFollowUps![0]!.messageId),
    ));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).queuedFollowUps ?? []).toHaveLength(0);
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);

    // Pull request auto-fix, and a restart's resume, are Threadlines' words, not the user's.
    for (const extra of [{ keepsMoveFence: true }, { trigger: "serverRestart" }]) {
      const decided = await Effect.runPromise(
        decideOrchestrationCommand({ readModel: model, command: userTurn(extra) }),
      );
      const planned = Array.isArray(decided) ? decided : [decided];
      const requested = planned.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.payload).not.toHaveProperty("liftsMoveFence");
    }

    ({ model } = await apply(model, userTurn()));
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBeUndefined();
    // The rest of where it came from stays.
    expect(threadOf(model, ARRIVED).movedFrom).toMatchObject({ label: "Mac mini" });
  });
});

describe("a moved thread that moves on, or edits its goal before its agent knows it (Part 3e)", () => {
  const ARRIVED = ThreadId.make("thread-arrived-twice");
  const importHere = (extra: Record<string, unknown>): OrchestrationCommand =>
    ({
      type: "thread.import",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      projectId: PROJECT,
      title: "Fix the flaky test",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: "fix/flaky",
      worktreePath: "/worktrees/moved-3",
      movedFrom: { ...MAC_MINI, threadId: THREAD, movedAt: now },
      messages: [],
      activities: [],
      createdAt: now,
      ...extra,
    }) as OrchestrationCommand;

  it("a plan that arrived waiting still keeps the thread from a computer that can't take it", async () => {
    const arrived = (
      await apply(
        await seeded(),
        importHere({
          proposedPlans: [
            {
              id: "plan-there",
              turnId: null,
              planMarkdown: "1. Fix it",
              implementedAt: null,
              implementationThreadId: null,
              dismissedAt: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      )
    ).model;
    const queueOn = (takes?: ThreadMoveTakes): OrchestrationCommand => ({
      type: "thread.move.queue",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      requestId: ThreadMoveRequestId.make("request-again"),
      target: { environmentId: EnvironmentId.make("environment-pc"), label: "Windows PC" },
      agent: modelSelection,
      mode: "when-done",
      requestedBy: { kind: "user" },
      ...(takes !== undefined ? { targetTakes: takes } : {}),
      createdAt: now,
    });
    expect((await apply(arrived, queueOn())).refusal).toContain("plan");
    expect((await apply(arrived, queueOn({ threadState: true }))).refusal).toBeNull();
  });

  it("a goal set before its agent was given the conversation waits for the message that gives it", async () => {
    const arrived = (await apply(await seeded(), importHere({}))).model;
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: arrived,
        command: {
          type: "thread.goal.set",
          commandId: nextCommandId(),
          threadId: ARRIVED,
          objective: "Ship the fix",
          createdAt: now,
        },
      }),
    );
    const planned = Array.isArray(decided) ? decided : [decided];
    expect(planned.map((event) => event.type)).toEqual([
      "thread.goal-state-set",
      "thread.follow-up-queued",
    ]);
    expect(planned[0]?.payload).toMatchObject({
      goal: { objective: "Ship the fix", status: "active" },
    });
  });
});
