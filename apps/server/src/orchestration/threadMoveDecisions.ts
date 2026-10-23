/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3): the
 * decider's side. On the computer a thread leaves, `thread.move.start`
 * freezes it, the move's steps record how far it got, and it either
 * unfreezes (the other computer confirmed the move was dropped) or stays
 * read-only for good (`thread.moved-away`). On the computer it arrives at,
 * `thread.import` creates it with its whole history in one decision, so the
 * thread existing is the move's commit. Each function returns the events to
 * plan, or a refusal to report.
 */
import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
} from "@threadlines/contracts";
import { threadPullRequestAutomationArmed } from "@threadlines/shared/linkedPullRequests";
import { isRoomThread } from "@threadlines/shared/threadParticipants";

import { childHasLiveWork } from "./childThreadDecisions.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = (threadId: ThreadId) => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;

/** Events to plan, or why the command is refused. */
export type ThreadMoveDecision = ReadonlyArray<PlannedEvent> | { readonly refusal: string };

const refuse = (refusal: string) => ({ refusal });

/**
 * Why `thread` can't move right now, in words for the user, or null when it
 * can. The same check runs in `moves.preview` (so the dialog explains before
 * anyone clicks) and in the freeze decision.
 */
export function threadMoveRefusal(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): string | null {
  if (thread.deletedAt !== null) return "This thread was deleted.";
  if (thread.archivedAt !== null) return "Archived threads can't move. Unarchive it first.";
  if ((thread.move ?? null) !== null) {
    return thread.move?.movedAway !== undefined
      ? `This thread already moved to ${thread.move.target.label}.`
      : `This thread is already moving to ${thread.move?.target.label}.`;
  }
  const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
  if (project?.kind === "general-chat") return "General chats can't move yet.";
  if (isRoomThread(thread) || thread.agentRequests.open.length > 0) {
    return "Threads with more than one agent can't move yet.";
  }
  if ((thread.remoteOrigin ?? null) !== null) {
    return "This thread was started from another computer, so it stays here.";
  }
  if (thread.parentThreadId !== null && thread.attachedToParent) {
    return "This thread belongs to the thread that started it. Make it its own thread first.";
  }
  const hasLocalChildren = readModel.threads.some(
    (candidate) =>
      candidate.parentThreadId === thread.id &&
      candidate.attachedToParent &&
      candidate.deletedAt === null,
  );
  if (hasLocalChildren || (thread.childRequests.remoteChildren ?? []).length > 0) {
    return "Threads that started other threads can't move yet.";
  }
  const session = thread.session;
  if (
    childHasLiveWork(thread) ||
    (session?.pendingBackgroundTaskCount ?? 0) > 0 ||
    (session?.awaitedBackgroundTaskCount ?? 0) > 0
  ) {
    return "Wait for this thread to finish what it's doing, then move it.";
  }
  if (thread.goal !== null && thread.goal.status !== "complete") {
    return "This thread has a goal set. Clear it first.";
  }
  if ((thread.checkBacks ?? []).length > 0) {
    return "This thread's agent set itself a time to come back. Cancel it first.";
  }
  if (
    (thread.commandRuns ?? []).some((run) =>
      ["starting", "running", "waiting", "submitted"].includes(run.status),
    ) ||
    (thread.workflowRuns ?? []).some((run) => run.status === "running") ||
    thread.voiceActive === true
  ) {
    return "Wait for this thread to finish what it's doing, then move it.";
  }
  const runRequestIds = new Set(
    (thread.commandRuns ?? []).flatMap((run) =>
      run.source.kind === "request" ? [run.source.requestId] : [],
    ),
  );
  if (
    (thread.commandRequests ?? []).some(
      (request) => request.dismissedAt === null && !runRequestIds.has(request.requestId),
    )
  ) {
    return "A command in this thread is waiting for you to run or dismiss it. Do that first.";
  }
  if (threadPullRequestAutomationArmed(thread)) {
    return "Turn off pull request auto-fix and auto-merge for this thread first.";
  }
  // Another thread at work in the same checkout could change the files while
  // they are being packed.
  const checkout = thread.worktreePath ?? project?.workspaceRoot ?? null;
  const sharedCheckoutBusy = readModel.threads.some(
    (candidate) =>
      candidate.id !== thread.id &&
      candidate.deletedAt === null &&
      (candidate.worktreePath ??
        readModel.projects.find((entry) => entry.id === candidate.projectId)?.workspaceRoot ??
        null) === checkout &&
      childHasLiveWork(candidate),
  );
  if (sharedCheckoutBusy) {
    return "Another thread is working in the same folder. Wait for it to finish, then move this one.";
  }
  return null;
}

/**
 * Commands a moving or moved thread still takes: filing it away (archive,
 * unarchive, delete, pin), the server's own bookkeeping that can't change
 * what moves, and the move's own steps. Everything else is refused
 * (`threadMoveGuardRefusal`). A move under way runs on whether the thread
 * is archived or not; deleting it mid-move drops the move on the other
 * computer, unless it already arrived there.
 */
const FROZEN_THREAD_COMMANDS: ReadonlySet<OrchestrationCommand["type"]> = new Set([
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.pin",
  "thread.unpin",
  "thread.done-override.set",
  "thread.seen.set",
  "thread.session.set",
  "thread.activity.append",
  "thread.effective-cwd.set",
  "thread.check-backs.set",
  "thread.pull-request.link",
  "thread.diffstat.rebase",
  "thread.realtime.state.set",
  "thread.move.progress",
  "thread.move.cancel",
  "thread.move.abort",
  "thread.move.complete",
]);

/** The words for a frozen thread, from the move it's under. */
function frozenWords(thread: OrchestrationThread): string {
  const label = thread.move?.target.label ?? "another computer";
  return thread.move?.movedAway !== undefined
    ? `This thread moved to ${label}. Continue it there.`
    : `This thread is moving to ${label}. Wait for the move to finish, or cancel it.`;
}

/**
 * Why `command` must not touch a moving or moved thread, or null. Covers the
 * thread the command is for and a parent it would attach a thread to; a fork
 * only reads its source, so it stays allowed (it is the honest way to keep
 * working here).
 */
export function threadMoveGuardRefusal(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): string | null {
  const frozen = (threadId: ThreadId | null | undefined) => {
    if (threadId === null || threadId === undefined) return null;
    const thread = readModel.threads.find((candidate) => candidate.id === threadId);
    return thread !== undefined && (thread.move ?? null) !== null ? thread : null;
  };
  if ("threadId" in command && command.type !== "thread.import") {
    const thread = frozen(command.threadId);
    if (thread !== null && !FROZEN_THREAD_COMMANDS.has(command.type)) {
      return frozenWords(thread);
    }
  }
  if (command.type === "thread.create") {
    const parent = frozen(command.parentThreadId);
    if (parent !== null) return frozenWords(parent);
  }
  if (command.type === "thread.parent-attachment.set" && command.attached) {
    const child = readModel.threads.find((candidate) => candidate.id === command.threadId);
    const parent = frozen(child?.parentThreadId);
    if (parent !== null) return frozenWords(parent);
  }
  return null;
}

/** The freeze: the thread now moves, and its session stops so nothing can start a turn. */
export function decideMoveStart(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.start">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const refusal = threadMoveRefusal(readModel, thread);
  if (refusal !== null) return refuse(refusal);
  const started: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.move-started",
    payload: {
      threadId: thread.id,
      transferId: command.transferId,
      target: command.target,
      agent: command.agent,
      startedAt: command.createdAt,
    },
  };
  if (thread.session === null || thread.session.status === "stopped") return [started];
  return [
    started,
    {
      ...baseFor(thread.id),
      type: "thread.session-stop-requested",
      payload: { threadId: thread.id, createdAt: command.createdAt },
    },
  ];
}

/** The move named by `transferId`, when it is the thread's current one and still under way. */
function currentMove(thread: OrchestrationThread, transferId: string) {
  const move = thread.move ?? null;
  return move !== null && move.transferId === transferId ? move : null;
}

export function decideMoveProgress(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.progress">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const move = currentMove(thread, command.transferId);
  // A late report from a move already settled is no news.
  if (move === null || move.movedAway !== undefined) return [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-progressed",
      payload: {
        threadId: thread.id,
        transferId: command.transferId,
        phase: command.phase,
        ...(command.sentBytes !== undefined ? { sentBytes: command.sentBytes } : {}),
        ...(command.totalBytes !== undefined ? { totalBytes: command.totalBytes } : {}),
        updatedAt: command.createdAt,
      },
    },
  ];
}

export function decideMoveCancel(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.cancel">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const move = currentMove(thread, command.transferId);
  if (move === null) return refuse("This thread isn't moving.");
  if (move.movedAway !== undefined) {
    return refuse(`This thread already moved to ${move.target.label}.`);
  }
  if (move.cancelRequested) return [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-cancel-requested",
      payload: {
        threadId: thread.id,
        transferId: command.transferId,
        updatedAt: command.createdAt,
      },
    },
  ];
}

/** The other computer confirmed the move was dropped: the thread unfreezes, and says why. */
export function decideMoveAbort(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.abort">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const move = currentMove(thread, command.transferId);
  if (move === null) return [];
  if (move.movedAway !== undefined) {
    return refuse(`This thread already moved to ${move.target.label}; the move can't be undone.`);
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-aborted",
      payload: {
        threadId: thread.id,
        transferId: command.transferId,
        reason: command.reason,
        updatedAt: command.createdAt,
      },
    },
    {
      ...baseFor(thread.id),
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity: {
          id: EventId.make(`move-failed:${command.transferId}`),
          tone: "error",
          kind: "thread.move-failed",
          summary: `Couldn't move to ${move.target.label}`,
          payload: { targetLabel: move.target.label, reason: command.reason },
          turnId: null,
          createdAt: command.createdAt,
        },
      },
    },
  ];
}

export function decideMoveComplete(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.complete">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const move = currentMove(thread, command.transferId);
  if (move === null) return refuse("This thread isn't moving.");
  if (move.movedAway !== undefined) return [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.moved-away",
      payload: {
        threadId: thread.id,
        transferId: command.transferId,
        movedThreadId: command.movedThreadId,
        movedAt: command.createdAt,
      },
    },
  ];
}

/**
 * A moved thread arriving: created with its history and the boundary that
 * says where it came from, in one decision. Refused when the thread exists,
 * so a repeated import is no second copy.
 */
export function decideThreadImport(
  readModel: OrchestrationReadModel,
  command: CommandOf<"thread.import">,
  baseFor: EventBase,
): ThreadMoveDecision {
  if (readModel.threads.some((thread) => thread.id === command.threadId)) {
    return refuse(`Thread '${command.threadId}' already exists.`);
  }
  const project = readModel.projects.find((candidate) => candidate.id === command.projectId);
  if (project === undefined || project.deletedAt !== null) {
    return refuse(`Project '${command.projectId}' does not exist.`);
  }
  const base = () => baseFor(command.threadId);
  const created: PlannedEvent = {
    ...base(),
    type: "thread.created",
    payload: {
      threadId: command.threadId,
      projectId: command.projectId,
      title: command.title,
      modelSelection: command.modelSelection,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      branch: command.branch,
      worktreePath: command.worktreePath,
      movedFrom: command.movedFrom,
      historySeedOwed: true,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    },
  };
  const messages: PlannedEvent[] = command.messages.map((message) => ({
    ...base(),
    type: "thread.message-sent",
    payload: {
      threadId: command.threadId,
      messageId: message.messageId,
      role: message.role,
      text: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      turnId: message.turnId,
      streaming: false,
      imported: true as const,
      ...(message.completesTurn !== undefined ? { completesTurn: message.completesTurn } : {}),
      // Who wrote it there, not the agent it continues with here.
      ...(message.agentModels !== undefined ? { agentModels: message.agentModels } : {}),
      // An outside agent there: its name, for history; its connection was that computer's.
      ...(message.fromOutside !== undefined ? { fromOutside: message.fromOutside } : {}),
      ...(message.sentFrom !== undefined ? { sentFrom: message.sentFrom } : {}),
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    },
  }));
  const activities: PlannedEvent[] = command.activities.map((activity) => ({
    ...base(),
    type: "thread.activity-appended",
    payload: { threadId: command.threadId, activity: { ...activity, turnId: null } },
  }));
  const boundary: PlannedEvent = {
    ...base(),
    type: "thread.activity-appended",
    payload: {
      threadId: command.threadId,
      activity: {
        id: EventId.make(`moved-in:${command.threadId}`),
        tone: "info",
        kind: "thread.moved-in",
        summary: `Moved here from ${command.movedFrom.label}`,
        payload: {
          fromEnvironmentId: command.movedFrom.environmentId,
          fromLabel: command.movedFrom.label,
          fromThreadId: command.movedFrom.threadId,
          movedAt: command.movedFrom.movedAt,
        },
        turnId: null,
        createdAt: command.createdAt,
      },
    },
  };
  return [created, ...messages, ...activities, boundary];
}

export function decideHistorySeedDelivered(
  thread: OrchestrationThread,
  command: CommandOf<"thread.history-seed.delivered">,
  baseFor: EventBase,
): ThreadMoveDecision {
  // Recorded for any thread that moved here, owed or not as this read model
  // has it: the projections agree on where the conversation went.
  if ((thread.movedFrom ?? null) === null) return [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.history-seed-delivered",
      payload: { threadId: thread.id, messageId: command.messageId, updatedAt: command.createdAt },
    },
  ];
}
