import {
  ChildRequestBatchId,
  ChildRequestId,
  CommandId,
  CommandRunId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RELAY_DEVICE_SESSION_SUBJECT,
  SideTurnId,
  ThreadId,
  ThreadMoveBatchId,
  ThreadMoveFamilyId,
  ThreadMoveId,
  ThreadMoveRequestId,
  ThreadParticipantId,
  TurnId,
  RoomAgentRequestId,
  type AuthClientMetadata,
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
import { isLinkFenced } from "./linkFence.ts";
import { messageSentFromSession } from "./messageSentFrom.ts";
import { threadMoveGuardRefusal, threadMoveRefusals } from "./threadMoveDecisions.ts";

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
  /** Where the server says a person's message came from (withMessageSentFrom). */
  const AT_THIS_COMPUTER = { kind: "computer", place: "here" } as const;
  const imported = async (extra: Record<string, unknown> = {}) =>
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
            // The other computer's word for where it was sent from.
            sentFrom: AT_THIS_COMPUTER,
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
        ...extra,
      } as OrchestrationCommand)
    ).model;
  /** Arrived with nothing queued, so each case queues its own message. */
  const importedEmpty = () => imported({ queuedFollowUps: [], arrival: undefined });
  const withSession = (
    model: OrchestrationReadModel,
    status: OrchestrationSession["status"],
    activeTurnId: TurnId | null = null,
  ) =>
    project(model, "thread.session-set", {
      threadId: ARRIVED,
      session: {
        threadId: ARRIVED,
        status,
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId,
        lastError: null,
        updatedAt: now,
      },
    });
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
    // Only this server says where a message came from: the other computer's word is dropped.
    expect(
      threadOf(model, ARRIVED).queuedFollowUps?.find((entry) => entry.messageId === "q-there"),
    ).not.toHaveProperty("sentFrom");
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

    // Pull request auto-fix (no device, as Threadlines sends it) and a
    // restart's resume are not a person here.
    for (const extra of [{}, { trigger: "serverRestart", sentFrom: AT_THIS_COMPUTER }]) {
      const decided = await Effect.runPromise(
        decideOrchestrationCommand({ readModel: model, command: userTurn(extra) }),
      );
      const planned = Array.isArray(decided) ? decided : [decided];
      const requested = planned.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.payload).not.toHaveProperty("liftsMoveFence");
    }

    ({ model } = await apply(model, userTurn({ sentFrom: AT_THIS_COMPUTER })));
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBeUndefined();
    // The rest of where it came from stays.
    expect(threadOf(model, ARRIVED).movedFrom).toMatchObject({ label: "Mac mini" });
  });

  it("a person's queued message lifts the fence once it is sent", async () => {
    const turn = TurnId.make("turn-busy");
    let model = await withSession(await importedEmpty(), "running", turn);
    let refusal: string | null;
    ({ model, refusal } = await apply(model, {
      type: "thread.follow-up.submit",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      turnId: turn,
      message: {
        messageId: MessageId.make("m-when-done"),
        role: "user",
        text: "Then this",
        attachments: [],
      },
      delivery: "queue",
      composer: "typed",
      sentFrom: AT_THIS_COMPUTER,
      createdAt: now,
    }));
    expect(refusal).toBeNull();
    model = await withSession(model, "ready");
    ({ model, refusal } = await apply(model, sendQueued("m-when-done")));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBeUndefined();
  });

  it("a browser paired through the relay lifts the fence; a linked computer, a CLI token or a script can't", async () => {
    const signedIn = (
      subject: string,
      role: "owner" | "client" | "peer",
      client: AuthClientMetadata,
    ) => messageSentFromSession({ subject, role, client }, "elsewhere");
    const relayBrowser = signedIn(RELAY_DEVICE_SESSION_SUBJECT, "client", {
      label: "Chrome on macOS",
      deviceType: "unknown",
      os: "macOS",
    });
    expect(relayBrowser).toEqual({
      kind: "computer",
      name: "Chrome on macOS",
      os: "macOS",
      place: "elsewhere",
    });
    const notAPerson = [
      // A computer link through the relay: its pairing said "computer".
      signedIn(RELAY_DEVICE_SESSION_SUBJECT, "peer", { deviceType: "desktop" }),
      // `threadlines auth session issue`, an owner token for a script or an agent.
      signedIn("cli-issued-session", "owner", { label: "deploy bot", deviceType: "bot" }),
      // A paired sign-in from curl, and one that sent no user agent at all.
      signedIn("one-time-token", "client", { deviceType: "bot", userAgent: "curl/8.7.1" }),
      signedIn("one-time-token", "owner", { deviceType: "unknown" }),
    ];
    expect(notAPerson).toEqual([undefined, undefined, undefined, undefined]);

    const fenced = await withSession(await importedEmpty(), "ready");
    for (const sentFrom of notAPerson) {
      const { model } = await apply(fenced, userTurn(sentFrom ? { sentFrom } : {}));
      expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);
    }
    const { model } = await apply(fenced, userTurn({ sentFrom: relayBrowser }));
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBeUndefined();
  });

  it("command output sent once the agent is idle leaves the fence up", async () => {
    let model = await withSession(await importedEmpty(), "ready");
    model = await project(model, "thread.command-run-started", {
      threadId: ARRIVED,
      run: {
        runId: "run-1",
        terminalId: "terminal-run",
        mode: "run",
        dialect: "posix",
        command: "pnpm test",
        source: { kind: "request", requestId: "request-1" },
        turnId: "turn-asked",
        participantId: null,
        cwd: "/worktrees/moved-fenced",
        autoSend: true,
      },
      createdAt: now,
    });
    let refusal: string | null;
    ({ model, refusal } = await apply(model, {
      type: "thread.command-run.deliver-output",
      commandId: nextCommandId(),
      threadId: ARRIVED,
      runId: CommandRunId.make("run-1"),
      automatic: true,
      message: { messageId: MessageId.make("command-output:run-1"), text: "I ran pnpm test" },
      createdAt: now,
    }));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).queuedFollowUps).toMatchObject([
      { messageId: "command-output:run-1" },
    ]);
    ({ model, refusal } = await apply(model, sendQueued("command-output:run-1")));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).messages.at(-1)).toMatchObject({
      id: "command-output:run-1",
    });
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);
  });

  it("pull request auto-fix that waited behind a continue leaves the fence up when it starts alone", async () => {
    let model = await withSession(await importedEmpty(), "ready");
    let refusal: string | null;
    // A restart's continue, still starting.
    ({ model, refusal } = await apply(
      model,
      userTurn({
        message: {
          messageId: MessageId.make("m-continue"),
          role: "user",
          text: "Continue where you left off.",
          attachments: [],
        },
        trigger: "serverRestart",
      }),
    ));
    expect(refusal).toBeNull();
    // Auto-fix's turn, as the watcher sends it: it overtakes the continue and waits.
    ({ model, refusal } = await apply(
      model,
      userTurn({
        message: {
          messageId: MessageId.make("m-auto-fix"),
          role: "user",
          text: "Fix the failing check",
          attachments: [],
        },
        modelSelection,
      }),
    ));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).queuedFollowUps).toMatchObject([
      { messageId: "m-auto-fix", overtakes: "m-continue" },
    ]);
    // The continue never started; the auto-fix goes as its own turn.
    model = await withSession(model, "ready");
    ({ model, refusal } = await apply(model, sendQueued("m-auto-fix")));
    expect(refusal).toBeNull();
    expect(threadOf(model, ARRIVED).queuedFollowUps ?? []).toHaveLength(0);
    expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);
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
      // Back where it came from: still fenced, it goes nowhere else (Part 3f, (h)).
      target: MAC_MINI,
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

describe("a room moves with its agents (Part 3f, (i))", () => {
  const REQUEST = ThreadMoveRequestId.make("request-room");
  const SOL = ThreadParticipantId.make("6f1d7c2a-1b2c-4d3e-8f90-0a1b2c3d4e5f");
  const ADA = ThreadParticipantId.make("7a2e8d3b-2c3d-4e4f-9a01-1b2c3d4e5f60");
  const ROOMS = { rooms: true, threadState: true } as const;
  const sol = {
    id: SOL,
    handle: "Sol",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    joinedAt: now,
    leftAt: null,
  };
  const withThread = (
    model: OrchestrationReadModel,
    patch: Partial<OrchestrationThread>,
  ): OrchestrationReadModel => ({
    ...model,
    threads: model.threads.map((thread) =>
      thread.id === THREAD ? ({ ...thread, ...patch } as OrchestrationThread) : thread,
    ),
  });
  const room = async () => withThread(await seeded(), { participants: [sol] });
  const queue = (
    takes: ThreadMoveTakes | undefined,
    mode: ThreadPendingMoveMode = "when-done",
  ): OrchestrationCommand => ({
    type: "thread.move.queue",
    commandId: nextCommandId(),
    threadId: THREAD,
    requestId: REQUEST,
    target: MAC_MINI,
    agent: modelSelection,
    mode,
    requestedBy: { kind: "user" },
    ...(takes !== undefined ? { targetTakes: takes } : {}),
    roomAgents: [{ participantId: SOL, agent: null }],
    createdAt: now,
  });
  const openRequest = (status: "pending" | "running" | "awaiting_user") => ({
    requestId: RoomAgentRequestId.make("request-" + status),
    kind: status === "awaiting_user" ? ("invite" as const) : ("hand_off" as const),
    from: { participantId: null },
    to: { participantId: SOL },
    callerTurnId: TurnId.make("turn-1"),
    chainEpoch: 0,
    status,
    requestMessageId: MessageId.make("m-request-" + status),
    createdAt: now,
  });
  const chainOf = (requests: ReadonlyArray<ReturnType<typeof openRequest>>) => ({
    open: requests,
    hold: false,
    chainEpoch: 0,
    requestsSinceUser: requests.length,
    invitesPaused: false,
    batchesSinceUser: [],
  });

  it("is refused for a computer that doesn't take rooms, and waits for its agents on one that does", async () => {
    const model = await room();
    expect((await apply(model, queue(undefined))).refusal).toContain(
      "Threads with more than one agent can't move yet.",
    );
    const busy = withThread(model, {
      agentRequests: chainOf([openRequest("pending"), openRequest("awaiting_user")]),
    });
    const queued = await apply(busy, queue(ROOMS));
    expect(queued.refusal).toBeNull();
    expect(threadOf(queued.model).pendingMove).toMatchObject({
      roomAgents: [{ participantId: SOL, agent: null }],
      targetTakes: ROOMS,
      waitsFor: [
        { code: "approval", words: "once you answer" },
        { code: "side_turn", words: "when its agents finish" },
      ],
    });
  });

  it("a started move keeps the agent each room agent moves as, for its export", async () => {
    const { model, refusal } = await apply(await room(), {
      type: "thread.move.start",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      target: MAC_MINI,
      agent: modelSelection,
      targetTakes: ROOMS,
      roomAgents: [{ participantId: SOL, agent: modelSelection }],
      createdAt: now,
    });
    expect(refusal).toBeNull();
    expect(threadOf(model).move?.roomAgents).toEqual([
      { participantId: SOL, agent: modelSelection },
    ]);
  });

  it("the project's lead chat stays refused, rooms or not", async () => {
    const model = await room();
    const view = {
      ...model,
      projects: model.projects.map((project) => ({ ...project, leadThreadId: THREAD })),
    };
    const codes = threadMoveRefusals(view, threadOf(model), {
      rooms: true,
      threadState: true,
      generalChats: true,
      outsideWork: true,
    }).map((entry) => entry.code);
    expect(codes).toContain("lead");
  });

  it("while it waits, the room's queued hand-offs and replies still go; from quiescing on nothing does, and no agent asks anew", async () => {
    const handOff = {
      messageId: MessageId.make("m-hand-off"),
      text: "Take it from here",
      attachments: [],
      participantId: SOL,
      fromAgent: { participantId: null },
      requestId: RoomAgentRequestId.make("request-pending"),
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
    } as OrchestrationQueuedFollowUp;
    const usersOwn = {
      messageId: MessageId.make("m-users"),
      text: "Then this",
      attachments: [],
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
    } as OrchestrationQueuedFollowUp;
    const pending = (stage: "waiting" | "quiescing") =>
      ({
        requestId: REQUEST,
        target: MAC_MINI,
        mode: "when-done",
        stage,
        requestedAt: now,
        requestedBy: { kind: "user" },
        targetTakes: ROOMS,
      }) as const;
    const send = (messageId: string): OrchestrationCommand => ({
      type: "thread.follow-up.send-queued",
      commandId: nextCommandId(),
      threadId: THREAD,
      messageId: MessageId.make(messageId),
      createdAt: now,
    });
    const waiting = withThread(await room(), {
      pendingMove: pending("waiting"),
      queuedFollowUps: [handOff, usersOwn],
    });
    expect(threadMoveGuardRefusal(waiting, send("m-hand-off"))).toBeNull();
    expect(threadMoveGuardRefusal(waiting, send("m-users"))).toContain("waiting to move");
    const ask = {
      type: "thread.agent-request.submit",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: RoomAgentRequestId.make("request-new"),
      kind: "hand_off",
      from: { participantId: null },
      to: { participantId: SOL },
      callerTurnId: TurnId.make("turn-1"),
      chainEpoch: 0,
      message: { messageId: MessageId.make("m-new-request"), text: "And this" },
      createdAt: now,
    } as unknown as OrchestrationCommand;
    expect(threadMoveGuardRefusal(waiting, ask)).toContain("waiting to move");
    const quiescing = withThread(waiting, { pendingMove: pending("quiescing") });
    expect(threadMoveGuardRefusal(quiescing, send("m-hand-off"))).toContain("waiting to move");
  });

  it("while it waits, a queued hand-off is sent and its turn runs, so the chain finishes and the move can go", async () => {
    const REQUEST_ID = RoomAgentRequestId.make("request-queued");
    const handOff = {
      messageId: MessageId.make("m-hand-off-drained"),
      text: "Take it from here",
      attachments: [],
      participantId: SOL,
      fromAgent: { participantId: null },
      requestId: REQUEST_ID,
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
    } as OrchestrationQueuedFollowUp;
    const pending = (stage: "waiting" | "quiescing") =>
      ({
        requestId: REQUEST,
        target: MAC_MINI,
        mode: "when-done",
        stage,
        requestedAt: now,
        requestedBy: { kind: "user" },
        targetTakes: ROOMS,
      }) as const;
    let model = await project(await room(), "thread.message-sent", {
      threadId: THREAD,
      messageId: handOff.messageId,
      role: "user",
      text: handOff.text,
      attachments: [],
      participantId: SOL,
      fromAgent: { participantId: null },
      requestId: REQUEST_ID,
      requestKind: "hand_off",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
    model = withThread(model, {
      pendingMove: pending("waiting"),
      queuedFollowUps: [handOff],
      agentRequests: chainOf([
        { ...openRequest("pending"), requestId: REQUEST_ID, status: "queued" as never },
      ]),
    });
    const send = (): OrchestrationCommand => ({
      type: "thread.follow-up.send-queued",
      commandId: nextCommandId(),
      threadId: THREAD,
      messageId: handOff.messageId,
      createdAt: now,
    });
    // From quiescing on, nothing drains.
    const quiescing = await apply(withThread(model, { pendingMove: pending("quiescing") }), send());
    expect(quiescing.refusal).toContain("waiting to move");
    // Waiting, it is sent: Sol's turn starts on it, through the whole decision.
    const sent = await apply(model, send());
    expect(sent.refusal).toBeNull();
    const working = threadOf(sent.model);
    expect(working.queuedFollowUps ?? []).toEqual([]);
    expect(working.latestTurn?.state === "running" || working.session !== null).toBe(true);
    // Its turn answers the hand-off: nothing open, so the move waits for nothing of the chain.
    const settled = await apply(sent.model, {
      type: "thread.agent-request.settle",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: REQUEST_ID,
      outcome: "answered",
      createdAt: now,
    });
    expect(settled.refusal).toBeNull();
    const after = threadOf(settled.model);
    expect(after.agentRequests.open).toEqual([]);
    expect(
      threadMoveRefusals(settled.model, after, ROOMS).filter(
        (entry) => entry.words === "when its agents finish",
      ),
    ).toEqual([]);
  });

  it("stop and move now ends the agents' chain and every side answer, as Stop does", async () => {
    const running = await project(await room(), "thread.session-set", {
      threadId: THREAD,
      session: {
        threadId: THREAD,
        status: "running",
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt: now,
      },
    });
    const sideTurn = (id: string, askedBy?: { participantId: null }) => ({
      sideTurnId: SideTurnId.make(id),
      participantId: SOL,
      messageId: MessageId.make("m-" + id),
      status: "running",
      startedAt: now,
      kind: "ask",
      ...(askedBy !== undefined
        ? { askedBy, requestId: RoomAgentRequestId.make("request-running") }
        : {}),
    });
    const busy = withThread(running, {
      sideTurns: [sideTurn("users-side"), sideTurn("agents-side", { participantId: null })],
      agentRequests: chainOf([openRequest("running")]),
    } as Partial<OrchestrationThread>);
    const { model, refusal } = await apply(busy, queue(ROOMS, "stop-now"));
    expect(refusal).toBeNull();
    const thread = threadOf(model);
    expect(thread.agentRequests.open).toEqual([]);
    expect(thread.agentRequests.hold).toBe(true);
    const events = await Effect.runPromise(
      decideOrchestrationCommand({ command: queue(ROOMS, "stop-now"), readModel: busy }),
    );
    const interrupted = (Array.isArray(events) ? events : [events])
      .filter((event) => event.type === "thread.side-turn-interrupt-requested")
      .map((event) => (event.payload as { sideTurnId: string }).sideTurnId)
      .toSorted();
    expect(interrupted).toEqual(["agents-side", "users-side"]);
  });

  it("an agent outside work limits stays here unless the other computer keeps the limit", async () => {
    const limited = withThread(await seeded(), {
      outsideWork: [
        {
          participantId: null,
          connections: [{ connectionId: "connection-1", name: "Chat" }],
          since: now,
          version: 1,
        },
      ],
    } as unknown as Partial<OrchestrationThread>);
    expect((await apply(limited, queue({ threadState: true }))).refusal).toContain(
      "An outside assistant's work limits this thread's agent",
    );
    expect(
      (await apply(limited, queue({ threadState: true, outsideWork: true }))).refusal,
    ).toBeNull();
  });

  describe("arriving", () => {
    const ARRIVED = ThreadId.make("thread-room-arrived");
    const importRoom = (extra: Record<string, unknown> = {}): OrchestrationCommand =>
      ({
        type: "thread.import",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        projectId: PROJECT,
        title: "Review the fix",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "fix/flaky",
        worktreePath: "/worktrees/moved-room",
        movedFrom: { ...MAC_MINI, threadId: THREAD, movedAt: now },
        messages: [
          {
            messageId: MessageId.make("m-hand-off-there"),
            role: "user",
            text: "Take it from here",
            turnId: null,
            participantId: SOL,
            fromAgent: { participantId: null },
            requestId: RoomAgentRequestId.make("request-there"),
            requestKind: "hand_off",
            requestOutcome: "answered",
            createdAt: now,
          },
        ],
        activities: [],
        participants: [
          { ...sol, movedIn: true, nativeSession: "carried" },
          { ...sol, id: ADA, handle: "Ada", leftAt: now },
        ],
        agentRole: "Builder",
        outsideWork: [
          {
            participantId: SOL,
            connections: [{ connectionId: "connection-1", name: "Chat" }],
            since: now,
            version: 2,
          },
        ],
        createdAt: now,
        ...extra,
      }) as unknown as OrchestrationCommand;

    it("writes every agent, fenced, with the room fields and outside marks the move carried", async () => {
      const { model, refusal } = await apply(await seeded(), importRoom());
      expect(refusal).toBeNull();
      const arrived = threadOf(model, ARRIVED);
      expect(arrived.movedFrom?.fenced).toBe(true);
      expect(arrived.agentRole).toBe("Builder");
      expect(arrived.participants).toMatchObject([
        { id: SOL, handle: "Sol", leftAt: null, movedIn: true, nativeSession: "carried" },
        { id: ADA, handle: "Ada", leftAt: now },
      ]);
      expect(arrived.outsideWork).toMatchObject([{ participantId: SOL, version: 2 }]);
      expect(arrived.messages[0]).toMatchObject({
        participantId: SOL,
        fromAgent: { participantId: null },
        requestKind: "hand_off",
        requestOutcome: "answered",
        imported: true,
      });
      expect(arrived.roomContext ?? {}).toEqual({});
      expect(arrived.sentModels ?? {}).toEqual({});
    });

    it("refuses a room naming an agent that didn't come, or too many agents", async () => {
      const stranger = ThreadParticipantId.make("8b3f9e4c-3d4e-4f50-8b12-2c3d4e5f6071");
      const strange = await apply(
        await seeded(),
        importRoom({
          outsideWork: [{ participantId: stranger, connections: [], since: now, version: 1 }],
        }),
      );
      expect(strange.refusal).toContain("names an agent that didn't come");
      const many = Array.from({ length: 17 }, (_, index) => ({
        ...sol,
        id: ThreadParticipantId.make(
          "9c4f0a5d-4e5f-4061-9c23-" + index.toString(16).padStart(12, "0"),
        ),
        handle: "Agent " + index,
      }));
      const crowded = await apply(
        await seeded(),
        importRoom({ participants: many, messages: [], outsideWork: [] }),
      );
      expect(crowded.refusal).toContain("too many agents");
    });

    it("a room agent's carried session proves itself or falls back on its own; the thread's debt stays", async () => {
      let { model } = await apply(await seeded(), importRoom());
      ({ model } = await apply(model, {
        type: "thread.history-seed.delivered",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        messageId: MessageId.make("m-hand-off-there"),
        nativeSession: "resumed",
        participantId: SOL,
        createdAt: now,
      }));
      let arrived = threadOf(model, ARRIVED);
      expect(arrived.participants[0]?.nativeSession).toBe("resumed");
      expect(arrived.historySeedOwed).toBe(true);
      // Resumed: no longer carried, so it can't fall back.
      const late = await apply(model, {
        type: "thread.native-session.fall-back",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        reason: "turn_failed",
        participantId: SOL,
        createdAt: now,
      });
      expect(late.refusal).toContain("no carried agent session");
      ({ model } = await apply(await seeded(), importRoom()));
      ({ model } = await apply(model, {
        type: "thread.native-session.fall-back",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        reason: "resume_failed",
        participantId: SOL,
        createdAt: now,
      }));
      arrived = threadOf(model, ARRIVED);
      expect(arrived.participants[0]?.nativeSession).toBe("fell_back");
      expect(arrived.nativeSession).toBeUndefined();
    });
  });
});

describe("a family moves together (Part 3f, (g))", () => {
  const CHILD = ThreadId.make("thread-child");
  const OTHER_CHILD = ThreadId.make("thread-other-child");
  const FAMILY = ThreadMoveFamilyId.make("family-1");
  const TAKES: ThreadMoveTakes = { threadState: true, families: true };
  const PARENT_REQUEST = ThreadMoveRequestId.make("request-parent");
  const CHILD_REQUEST = ThreadMoveRequestId.make("request-child");
  const OTHER_REQUEST = ThreadMoveRequestId.make("request-other-child");
  const CHILD_TRANSFER = ThreadMoveId.make("transfer-child");
  const ASK = ChildRequestId.make("child-request-1");

  const withChild = async (model: OrchestrationReadModel, id: ThreadId = CHILD) =>
    (
      await apply(model, {
        type: "thread.create",
        commandId: nextCommandId(),
        threadId: id,
        projectId: PROJECT,
        title: id === CHILD ? "Fix tests" : "Review",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: null,
        worktreePath: `/worktrees/${id}`,
        parentThreadId: THREAD,
        attachedToParent: true,
        createdAt: now,
      } as OrchestrationCommand)
    ).model;
  const queueFor = (
    threadId: ThreadId,
    requestId: ThreadMoveRequestId,
    family?: { readonly parentThreadId?: ThreadId },
    mode: ThreadPendingMoveMode = "when-done",
    takes: ThreadMoveTakes = TAKES,
  ): OrchestrationCommand => ({
    type: "thread.move.queue",
    commandId: nextCommandId(),
    threadId,
    requestId,
    target: MAC_MINI,
    agent: modelSelection,
    mode,
    requestedBy: { kind: "user" },
    targetTakes: takes,
    ...(family !== undefined ? { family: { id: FAMILY, ...family } } : {}),
    createdAt: now,
  });
  const quiesceFor = (
    threadId: ThreadId,
    requestId: ThreadMoveRequestId,
  ): OrchestrationCommand => ({
    type: "thread.move.quiesce",
    commandId: nextCommandId(),
    threadId,
    requestId,
    createdAt: now,
  });
  const startFor = (
    threadId: ThreadId,
    requestId: ThreadMoveRequestId,
    transferId: ThreadMoveId,
  ): OrchestrationCommand => ({
    type: "thread.move.start",
    commandId: nextCommandId(),
    threadId,
    transferId,
    target: MAC_MINI,
    agent: modelSelection,
    queuedRequestId: requestId,
    targetTakes: TAKES,
    createdAt: now,
  });
  /** The parent asks its child something, and waits for the answer. */
  const asked = (
    model: OrchestrationReadModel,
    status: "running" | "awaiting_user" = "running",
    remote?: { readonly environmentId: EnvironmentId; readonly label: string },
  ) =>
    project(model, "thread.child-request-submitted", {
      threadId: THREAD,
      request: {
        requestId: ASK,
        batchId: ChildRequestBatchId.make("child-batch-1"),
        kind: "send",
        from: { participantId: null },
        callerTurnId: TurnId.make("turn-ask"),
        deliveryEpoch: 0,
        status,
        childThreadId: CHILD,
        childMessageId: MessageId.make("m-ask"),
        ...(remote !== undefined
          ? { remote: { ...remote, threadId: CHILD, status: "accepted" }, text: "Check this" }
          : {}),
        createdAt: now,
      },
      createdAt: now,
    });
  const refusalsOf = (model: OrchestrationReadModel, threadId = THREAD) =>
    threadMoveRefusals(model, threadOf(model, threadId), TAKES);

  it("a child moves only with its parent's move, and the parent only to a computer that takes families", async () => {
    let model = await withChild(await seeded());
    // Not before its parent, and not on its own to a computer that can't keep it its parent's.
    expect(
      (await apply(model, queueFor(CHILD, CHILD_REQUEST, { parentThreadId: THREAD }))).refusal,
    ).toContain("Its parent thread didn't move.");
    expect((await apply(model, queueFor(CHILD, CHILD_REQUEST))).refusal).toContain(
      "moves with the thread that started it",
    );
    // A computer that doesn't take families: today's words.
    expect(
      (await apply(model, queueFor(THREAD, PARENT_REQUEST, {}, "when-done", { threadState: true })))
        .refusal,
    ).toContain("started other threads");
    // A move that doesn't wait (an older app) never takes the children along.
    expect(
      (await apply(model, { ...startMove(), targetTakes: TAKES } as OrchestrationCommand)).refusal,
    ).toContain("started other threads");

    ({ model } = await apply(model, queueFor(THREAD, PARENT_REQUEST, {})));
    expect(threadOf(model).pendingMove?.family).toEqual({ id: FAMILY });
    // A family that names another parent is refused.
    expect(
      (await apply(model, queueFor(CHILD, CHILD_REQUEST, { parentThreadId: OTHER_CHILD }))).refusal,
    ).toContain("didn't start this one");
    ({ model } = await apply(model, queueFor(CHILD, CHILD_REQUEST, { parentThreadId: THREAD })));
    expect(threadOf(model, CHILD).pendingMove?.family).toEqual({
      id: FAMILY,
      parentThreadId: THREAD,
    });

    // The parent's move ends: the child's can't go on.
    ({ model } = await apply(model, {
      type: "thread.move.unqueue",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: PARENT_REQUEST,
      createdAt: now,
    }));
    expect(refusalsOf(model, CHILD)).toContainEqual({
      kind: "blocked",
      code: "child",
      words: "Its parent thread didn't move.",
    });
  });

  it("waits for the threads it started to report back; Stop and move now ends the wait as Stop does", async () => {
    const working = await asked(await withChild(await seeded()));
    expect(refusalsOf(working)).toContainEqual({
      kind: "wait",
      code: "background",
      words: "when the threads it started report back",
    });
    expect(
      refusalsOf(await asked(await withChild(await seeded()), "awaiting_user")),
    ).toContainEqual({ kind: "wait", code: "approval", words: "once you answer" });
    const waiting = await apply(working, queueFor(THREAD, PARENT_REQUEST, {}));
    expect(waiting.refusal).toBeNull();
    expect(threadOf(waiting.model).childRequests.open).toHaveLength(1);

    const { model, refusal } = await apply(
      working,
      queueFor(THREAD, PARENT_REQUEST, {}, "stop-now"),
    );
    expect(refusal).toBeNull();
    const parent = threadOf(model);
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.deliveryEpoch).toBe(1);
    expect(parent.pendingMove?.interrupted?.childRequestsStopped).toBe(1);

    // One on another computer is cancelled there, and stopped, through Stop's own outbox.
    const remote = await asked(await withChild(await seeded()), "running", {
      environmentId: EnvironmentId.make("environment-windows"),
      label: "Windows PC",
    });
    const stopped = await apply(remote, queueFor(THREAD, PARENT_REQUEST, {}, "stop-now"));
    expect(threadOf(stopped.model).childRequests.remoteCancels).toMatchObject([
      { requestId: ASK, cancelRequest: true, stopThread: true },
    ]);
    // Frozen, the parent still records that the other computer took them.
    let frozen = (await apply(stopped.model, quiesceFor(THREAD, PARENT_REQUEST))).model;
    frozen = (await apply(frozen, startFor(THREAD, PARENT_REQUEST, TRANSFER))).model;
    expect(threadOf(frozen).move).not.toBeNull();
    const delivered = await apply(frozen, {
      type: "thread.remote-cancels.delivered",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestIds: [ASK],
      createdAt: now,
    });
    expect(delivered.refusal).toBeNull();
    expect(threadOf(delivered.model).childRequests.remoteCancels ?? []).toEqual([]);
  });

  it("a child's answer still reaches its parent while the move waits, not once the agent is being stopped", async () => {
    let model = await withChild(await seeded());
    ({ model } = await apply(model, queueFor(THREAD, PARENT_REQUEST, {})));
    model = await project(model, "thread.follow-up-queued", {
      threadId: THREAD,
      followUp: {
        messageId: MessageId.make("m-report"),
        text: "Tests pass now.",
        attachments: [],
        fromThread: {
          threadId: CHILD,
          requestId: ASK,
          kind: "report",
          deliveryEpoch: 0,
          attachmentEpoch: 0,
        },
        runtimeMode: "auto",
        interactionMode: "default",
        createdAt: now,
      },
    });
    // Something to wait for, not something to clear.
    expect(refusalsOf(model).some((entry) => entry.kind === "blocked")).toBe(false);
    const report = threadOf(model).queuedFollowUps?.[0];
    const send: OrchestrationCommand = {
      type: "thread.follow-up.send-queued",
      commandId: nextCommandId(),
      threadId: THREAD,
      messageId: MessageId.make("m-report"),
      createdAt: now,
    };
    const reportTurn = {
      type: "thread.turn.start",
      commandId: nextCommandId(),
      threadId: THREAD,
      message: { messageId: MessageId.make("m-report"), role: "user", text: "x", attachments: [] },
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: now,
    } as OrchestrationCommand;
    expect(threadMoveGuardRefusal(model, send)).toBeNull();
    expect(threadMoveGuardRefusal(model, reportTurn, report)).toBeNull();
    // New work stays refused: a new thread, or a new message to one.
    expect(
      threadMoveGuardRefusal(model, {
        type: "thread.child.send",
        commandId: nextCommandId(),
        threadId: THREAD,
      } as unknown as OrchestrationCommand),
    ).toContain("waiting to move to Mac mini");
    // From the stop on ("Stop and move now"), nothing more goes.
    model = await project(model, "thread.move-quiescing", {
      threadId: THREAD,
      requestId: PARENT_REQUEST,
      updatedAt: now,
    });
    expect(threadMoveGuardRefusal(model, send)).toContain("waiting to move to Mac mini");
  });

  it("the parent's arrival there makes the children that stayed their own threads, with a line", async () => {
    let model = await withChild(await withChild(await seeded()), OTHER_CHILD);
    ({ model } = await apply(model, queueFor(THREAD, PARENT_REQUEST, {})));
    ({ model } = await apply(model, queueFor(CHILD, CHILD_REQUEST, { parentThreadId: THREAD })));
    ({ model } = await apply(
      model,
      queueFor(OTHER_CHILD, OTHER_REQUEST, { parentThreadId: THREAD }),
    ));
    // The other child's move ends before the parent moved: it stays its child here.
    ({ model } = await apply(model, {
      type: "thread.move.unqueue",
      commandId: nextCommandId(),
      threadId: OTHER_CHILD,
      requestId: OTHER_REQUEST,
      createdAt: now,
    }));
    expect(threadOf(model, OTHER_CHILD).attachedToParent).toBe(true);
    ({ model } = await apply(model, quiesceFor(THREAD, PARENT_REQUEST)));
    ({ model } = await apply(model, startFor(THREAD, PARENT_REQUEST, TRANSFER)));
    expect(threadOf(model).move?.family).toEqual({ id: FAMILY });
    ({ model } = await apply(model, {
      type: "thread.move.complete",
      commandId: nextCommandId(),
      threadId: THREAD,
      transferId: TRANSFER,
      movedThreadId: ThreadId.make("thread-there"),
      createdAt: now,
    }));
    const stayed = threadOf(model, OTHER_CHILD);
    expect(stayed.attachedToParent).toBe(false);
    expect(stayed.activities.at(-1)).toMatchObject({
      kind: "thread.parent-moved-away",
      summary: "Its parent thread moved to Mac mini, so this is its own thread now.",
    });
    // The child that comes along stays its child, moving.
    expect(threadOf(model, CHILD).attachedToParent).toBe(true);
    // Then its own move is dropped there: it stays here, as its own thread.
    ({ model } = await apply(model, quiesceFor(CHILD, CHILD_REQUEST)));
    ({ model } = await apply(model, startFor(CHILD, CHILD_REQUEST, CHILD_TRANSFER)));
    ({ model } = await apply(model, {
      type: "thread.move.abort",
      commandId: nextCommandId(),
      threadId: CHILD,
      transferId: CHILD_TRANSFER,
      reason: "Mac mini couldn't take it.",
      createdAt: now,
    }));
    expect(threadOf(model, CHILD).move ?? null).toBeNull();
    expect(threadOf(model, CHILD).attachedToParent).toBe(false);
    expect(threadOf(model, CHILD).activities.at(-1)?.kind).toBe("thread.parent-moved-away");
  });

  it("a folder a frozen member works in no longer holds the others' moves", async () => {
    let model = await withChild(await seeded());
    // The parent works in its child's folder, and the child is at work there.
    model = await project(model, "thread.meta-updated", {
      threadId: THREAD,
      worktreePath: `/worktrees/${CHILD}`,
      worktreeOrigin: { kind: "thread", threadId: CHILD },
      updatedAt: now,
    });
    model = await project(model, "thread.session-set", {
      threadId: CHILD,
      session: {
        threadId: CHILD,
        status: "running",
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: TurnId.make("turn-child"),
        lastError: null,
        updatedAt: now,
      },
    });
    expect(refusalsOf(model).map((entry) => entry.code)).toContain("shared_checkout");
    // Frozen for its own move, it can't change a file there.
    model = await project(model, "thread.move-started", {
      threadId: CHILD,
      transferId: CHILD_TRANSFER,
      target: MAC_MINI,
      agent: modelSelection,
      startedAt: now,
      family: { id: FAMILY, parentThreadId: THREAD },
    });
    expect(refusalsOf(model).map((entry) => entry.code)).not.toContain("shared_checkout");
  });

  it("two members sharing a folder, each holding a message for the move, don't wait on each other", async () => {
    let model = await seeded();
    // The child works in its parent's folder.
    ({ model } = await apply(model, {
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: CHILD,
      projectId: PROJECT,
      title: "Fix tests",
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: "fix/flaky",
      worktreePath: "/worktrees/fix-flaky",
      parentThreadId: THREAD,
      attachedToParent: true,
      createdAt: now,
    } as OrchestrationCommand));
    ({ model } = await apply(model, queueFor(THREAD, PARENT_REQUEST, {})));
    ({ model } = await apply(model, queueFor(CHILD, CHILD_REQUEST, { parentThreadId: THREAD })));
    // Each holds the user's own message, which goes with it.
    for (const threadId of [THREAD, CHILD]) {
      model = await project(model, "thread.follow-up-queued", {
        threadId,
        followUp: {
          messageId: MessageId.make(`m-held-${threadId}`),
          text: "and then this",
          attachments: [],
          runtimeMode: "auto",
          interactionMode: "default",
          createdAt: now,
        },
      });
    }
    for (const threadId of [THREAD, CHILD]) {
      expect(refusalsOf(model, threadId)).toEqual([]);
    }
  });

  describe("arriving", () => {
    const PARENT_HERE = ThreadId.make("thread-parent-here");
    const CHILD_HERE = ThreadId.make("thread-child-here");
    const importFor = (
      threadId: ThreadId,
      extra: Record<string, unknown> = {},
      familyKey: string | null = "family-key-1",
    ): OrchestrationCommand =>
      ({
        type: "thread.import",
        commandId: nextCommandId(),
        threadId,
        projectId: PROJECT,
        title: threadId === PARENT_HERE ? "Fix the flaky test" : "Fix tests",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "fix/flaky",
        worktreePath: `/worktrees/${threadId}`,
        movedFrom: {
          ...MAC_MINI,
          threadId: THREAD,
          movedAt: now,
          ...(familyKey !== null ? { familyKey } : {}),
        },
        messages: [],
        activities: [],
        createdAt: now,
        ...extra,
      }) as OrchestrationCommand;
    const under = (parentThreadId: ThreadId) => ({
      lineage: { parentThreadId, parentTurnId: TurnId.make("turn-started-it") },
    });

    it("a child lands under the parent that came in its family, fenced on its own", async () => {
      let { model } = await apply(await seeded(), importFor(PARENT_HERE));
      ({ model } = await apply(model, importFor(CHILD_HERE, under(PARENT_HERE))));
      const child = threadOf(model, CHILD_HERE);
      expect(child).toMatchObject({
        parentThreadId: PARENT_HERE,
        parentTurnId: "turn-started-it",
        attachedToParent: true,
        parentAttachmentEpoch: 0,
      });
      expect(child.movedFrom?.fenced).toBe(true);
      // The user's message in the parent lifts the parent's fence, not the child's.
      ({ model } = await apply(model, {
        type: "thread.turn.start",
        commandId: nextCommandId(),
        threadId: PARENT_HERE,
        message: { messageId: MessageId.make("m-here"), role: "user", text: "Go", attachments: [] },
        sentFrom: { kind: "computer", place: "here" },
        runtimeMode: "auto",
        interactionMode: "default",
        createdAt: now,
      } as OrchestrationCommand));
      expect(threadOf(model, PARENT_HERE).movedFrom?.fenced).toBeUndefined();
      expect(threadOf(model, CHILD_HERE).movedFrom?.fenced).toBe(true);
    });

    it("never lands a child under a thread of this computer's own, or one from another family", async () => {
      let { model } = await apply(await seeded(), importFor(PARENT_HERE));
      // A thread this computer started itself, with no family.
      expect((await apply(model, importFor(CHILD_HERE, under(THREAD)))).refusal).toContain(
        "didn't move with it",
      );
      expect(
        (await apply(model, importFor(CHILD_HERE, under(PARENT_HERE), "family-key-2"))).refusal,
      ).toContain("didn't move with it");
      expect(
        (await apply(model, importFor(CHILD_HERE, under(PARENT_HERE), null))).refusal,
      ).toContain("only land under a parent that moved with it");
      expect(
        (await apply(model, importFor(CHILD_HERE, under(ThreadId.make("thread-nowhere"))))).refusal,
      ).toContain("isn't here");
      // Nor under a child.
      const withChildHere = (await apply(model, importFor(CHILD_HERE, under(PARENT_HERE)))).model;
      expect(
        (
          await apply(
            withChildHere,
            importFor(ThreadId.make("thread-grandchild"), under(CHILD_HERE)),
          )
        ).refusal,
      ).toContain("itself another thread's");
      // Nor under a parent deleted since.
      ({ model } = await apply(model, {
        type: "thread.delete",
        commandId: nextCommandId(),
        threadId: PARENT_HERE,
      } as OrchestrationCommand));
      expect((await apply(model, importFor(CHILD_HERE, under(PARENT_HERE)))).refusal).toContain(
        "isn't here",
      );
      // A guest marker names only a member of its own family.
      expect(
        (
          await apply(
            await seeded(),
            importFor(CHILD_HERE, { worktreeOrigin: { kind: "thread", threadId: THREAD } }),
          )
        ).refusal,
      ).toContain("isn't its family's");
      // Nor bring a message another thread here holds: it would be moved out of that thread.
      const withMessage = (
        await apply(model, {
          type: "thread.turn.start",
          commandId: nextCommandId(),
          threadId: THREAD,
          message: {
            messageId: MessageId.make("m-mine"),
            role: "user",
            text: "Hi",
            attachments: [],
          },
          runtimeMode: "auto",
          interactionMode: "default",
          createdAt: now,
        } as OrchestrationCommand)
      ).model;
      expect(
        (
          await apply(
            withMessage,
            importFor(CHILD_HERE, {
              messages: [
                {
                  messageId: MessageId.make("m-mine"),
                  role: "user",
                  text: "Hi",
                  turnId: null,
                  createdAt: now,
                },
              ],
            }),
          )
        ).refusal,
      ).toContain("already another thread's");
      const guest = await apply(
        await seeded(),
        importFor(CHILD_HERE, { worktreeOrigin: { kind: "thread", threadId: PARENT_HERE } }),
      );
      expect(guest.refusal).toBeNull();
      expect(threadOf(guest.model, CHILD_HERE).worktreeOrigin).toEqual({
        kind: "thread",
        threadId: PARENT_HERE,
      });
    });
  });
});

describe("across the link: a child alone, and a thread going home (Part 3f, (h))", () => {
  const CHILD = ThreadId.make("thread-lone-child");
  const CHILD_REQUEST = ThreadMoveRequestId.make("request-lone-child");
  const CHILD_TRANSFER = ThreadMoveId.make("transfer-lone-child");
  const THERE = ThreadId.make("thread-there");
  const TAKES: ThreadMoveTakes = { threadState: true, families: true, linkLineage: true };
  const OLD_TAKES: ThreadMoveTakes = { threadState: true, families: true };
  const THIRD = { environmentId: EnvironmentId.make("environment-third"), label: "Linux box" };
  const PARENT_TURN = TurnId.make("turn-parent");

  const withChild = async (model: OrchestrationReadModel) =>
    (
      await apply(model, {
        type: "thread.create",
        commandId: nextCommandId(),
        threadId: CHILD,
        projectId: PROJECT,
        title: "Fix tests",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: null,
        worktreePath: `/worktrees/${CHILD}`,
        parentThreadId: THREAD,
        attachedToParent: true,
        createdAt: now,
      } as OrchestrationCommand)
    ).model;
  const queueFor = (
    threadId: ThreadId,
    takes: ThreadMoveTakes = TAKES,
    target: { readonly environmentId: EnvironmentId; readonly label: string } = MAC_MINI,
  ): OrchestrationCommand => ({
    type: "thread.move.queue",
    commandId: nextCommandId(),
    threadId,
    requestId: CHILD_REQUEST,
    target,
    agent: modelSelection,
    mode: "when-done",
    requestedBy: { kind: "user" },
    targetTakes: takes,
    createdAt: now,
  });
  /** Queued, quiesced and frozen: the child alone on its way to Mac mini. */
  const movedAlone = async (model: OrchestrationReadModel) => {
    let next = (await apply(model, queueFor(CHILD))).model;
    next = (
      await apply(next, {
        type: "thread.move.quiesce",
        commandId: nextCommandId(),
        threadId: CHILD,
        requestId: CHILD_REQUEST,
        createdAt: now,
      })
    ).model;
    const started = await apply(next, {
      type: "thread.move.start",
      commandId: nextCommandId(),
      threadId: CHILD,
      transferId: CHILD_TRANSFER,
      target: MAC_MINI,
      agent: modelSelection,
      queuedRequestId: CHILD_REQUEST,
      targetTakes: TAKES,
      createdAt: now,
    });
    expect(started.refusal).toBeNull();
    return started.model;
  };
  const complete = (keptParent: boolean): OrchestrationCommand => ({
    type: "thread.move.complete",
    commandId: nextCommandId(),
    threadId: CHILD,
    transferId: CHILD_TRANSFER,
    movedThreadId: THERE,
    ...(keptParent ? { keptParent: true as const } : {}),
    createdAt: now,
  });
  /** The parent's agent at work in its turn, so it can send to its threads. */
  const parentWorking = (model: OrchestrationReadModel) =>
    project(model, "thread.session-set", {
      threadId: THREAD,
      session: {
        threadId: THREAD,
        status: "running",
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: PARENT_TURN,
        lastError: null,
        updatedAt: now,
      },
    });
  const sendTo = (childThreadId: ThreadId, requestId: ChildRequestId): OrchestrationCommand => ({
    type: "thread.child.send",
    commandId: nextCommandId(),
    threadId: THREAD,
    requestId,
    from: { participantId: null },
    callerTurnId: PARENT_TURN,
    childThreadId,
    childMessageId: MessageId.make(`m-${requestId}`),
    text: "Run the tests again",
    createdAt: now,
  });
  /** The parent asked its child something before it moved; the answer is owed. */
  const asked = (model: OrchestrationReadModel) =>
    project(model, "thread.child-request-submitted", {
      threadId: THREAD,
      request: {
        requestId: ChildRequestId.make("ask-before"),
        batchId: ChildRequestBatchId.make("ask-before"),
        kind: "send",
        from: { participantId: null },
        callerTurnId: PARENT_TURN,
        deliveryEpoch: 0,
        status: "awaiting_background",
        childThreadId: CHILD,
        childMessageId: MessageId.make("m-ask-before"),
        createdAt: now,
      },
      createdAt: now,
    });

  it("a child moves on its own only through the queue, to a computer that keeps it its parent's", async () => {
    const model = await withChild(await seeded());
    expect((await apply(model, queueFor(CHILD, OLD_TAKES))).refusal).toContain(
      "moves with the thread that started it",
    );
    // A move that doesn't wait never crosses the link.
    expect(
      (await apply(model, { ...startMove(CHILD), targetTakes: TAKES } as OrchestrationCommand))
        .refusal,
    ).toContain("belongs to the thread that started it");
    const queued = await apply(model, queueFor(CHILD));
    expect(queued.refusal).toBeNull();
    expect(threadOf(queued.model, CHILD).pendingMove?.family).toBeUndefined();
  });

  it("the parent keeps a child that moved alone as its thread there, reaches it, and hears its answer", async () => {
    let model = await movedAlone(await asked(await parentWorking(await withChild(await seeded()))));
    // Its frozen copy here takes no message: it would never reach it.
    expect((await apply(model, sendTo(CHILD, ChildRequestId.make("r-frozen")))).refusal).toContain(
      "moving to Mac mini",
    );
    ({ model } = await apply(model, complete(true)));
    const copy = threadOf(model, CHILD);
    expect(copy.attachedToParent).toBe(false);
    expect(copy.activities.at(-1)).toMatchObject({
      kind: "thread.moved-alone",
      summary: "It's still a thread of 'Fix the flaky test', which reaches it on Mac mini.",
    });
    const parent = threadOf(model);
    expect(parent.childRequests.remoteChildren).toEqual([
      expect.objectContaining({
        environmentId: MAC_MINI.environmentId,
        label: "Mac mini",
        threadId: THERE,
        title: "Fix tests",
        attachmentEpoch: 0,
      }),
    ]);
    // What it was asked here won't come back from here: the agent is told.
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.pendingNotes.at(-1)?.text).toContain(
      "moved to Mac mini before it answered",
    );
    // thread_send reaches it over the link now.
    const ask = ChildRequestId.make("r-there");
    ({ model } = await apply(model, sendTo(THERE, ask)));
    expect(threadOf(model).childRequests.open).toEqual([
      expect.objectContaining({
        requestId: ask,
        childThreadId: THERE,
        remote: expect.objectContaining({
          environmentId: MAC_MINI.environmentId,
          label: "Mac mini",
          threadId: THERE,
        }),
      }),
    ]);
    // And its answer comes back into the parent.
    const answered = await apply(model, {
      type: "thread.child-request.settle",
      commandId: nextCommandId(),
      threadId: THREAD,
      requestId: ask,
      outcome: "answered",
      reply: { messageId: MessageId.make("m-answer"), text: "All green", turnId: null },
      createdAt: now,
    });
    expect(answered.refusal).toBeNull();
    expect(threadOf(answered.model).messages.at(-1)).toMatchObject({
      text: "All green",
      fromThread: { threadId: THERE, environmentId: MAC_MINI.environmentId, kind: "report" },
    });
  });

  it("a child that arrived as its own thread there leaves the family, and nothing records it there", async () => {
    let model = await movedAlone(await withChild(await seeded()));
    ({ model } = await apply(model, complete(false)));
    expect(threadOf(model, CHILD).attachedToParent).toBe(false);
    expect(threadOf(model, CHILD).activities.at(-1)?.summary).toBe(
      "It's its own thread on Mac mini, so the thread that started it can't reach it there.",
    );
    expect(threadOf(model).childRequests.remoteChildren ?? []).toEqual([]);
  });

  describe("a parent and its child moving alone never cross", () => {
    const PARENT_REQUEST = ThreadMoveRequestId.make("request-parent-after");
    const PARENT_TRANSFER = ThreadMoveId.make("transfer-parent-after");
    const parentStep = (
      type: "thread.move.queue" | "thread.move.quiesce" | "thread.move.start",
    ): OrchestrationCommand =>
      (type === "thread.move.queue"
        ? {
            type,
            commandId: nextCommandId(),
            threadId: THREAD,
            requestId: PARENT_REQUEST,
            target: MAC_MINI,
            agent: modelSelection,
            mode: "when-done",
            requestedBy: { kind: "user" },
            targetTakes: TAKES,
            createdAt: now,
          }
        : type === "thread.move.quiesce"
          ? {
              type,
              commandId: nextCommandId(),
              threadId: THREAD,
              requestId: PARENT_REQUEST,
              createdAt: now,
            }
          : {
              type,
              commandId: nextCommandId(),
              threadId: THREAD,
              transferId: PARENT_TRANSFER,
              target: MAC_MINI,
              agent: modelSelection,
              queuedRequestId: PARENT_REQUEST,
              targetTakes: TAKES,
              createdAt: now,
            }) as OrchestrationCommand;

    it("a parent queued while its child moves alone waits for it, and goes once it settled", async () => {
      let model = await movedAlone(await withChild(await seeded()));
      const queued = await apply(model, parentStep("thread.move.queue"));
      expect(queued.refusal).toBeNull();
      model = queued.model;
      expect(threadOf(model).pendingMove?.waitsFor).toContainEqual({
        code: "background",
        words: "when 'Fix tests' finishes moving",
      });
      // Not stopped, nor frozen, while the child is under way: the freeze checks again.
      expect((await apply(model, parentStep("thread.move.quiesce"))).refusal).toContain(
        "Wait for this thread to finish",
      );
      ({ model } = await apply(model, complete(true)));
      ({ model } = await apply(model, parentStep("thread.move.quiesce")));
      const started = await apply(model, parentStep("thread.move.start"));
      expect(started.refusal).toBeNull();
      expect(threadOf(started.model).move?.transferId).toBe(PARENT_TRANSFER);
    });

    /** The child works in its parent's folder; the parent has a message of the user's queued. */
    const sharingWithQueuedMessage = async () => {
      let model = await withChild(await seeded());
      model = await project(model, "thread.meta-updated", {
        threadId: CHILD,
        worktreePath: "/worktrees/fix-flaky",
        updatedAt: now,
      });
      return project(model, "thread.follow-up-queued", {
        threadId: THREAD,
        followUp: {
          messageId: MessageId.make("m-parent-queued"),
          text: "And the docs",
          attachments: [],
          runtimeMode: "auto",
          interactionMode: "default",
          createdAt: now,
        },
      });
    };
    /** The model with the parent changed as `patch` says (what the projection would hold). */
    const withParent = (model: OrchestrationReadModel, patch: Record<string, unknown>) => ({
      ...model,
      threads: model.threads.map((thread) =>
        thread.id === THREAD ? ({ ...thread, ...patch } as unknown as typeof thread) : thread,
      ),
    });
    const sharedCheckoutWait = (model: OrchestrationReadModel) =>
      threadMoveRefusals(model, threadOf(model, CHILD), TAKES).filter(
        (entry) => entry.code === "shared_checkout",
      );

    it("sharing a folder, the child still waits for what the parent really runs there", async () => {
      let model = await sharingWithQueuedMessage();
      ({ model } = await apply(model, queueFor(CHILD)));
      ({ model } = await apply(model, parentStep("thread.move.queue")));
      expect(sharedCheckoutWait(model)).toEqual([]);
      // A command the parent runs in the terminal still changes the folder.
      const commandRunning = withParent(model, {
        commandRuns: [{ runId: "run-1", status: "running", source: { kind: "user" } }],
      });
      expect(sharedCheckoutWait(commandRunning)).toHaveLength(1);
      expect(
        (
          await apply(commandRunning, {
            type: "thread.move.quiesce",
            commandId: nextCommandId(),
            threadId: CHILD,
            requestId: CHILD_REQUEST,
            createdAt: now,
          })
        ).refusal,
      ).toContain("finish");
      // So does background work its agent didn't wait on.
      const backgroundWork = withParent(model, {
        session: {
          threadId: THREAD,
          status: "ready",
          providerName: "codex",
          runtimeMode: "auto",
          activeTurnId: null,
          lastError: null,
          pendingBackgroundTaskCount: 1,
          awaitedBackgroundTaskCount: 0,
          updatedAt: now,
        },
      });
      expect(sharedCheckoutWait(backgroundWork)).toHaveLength(1);
    });

    it("sharing a folder, a child moving alone doesn't wait for the parent's message its own move holds", async () => {
      let model = await sharingWithQueuedMessage();
      ({ model } = await apply(model, queueFor(CHILD)));
      // While the parent can still send it, the child waits for it.
      expect(threadMoveRefusals(model, threadOf(model, CHILD), TAKES)).toContainEqual(
        expect.objectContaining({ code: "shared_checkout" }),
      );
      // The parent queues its move, which holds that message and waits for the child.
      ({ model } = await apply(model, parentStep("thread.move.queue")));
      expect(threadOf(model).pendingMove?.waitsFor).toContainEqual(
        expect.objectContaining({ words: "when 'Fix tests' finishes moving" }),
      );
      // So the child no longer waits for it: one of them goes.
      expect(threadMoveRefusals(model, threadOf(model, CHILD), TAKES)).toEqual([]);
      ({ model } = await apply(model, {
        type: "thread.move.quiesce",
        commandId: nextCommandId(),
        threadId: CHILD,
        requestId: CHILD_REQUEST,
        createdAt: now,
      }));
      expect(
        (
          await apply(model, {
            type: "thread.move.start",
            commandId: nextCommandId(),
            threadId: CHILD,
            transferId: CHILD_TRANSFER,
            target: MAC_MINI,
            agent: modelSelection,
            queuedRequestId: CHILD_REQUEST,
            targetTakes: TAKES,
            createdAt: now,
          })
        ).refusal,
      ).toBeNull();
    });

    it("a child doesn't start moving alone while its parent moves", async () => {
      // The parent queued first: the child isn't queued alone.
      let model = (await apply(await withChild(await seeded()), parentStep("thread.move.queue")))
        .model;
      expect((await apply(model, queueFor(CHILD))).refusal).toContain(
        "The thread that started it is moving to Mac mini",
      );
      // The child queued first and the parent froze anyway (a race): the
      // child's own freeze checks again and refuses.
      model = (await apply(await withChild(await seeded()), queueFor(CHILD))).model;
      model = (
        await apply(model, {
          type: "thread.move.quiesce",
          commandId: nextCommandId(),
          threadId: CHILD,
          requestId: CHILD_REQUEST,
          createdAt: now,
        })
      ).model;
      model = await project(model, "thread.move-started", {
        threadId: THREAD,
        transferId: PARENT_TRANSFER,
        target: MAC_MINI,
        agent: modelSelection,
        startedAt: now,
      });
      expect(
        (
          await apply(model, {
            type: "thread.move.start",
            commandId: nextCommandId(),
            threadId: CHILD,
            transferId: CHILD_TRANSFER,
            target: MAC_MINI,
            agent: modelSelection,
            queuedRequestId: CHILD_REQUEST,
            targetTakes: TAKES,
            createdAt: now,
          })
        ).refusal,
      ).toContain("The thread that started it is moving to Mac mini");
    });
  });

  describe("a thread another computer's agent started", () => {
    const origin = (environmentPinned = true) => ({
      linkDeviceId: "device-mac-mini",
      environmentId: MAC_MINI.environmentId,
      environmentPinned,
      environmentLabel: "Mac mini",
      threadId: ThreadId.make("thread-on-mac"),
      threadTitle: "Ship it",
    });
    const startedThere = async (environmentPinned = true) =>
      (
        await apply(await seeded(), {
          type: "thread.create",
          commandId: nextCommandId(),
          threadId: CHILD,
          projectId: PROJECT,
          title: "Fix tests",
          modelSelection,
          runtimeMode: "auto",
          interactionMode: "default",
          branch: null,
          worktreePath: `/worktrees/${CHILD}`,
          remoteOrigin: origin(environmentPinned),
          createdAt: now,
        } as OrchestrationCommand)
      ).model;

    it("moves only back to that computer, over a link that proved it, never to a third", async () => {
      const model = await startedThere();
      expect((await apply(model, queueFor(CHILD, TAKES, THIRD))).refusal).toContain(
        "This thread was started by an agent on Mac mini, which still directs it. It can move back to Mac mini, not to another computer.",
      );
      expect((await apply(model, queueFor(CHILD, OLD_TAKES))).refusal).toContain(
        "Update Threadlines on Mac mini",
      );
      expect((await apply(await startedThere(false), queueFor(CHILD))).refusal).toContain(
        "can't confirm which computer that is",
      );
      // The dialog asks about any computer: only the proof counts there.
      expect(
        threadMoveRefusals(model, threadOf(model, CHILD), TAKES, undefined, null).filter(
          (entry) => entry.code === "remote_origin",
        ),
      ).toEqual([]);
      const home = await apply(model, queueFor(CHILD));
      expect(home.refusal).toBeNull();
      // A move that doesn't wait never goes home either.
      expect(
        (await apply(model, { ...startMove(CHILD), targetTakes: TAKES } as OrchestrationCommand))
          .refusal,
      ).toContain("This thread was started by an agent on Mac mini");
    });
  });

  describe("arriving", () => {
    const ARRIVED = ThreadId.make("thread-arrived-alone");
    const SOURCE = ThreadId.make("thread-on-mac");
    const importFrom = (
      from: { readonly environmentId: EnvironmentId; readonly label: string },
      extra: Record<string, unknown> = {},
    ): OrchestrationCommand =>
      ({
        type: "thread.import",
        commandId: nextCommandId(),
        threadId: ARRIVED,
        projectId: PROJECT,
        title: "Fix tests",
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "fix/tests",
        worktreePath: `/worktrees/${ARRIVED}`,
        movedFrom: { ...from, threadId: SOURCE, movedAt: now },
        messages: [],
        activities: [],
        createdAt: now,
        ...extra,
      }) as OrchestrationCommand;
    const remoteOrigin = {
      linkDeviceId: "device-mac-mini",
      environmentId: MAC_MINI.environmentId,
      environmentPinned: true,
      environmentLabel: "Mac mini",
      threadId: ThreadId.make("thread-parent-on-mac"),
      threadTitle: "Ship it",
    };
    const personSends = (threadId: ThreadId): OrchestrationCommand =>
      ({
        type: "thread.turn.start",
        commandId: nextCommandId(),
        threadId,
        message: {
          messageId: MessageId.make("m-person"),
          role: "user",
          text: "Go",
          attachments: [],
        },
        sentFrom: { kind: "computer", place: "here" },
        runtimeMode: "auto",
        interactionMode: "default",
        createdAt: now,
      }) as OrchestrationCommand;
    /** This computer's thread, which started SOURCE on Mac mini and still holds it there. */
    const holding = async (
      model: OrchestrationReadModel,
      record: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } = {
        environmentId: MAC_MINI.environmentId,
        threadId: SOURCE,
      },
    ) => {
      let next = await project(model, "thread.remote-child-updated", {
        threadId: THREAD,
        child: {
          ...record,
          label: "Mac mini",
          handle: "Agent",
          title: "Fix tests",
          attachmentEpoch: 0,
          cachedStatus: "idle",
          updatedAt: now,
        },
        updatedAt: now,
      });
      next = await project(next, "thread.child-request-submitted", {
        threadId: THREAD,
        request: {
          requestId: ChildRequestId.make("ask-there"),
          batchId: ChildRequestBatchId.make("ask-there"),
          kind: "send",
          from: { participantId: null },
          callerTurnId: TurnId.make("turn-ask"),
          deliveryEpoch: 0,
          status: "running",
          childThreadId: record.threadId,
          childMessageId: MessageId.make("m-ask-there"),
          text: "Check this",
          remote: { ...MAC_MINI, threadId: record.threadId, status: "accepted" },
          createdAt: now,
        },
        createdAt: now,
      });
      return next;
    };

    it("a child that came alone stays its parent's, fenced for good: a person's message doesn't lift it", async () => {
      let { model, refusal } = await apply(await seeded(), importFrom(MAC_MINI, { remoteOrigin }));
      expect(refusal).toBeNull();
      const arrived = threadOf(model, ARRIVED);
      expect(arrived.remoteOrigin).toEqual(remoteOrigin);
      expect(arrived.parentThreadId).toBeNull();
      expect(arrived.movedFrom?.fenced).toBe(true);
      expect(arrived.activities.at(-1)?.payload).toMatchObject({
        left: [
          "Started by 'Ship it' on Mac mini, which still directs it. Its agent can't use other threads, rooms or schedules here.",
        ],
      });
      ({ model } = await apply(model, personSends(ARRIVED)));
      expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBe(true);
      expect(isLinkFenced(threadOf(model, ARRIVED))).toBe(true);
    });

    it("never keeps a parent a link can't prove, on another computer, or alongside a family", async () => {
      const model = await seeded();
      expect(
        (
          await apply(
            model,
            importFrom(MAC_MINI, { remoteOrigin: { ...remoteOrigin, environmentPinned: false } }),
          )
        ).refusal,
      ).toContain("proved its computer");
      // Forged: an identity other than the computer the move came from.
      expect(
        (
          await apply(
            model,
            importFrom(MAC_MINI, {
              remoteOrigin: { ...remoteOrigin, environmentId: THIRD.environmentId },
            }),
          )
        ).refusal,
      ).toContain("computer it came from");
      expect(
        (
          await apply(model, {
            ...importFrom(MAC_MINI, { remoteOrigin }),
            movedFrom: { ...MAC_MINI, threadId: SOURCE, movedAt: now, familyKey: "family-key" },
          } as OrchestrationCommand)
        ).refusal,
      ).toContain("moves on its own");
      expect(
        (
          await apply(
            model,
            importFrom(MAC_MINI, { remoteOrigin, adopt: { parentThreadId: THREAD } }),
          )
        ).refusal,
      ).toContain("one parent");
    });

    it("comes home under its parent only when that parent holds exactly this thread there", async () => {
      const base = await holding(await seeded());
      const adopt = { adopt: { parentThreadId: THREAD } };
      // A forged home: this computer's thread never started that one.
      expect(
        (
          await apply(base, {
            ...importFrom(MAC_MINI, adopt),
            movedFrom: { ...MAC_MINI, threadId: ThreadId.make("thread-forged"), movedAt: now },
          } as OrchestrationCommand)
        ).refusal,
      ).toContain("doesn't hold this thread");
      // The same thread id, claimed over another computer's link.
      expect((await apply(base, importFrom(THIRD, adopt))).refusal).toContain(
        "doesn't hold this thread",
      );
      // Never under a thread that isn't a top-level thread here, or that is moving.
      const childHere = await withChild(base);
      expect(
        (await apply(childHere, importFrom(MAC_MINI, { adopt: { parentThreadId: CHILD } })))
          .refusal,
      ).toContain("itself another thread's");
      expect(
        (await apply((await apply(base, queueFor(THREAD))).model, importFrom(MAC_MINI, adopt)))
          .refusal,
      ).toContain("is moving");

      let { model, refusal } = await apply(base, importFrom(MAC_MINI, adopt));
      expect(refusal).toBeNull();
      const home = threadOf(model, ARRIVED);
      expect(home).toMatchObject({ parentThreadId: THREAD, attachedToParent: true });
      expect(home.remoteOrigin ?? null).toBeNull();
      expect(home.movedFrom?.fenced).toBe(true);
      const parent = threadOf(model);
      expect(parent.childRequests.remoteChildren ?? []).toEqual([]);
      expect(parent.childRequests.open).toEqual([]);
      expect(parent.childRequests.pendingNotes.at(-1)?.text).toContain(
        "moved back to this computer before it answered from Mac mini",
      );
      // Home is where the permission came from: the user here may take it over.
      ({ model } = await apply(model, personSends(ARRIVED)));
      expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBeUndefined();
    });

    it("back home and still fenced, it goes nowhere but where it came from until a person writes", async () => {
      let { model } = await apply(
        await holding(await seeded()),
        importFrom(MAC_MINI, { adopt: { parentThreadId: THREAD } }),
      );
      // Alone, or as any thread: never on to a third computer while fenced.
      expect((await apply(model, queueFor(ARRIVED, TAKES, THIRD))).refusal).toBe(
        "Orchestration command invariant failed (thread.move.queue): This thread moved here from Mac mini, and until you send it a message here it can only move back to Mac mini.",
      );
      expect((await apply(model, queueFor(ARRIVED, TAKES))).refusal).toBeNull();
      // A person here takes it over: the usual rules hold from now on.
      ({ model } = await apply(model, personSends(ARRIVED)));
      expect(threadOf(model, ARRIVED).movedFrom?.fenced).toBeUndefined();
      // Its turn is something to wait for, never a refusal.
      expect(
        threadMoveRefusals(model, threadOf(model, ARRIVED), TAKES, undefined, THIRD).filter(
          (entry) => entry.kind === "blocked",
        ),
      ).toEqual([]);
    });
  });
});
