/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3): the
 * decider's side. On the computer a thread leaves, `thread.move.start`
 * freezes it, the move's steps record how far it got, and it either
 * unfreezes (the other computer confirmed the move was dropped) or stays
 * read-only for good (`thread.moved-away`). On the computer it arrives at,
 * `thread.import` creates it with its whole history in one decision, so the
 * thread existing is the move's commit. A move can also wait for its thread
 * to be free (Part 3b): `thread.move.queue` records a pending move, the
 * guard keeps new work off the thread meanwhile, and the move queue's
 * `thread.move.start` ends the pending move as it freezes the thread. Each
 * function returns the events to plan, or a refusal to report.
 */
import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
  type ThreadMoveHold,
  ThreadMoveNotStartedActivityKind,
  type ThreadMoveNotStartedPayload,
  type ThreadMoveWait,
  type ThreadMoveWaitCode,
  type ThreadPendingMove,
} from "@threadlines/contracts";
import { threadPullRequestAutomationArmed } from "@threadlines/shared/linkedPullRequests";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  countPendingUserInputs,
} from "@threadlines/shared/pendingRequests";
import { isRoomThread } from "@threadlines/shared/threadParticipants";

import { childHasLiveWork } from "./childThreadDecisions.ts";
import {
  SETTINGS_CHANGE_CANCELLED,
  cancelWaitingSettingsChanges,
} from "./settingsChangeDecisions.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type EventBase = (threadId: ThreadId) => Omit<OrchestrationEvent, "sequence" | "type" | "payload">;
type CommandOf<Type extends OrchestrationCommand["type"]> = Extract<
  OrchestrationCommand,
  { readonly type: Type }
>;

/** Events to plan, or why the command is refused. */
export type ThreadMoveDecision = ReadonlyArray<PlannedEvent> | { readonly refusal: string };

const refuse = (refusal: string) => ({ refusal });

/** Something only the user can clear stops this thread from moving. */
export type ThreadMoveBlockCode =
  | "deleted"
  | "archived"
  | "moving"
  | "moved"
  | "general_chat"
  | "room"
  | "remote_origin"
  | "child"
  | "has_children"
  | "queued_messages"
  | "plan"
  | "goal"
  | "check_back"
  | "command_request"
  | "pull_request_automation";

/**
 * One reason a thread can't move right now. A `wait` goes away on its own
 * (the turn ends, the user answers); a `blocked` needs the user.
 */
export type ThreadMoveRefusalEntry =
  | { readonly kind: "wait"; readonly code: ThreadMoveWaitCode; readonly words: string }
  | { readonly kind: "blocked"; readonly code: ThreadMoveBlockCode; readonly words: string };

/** The words a wait finishes "Moves to <computer> …" with. */
const WAIT_WORDS: Record<ThreadMoveWaitCode, string> = {
  turn: "when this turn ends",
  approval: "once you answer",
  question: "once you answer",
  side_turn: "when its side answer finishes",
  background: "when its background work finishes",
  command_run: "when its command finishes running",
  workflow_run: "when its workflow finishes",
  voice: "when the voice chat ends",
  shared_checkout: "when the other thread working in its folder finishes",
};

const BUSY_WORDS = "Wait for this thread to finish what it's doing, then move it.";
const SHARED_CHECKOUT_WORDS =
  "Another thread is working in the same folder. Wait for it to finish, then move this one.";

const wait = (code: ThreadMoveWaitCode): ThreadMoveRefusalEntry => ({
  kind: "wait",
  code,
  words: WAIT_WORDS[code],
});
const blocked = (code: ThreadMoveBlockCode, words: string): ThreadMoveRefusalEntry => ({
  kind: "blocked",
  code,
  words,
});

/** What the move checks read: the projects, and the threads they can see. */
export interface ThreadMoveView {
  readonly projects: ReadonlyArray<
    Pick<OrchestrationReadModel["projects"][number], "id" | "kind" | "workspaceRoot">
  >;
  readonly threads: ReadonlyArray<OrchestrationThread>;
}

/** A thread's checkout: its worktree, else its project's folder. */
function checkoutOf(readModel: ThreadMoveView, thread: OrchestrationThread) {
  return (
    thread.worktreePath ??
    readModel.projects.find((entry) => entry.id === thread.projectId)?.workspaceRoot ??
    null
  );
}

/**
 * Every reason `thread` can't move right now (docs/design/fleet.md, Parts 3
 * and 3b), each as a `wait` or a `blocked` with words for the user. Every
 * check runs, so a busy thread doesn't hide a goal behind its running turn.
 * The same check runs in `moves.preview` (so the dialog explains before
 * anyone clicks), in `thread.move.queue`, and in the freeze decision. A
 * pending move isn't one of them: each caller decides about that itself.
 */
export function threadMoveRefusals(
  readModel: ThreadMoveView,
  thread: OrchestrationThread,
): ReadonlyArray<ThreadMoveRefusalEntry> {
  const found: ThreadMoveRefusalEntry[] = [];
  if (thread.deletedAt !== null) found.push(blocked("deleted", "This thread was deleted."));
  if (thread.archivedAt !== null) {
    found.push(blocked("archived", "Archived threads can't move. Unarchive it first."));
  }
  const move = thread.move ?? null;
  if (move !== null) {
    found.push(
      move.movedAway !== undefined
        ? blocked("moved", `This thread already moved to ${move.target.label}.`)
        : blocked("moving", `This thread is already moving to ${move.target.label}.`),
    );
  }
  const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
  if (project?.kind === "general-chat") {
    found.push(blocked("general_chat", "General chats can't move yet."));
  }
  if (isRoomThread(thread) || thread.agentRequests.open.length > 0) {
    found.push(blocked("room", "Threads with more than one agent can't move yet."));
  }
  if ((thread.remoteOrigin ?? null) !== null) {
    found.push(
      blocked("remote_origin", "This thread was started from another computer, so it stays here."),
    );
  }
  if (thread.parentThreadId !== null && thread.attachedToParent) {
    found.push(
      blocked(
        "child",
        "This thread belongs to the thread that started it. Make it its own thread first.",
      ),
    );
  }
  const hasLocalChildren = readModel.threads.some(
    (candidate) =>
      candidate.parentThreadId === thread.id &&
      candidate.attachedToParent &&
      candidate.deletedAt === null,
  );
  if (
    hasLocalChildren ||
    (thread.childRequests.remoteChildren ?? []).length > 0 ||
    thread.childRequests.open.length > 0
  ) {
    found.push(blocked("has_children", "Threads that started other threads can't move yet."));
  }
  // Queued follow-ups would start the next turn the moment this one ends.
  if ((thread.queuedFollowUps ?? []).length > 0) {
    found.push(blocked("queued_messages", "Send or remove your queued messages first."));
  }
  // Only the user's answer clears a plan, and implementing it starts a turn.
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (
    thread.proposedPlans.some(
      (plan) =>
        latestTurnId !== null &&
        plan.turnId === latestTurnId &&
        plan.implementedAt === null &&
        plan.dismissedAt === null,
    )
  ) {
    found.push(blocked("plan", "Implement or dismiss the plan first."));
  }
  if (thread.goal !== null && thread.goal.status !== "complete") {
    found.push(blocked("goal", "This thread has a goal set. Clear it first."));
  }
  if ((thread.checkBacks ?? []).length > 0) {
    found.push(
      blocked("check_back", "This thread's agent set itself a time to come back. Cancel it first."),
    );
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
    found.push(
      blocked(
        "command_request",
        "A command in this thread is waiting for you to run or dismiss it. Do that first.",
      ),
    );
  }
  if (threadPullRequestAutomationArmed(thread)) {
    found.push(
      blocked(
        "pull_request_automation",
        "Turn off pull request auto-fix and auto-merge for this thread first.",
      ),
    );
  }

  // What goes away on its own.
  const session = thread.session;
  if (
    thread.latestTurn?.state === "running" ||
    session?.status === "running" ||
    session?.status === "starting"
  ) {
    found.push(wait("turn"));
  }
  if (collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS).length > 0) {
    found.push(wait("approval"));
  }
  if (countPendingUserInputs(thread.activities).pendingUserInputCount > 0) {
    found.push(wait("question"));
  }
  if ((thread.sideTurn ?? null) !== null) found.push(wait("side_turn"));
  if (
    (session?.pendingBackgroundTaskCount ?? 0) > 0 ||
    (session?.awaitedBackgroundTaskCount ?? 0) > 0
  ) {
    found.push(wait("background"));
  }
  if (
    (thread.commandRuns ?? []).some((run) =>
      ["starting", "running", "waiting"].includes(run.status),
    )
  ) {
    found.push(wait("command_run"));
  }
  if ((thread.workflowRuns ?? []).some((run) => run.status === "running")) {
    found.push(wait("workflow_run"));
  }
  if (thread.voiceActive === true) found.push(wait("voice"));
  // Another thread at work in the same checkout could change the files while
  // they are being packed.
  const checkout = checkoutOf(readModel, thread);
  const sharedCheckoutBusy = readModel.threads.some(
    (candidate) =>
      candidate.id !== thread.id &&
      candidate.deletedAt === null &&
      checkoutOf(readModel, candidate) === checkout &&
      childHasLiveWork(candidate),
  );
  if (sharedCheckoutBusy) found.push(wait("shared_checkout"));
  return found;
}

/** The waits among a thread's move refusals, as clients see them. */
export function moveWaitsOf(
  refusals: ReadonlyArray<ThreadMoveRefusalEntry>,
): ReadonlyArray<ThreadMoveWait> {
  return refusals.flatMap((entry) =>
    entry.kind === "wait" ? [{ code: entry.code, words: entry.words }] : [],
  );
}

/** The first thing only the user can clear, or null. */
export function firstMoveBlock(refusals: ReadonlyArray<ThreadMoveRefusalEntry>) {
  return refusals.find((entry) => entry.kind === "blocked") ?? null;
}

/**
 * Why `thread` can't move straight away, in words for the user, or null when
 * it can: a move that doesn't wait (`moves.start`) refuses waits too.
 */
export function threadMoveRefusal(
  readModel: ThreadMoveView,
  thread: OrchestrationThread,
): string | null {
  const refusals = threadMoveRefusals(readModel, thread);
  const block = firstMoveBlock(refusals);
  if (block !== null) return block.words;
  const first = refusals[0];
  if (first === undefined) return null;
  return first.code === "shared_checkout" ? SHARED_CHECKOUT_WORDS : BUSY_WORDS;
}

/**
 * Commands a moving or moved thread still takes: filing it away (archive,
 * unarchive, delete, pin), the server's own bookkeeping that can't change
 * what moves (a settings change the user already accepted finishing), and
 * the move's own steps. Everything else is refused
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
  "thread.settings-change.settle",
  "thread.settings-change.report-device",
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
 * Commands that start work on a thread (docs/design/fleet.md, Part 3b, "The
 * guard"). A thread with a pending move refuses them, so the wait stays
 * short; what a running turn needs (approvals, answers, activity, session
 * updates, interrupt) still goes through. Some only start work in one form:
 * see `startsWork`.
 */
const WORK_START_COMMANDS: ReadonlySet<OrchestrationCommand["type"]> = new Set([
  "thread.turn.start",
  "thread.turn.retry",
  "thread.turn.resend",
  // Both steer and queue: "Send when done", outside assistants' queued
  // messages and scheduled runs into an existing thread all come this way.
  "thread.follow-up.submit",
  "thread.side-turn.start",
  "thread.realtime.start",
  "thread.command-run.start",
  "thread.goal.set",
  "thread.participant.add",
  "thread.context-compact.request",
  // A first send on a thread made without one.
  "thread.start",
  // A continue at the usage limit's reset is a turn the user didn't just ask for.
  "thread.continue-at-reset.fire",
  "thread.pull-request-automation.set",
  "thread.continue-at-reset.set",
]);

/** Whether `command`, on its own thread, starts work there. */
function startsWork(command: OrchestrationCommand): boolean {
  if (!WORK_START_COMMANDS.has(command.type)) return false;
  switch (command.type) {
    // Turning a switch off is always allowed.
    case "thread.pull-request-automation.set":
      return (
        command.autoFix === true || (command.autoMerge !== undefined && command.autoMerge !== null)
      );
    case "thread.continue-at-reset.set":
      return command.enabled;
    default:
      return true;
  }
}

/** The words for a thread whose move waits. */
function pendingWords(thread: OrchestrationThread): string {
  const label = thread.pendingMove?.target.label ?? "another computer";
  return `This thread is waiting to move to ${label}. Cancel the move to keep working here.`;
}

/**
 * Why `command` must not touch a moving or moved thread, or start work on a
 * thread whose move waits, or null. Covers the thread the command is for and
 * a parent it would attach a thread to; a fork only reads its source, so it
 * stays allowed (it is the honest way to keep working here).
 */
export function threadMoveGuardRefusal(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): string | null {
  const find = (threadId: ThreadId | null | undefined) =>
    threadId === null || threadId === undefined
      ? undefined
      : readModel.threads.find((candidate) => candidate.id === threadId);
  /** Why the thread can't take a new child or attach one, or null. */
  const parentRefusal = (thread: OrchestrationThread | undefined) =>
    thread === undefined
      ? null
      : (thread.move ?? null) !== null
        ? frozenWords(thread)
        : (thread.pendingMove ?? null) !== null
          ? pendingWords(thread)
          : null;
  if ("threadId" in command && command.type !== "thread.import") {
    const thread = find(command.threadId);
    if (thread !== undefined && (thread.move ?? null) !== null) {
      if (!FROZEN_THREAD_COMMANDS.has(command.type)) return frozenWords(thread);
    } else if (
      thread !== undefined &&
      (thread.pendingMove ?? null) !== null &&
      startsWork(command)
    ) {
      return pendingWords(thread);
    }
  }
  if (command.type === "thread.create") {
    const refusal = parentRefusal(find(command.parentThreadId));
    if (refusal !== null) return refusal;
  }
  if (command.type === "thread.parent-attachment.set" && command.attached) {
    const refusal = parentRefusal(find(find(command.threadId)?.parentThreadId));
    if (refusal !== null) return refusal;
  }
  return null;
}

/** Whether the thread's agent has no session left, as projected. */
const sessionStopped = (thread: OrchestrationThread) =>
  thread.session === null || thread.session.status === "stopped";

/**
 * The freeze: the thread now moves, and its session stops so nothing can
 * start a turn. A move from the queue (`queuedRequestId`) must be the
 * thread's current queued move, and starts only once the thread is free and
 * its sessions are gone; its pending move ends in the same decision, so the
 * thread is never between the two.
 */
export function decideMoveStart(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.start">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = thread.pendingMove ?? null;
  const queuedRequestId = command.queuedRequestId;
  if (queuedRequestId === undefined) {
    if (pending !== null) {
      return refuse(`A move to ${pending.target.label} is already waiting. Cancel it first.`);
    }
    const refusal = threadMoveRefusal(readModel, thread);
    if (refusal !== null) return refuse(refusal);
  } else {
    if (pending === null || pending.requestId !== queuedRequestId) {
      return refuse("That queued move was cancelled or replaced.");
    }
    const refusals = threadMoveRefusals(readModel, thread);
    const block = firstMoveBlock(refusals);
    if (block !== null) return refuse(block.words);
    if (refusals.length > 0) return refuse(BUSY_WORDS);
    if (pending.stage !== "quiescing" || !sessionStopped(thread)) {
      return refuse("This thread's agent hasn't stopped yet.");
    }
  }
  const started: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.move-started",
    payload: {
      threadId: thread.id,
      transferId: command.transferId,
      target: command.target,
      agent: command.agent,
      startedAt: command.createdAt,
      ...(queuedRequestId !== undefined ? { queuedRequestId } : {}),
    },
  };
  const queueEnded: PlannedEvent[] =
    queuedRequestId === undefined
      ? []
      : [
          {
            ...baseFor(thread.id),
            type: "thread.move-queue-ended",
            payload: {
              threadId: thread.id,
              requestId: queuedRequestId,
              reason: "started",
              endedAt: command.createdAt,
            },
          },
        ];
  // Settings cards waiting for an answer don't move: they end here, with why.
  const cancelled = cancelWaitingSettingsChanges(
    thread,
    SETTINGS_CHANGE_CANCELLED.moving(command.target.label),
    command.createdAt,
    baseFor,
  );
  if (sessionStopped(thread)) {
    return [...cancelled, ...queueEnded, started];
  }
  return [
    ...cancelled,
    started,
    {
      ...baseFor(thread.id),
      type: "thread.session-stop-requested",
      payload: { threadId: thread.id, createdAt: command.createdAt },
    },
  ];
}

/** The thread's pending move, when it is the one `requestId` names. */
function currentPendingMove(thread: OrchestrationThread, requestId: string) {
  const pending = thread.pendingMove ?? null;
  return pending !== null && pending.requestId === requestId ? pending : null;
}

/** Ending every runtime of the thread: "Stop and move now", and the barrier before a freeze. */
function sessionStopEvents(
  thread: OrchestrationThread,
  createdAt: string,
  baseFor: EventBase,
): PlannedEvent[] {
  const sideTurn = thread.sideTurn ?? null;
  return [
    {
      ...baseFor(thread.id),
      type: "thread.session-stop-requested",
      payload: { threadId: thread.id, createdAt },
    },
    // A side answer runs in a runtime of its own.
    ...(sideTurn !== null
      ? [
          {
            ...baseFor(thread.id),
            type: "thread.side-turn-interrupt-requested" as const,
            payload: { threadId: thread.id, sideTurnId: sideTurn.sideTurnId, createdAt },
          },
        ]
      : []),
  ];
}

/**
 * Queues a move that starts once the thread is free (docs/design/fleet.md,
 * Part 3b). Refused when something only the user can clear stands in the
 * way, or another move waits or runs; allowed with any number of waits, and
 * with none (the queue then starts it at once). "Stop and move now" ends the
 * thread's sessions in the same decision; the caller adds what Stop holds
 * (command output that would wake the agent).
 */
export function decideMoveQueue(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.queue">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = thread.pendingMove ?? null;
  if (pending !== null) {
    // The same request again (a retried call) is no news.
    return pending.requestId === command.requestId
      ? []
      : refuse(`A move to ${pending.target.label} is already waiting. Cancel it first.`);
  }
  const refusals = threadMoveRefusals(readModel, thread);
  const block = firstMoveBlock(refusals);
  if (block !== null) return refuse(block.words);
  const queued: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.move-queued",
    payload: {
      threadId: thread.id,
      pendingMove: {
        requestId: command.requestId,
        target: command.target,
        agent: command.agent,
        mode: command.mode,
        stage: command.mode === "stop-now" ? "quiescing" : "waiting",
        requestedAt: command.createdAt,
        requestedBy: command.requestedBy,
        waitsFor: moveWaitsOf(refusals),
        hold: null,
      },
    },
  };
  return command.mode === "stop-now"
    ? [queued, ...sessionStopEvents(thread, command.createdAt, baseFor)]
    : [queued];
}

/** Cancel: the queued move `requestId` ends; a cancel for an older one changes nothing. */
export function decideMoveUnqueue(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.unqueue">,
  baseFor: EventBase,
): ThreadMoveDecision {
  if (currentPendingMove(thread, command.requestId) === null) return [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-queue-ended",
      payload: {
        threadId: thread.id,
        requestId: command.requestId,
        reason: "cancelled",
        endedAt: command.createdAt,
      },
    },
  ];
}

/**
 * The barrier's first step: the thread is free, so its sessions end, and the
 * session fence holds from here (`stage: "quiescing"`). Asked again while
 * quiescing, it only stops a session the projection still shows.
 */
export function decideMoveQuiesce(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.quiesce">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = currentPendingMove(thread, command.requestId);
  if (pending === null) return [];
  const refusals = threadMoveRefusals(readModel, thread);
  const block = firstMoveBlock(refusals);
  if (block !== null) return refuse(block.words);
  if (refusals.length > 0) return refuse(BUSY_WORDS);
  if (pending.stage === "quiescing") {
    return sessionStopped(thread) ? [] : sessionStopEvents(thread, command.createdAt, baseFor);
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-quiescing",
      payload: { threadId: thread.id, requestId: command.requestId, updatedAt: command.createdAt },
    },
    ...sessionStopEvents(thread, command.createdAt, baseFor),
  ];
}

/**
 * Whether a queued move already says it waits for `waitsFor` and is held by
 * `hold`: a status that would change nothing isn't sent or recorded.
 */
export function sameMoveStatus(
  pending: ThreadPendingMove,
  waitsFor: ReadonlyArray<ThreadMoveWait>,
  hold: ThreadMoveHold | null,
): boolean {
  const shown = pending.waitsFor ?? [];
  const held = pending.hold ?? null;
  return (
    shown.length === waitsFor.length &&
    shown.every(
      (entry, index) =>
        entry.code === waitsFor[index]?.code && entry.words === waitsFor[index].words,
    ) &&
    held?.kind === hold?.kind &&
    held?.words === hold?.words
  );
}

/** What the queued move waits for now, and what holds it; unchanged is no news. */
export function decideMoveQueueStatus(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.queue-status">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = currentPendingMove(thread, command.requestId);
  if (pending === null || sameMoveStatus(pending, command.waitsFor, command.hold)) return [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-queue-status-set",
      payload: {
        threadId: thread.id,
        requestId: command.requestId,
        waitsFor: command.waitsFor,
        hold: command.hold,
        updatedAt: command.createdAt,
      },
    },
  ];
}

/**
 * The queued move can't go (or its thread is gone): it ends, and the thread
 * says why ("Didn't move: …") until the user dismisses it.
 */
export function decideMoveQueueEnd(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.queue-end">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = currentPendingMove(thread, command.requestId);
  if (pending === null) return [];
  const payload: ThreadMoveNotStartedPayload = {
    requestId: command.requestId,
    targetLabel: pending.target.label,
    reason: command.reason,
    words: command.words,
  };
  return [
    {
      ...baseFor(thread.id),
      type: "thread.move-queue-ended",
      payload: {
        threadId: thread.id,
        requestId: command.requestId,
        reason: command.reason,
        words: command.words,
        endedAt: command.createdAt,
      },
    },
    {
      ...baseFor(thread.id),
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity: {
          id: EventId.make(`move-not-started:${command.requestId}`),
          tone: "error",
          kind: ThreadMoveNotStartedActivityKind,
          summary: `Didn't move to ${pending.target.label}`,
          payload,
          turnId: null,
          createdAt: command.createdAt,
        },
      },
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
      ...(message.trigger !== undefined ? { trigger: message.trigger } : {}),
      ...(message.notSent === true ? { notSent: true as const } : {}),
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
