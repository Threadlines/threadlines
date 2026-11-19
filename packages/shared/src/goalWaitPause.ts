/**
 * A goal pauses while its thread waits on something that will wake the agent
 * by itself, and carries on when the wait ends (docs/design/goal-wait-pause.md).
 *
 * An agent working toward a goal often asks for something through a card and
 * gets control back at once: threads to start, a scheduled task, a settings
 * change, an invite, a command for the user to run. Or it starts threads and
 * waits for their reports. The goal would otherwise keep running turns that
 * can only say "still pending". The server pauses it then, and keeps a mark
 * on the goal (`waitPause`) so that only its own pause is ever undone:
 *
 * - `paused`: paused for the wait (the provider may not have confirmed yet).
 * - `resuming`: the wait ended and the resume went out; the mark goes when the
 *   provider reports the goal active, so a restart in between sends it again.
 * - `user`: the user paused, resumed, edited, cleared or stopped it during the
 *   wait. Nothing automatic happens until that wait is over; then it goes.
 */
import type { OrchestrationThread, OrchestrationThreadGoal } from "@threadlines/contracts";

import { awaitedChildRequestCount, hasPendingChildApproval } from "./childThreads.ts";
import { commandRunAwaitsAutoSend, isCommandRunSettled } from "./commandRuns.ts";
import { awaitingInvite } from "./roomAgentRequests.ts";
import { hasPendingSettingsChange } from "./settingsChangeState.ts";

/** What the thread waits on: the user's answer on a card, or threads it started. */
export type GoalWait = "user" | "threads";

/** The mark a goal carries for a wait (OrchestrationThreadGoal.waitPause). */
export type GoalWaitMark = NonNullable<OrchestrationThreadGoal["waitPause"]>;

type GoalWaitFacts = Pick<
  OrchestrationThread,
  "childRequests" | "settingsRequests" | "agentRequests" | "commandRequests" | "commandRuns"
>;

/**
 * A run whose output goes back to the agent by itself and hasn't yet: still
 * running, or finished with its output on the way (the finish is recorded a
 * moment before the output is sent). Held output waits for the user to send
 * it, which no card asks for.
 */
const outputStillComing = (run: NonNullable<GoalWaitFacts["commandRuns"]>[number]): boolean =>
  commandRunAwaitsAutoSend(run) &&
  run.heldReason === null &&
  (!isCommandRunSettled(run.status) || run.status === "finished");

/**
 * A command card the user hasn't run or skipped, or one they ran whose output
 * hasn't gone back yet: its output wakes the agent that asked.
 */
function hasWaitingCommandCard(thread: GoalWaitFacts): boolean {
  const allRuns = thread.commandRuns ?? [];
  return (thread.commandRequests ?? []).some((request) => {
    if (request.dismissedAt !== null) return false;
    const runs = allRuns.filter(
      (run) => run.source.kind === "request" && run.source.requestId === request.requestId,
    );
    return runs.length === 0 || runs.some(outputStillComing);
  });
}

/**
 * What the thread waits on that will wake its agent by itself, if anything.
 * A card only the user can answer comes first; then threads it started that
 * still owe their reports. `scheduleAnswerWaiting`: a card asks the user about
 * its agent's scheduled-task change (the scheduler holds those, not the thread).
 * A permission prompt or a question is not here: the turn that asked is still
 * running, and nothing loops while it waits.
 */
export function goalWaitOf(thread: GoalWaitFacts, scheduleAnswerWaiting: boolean): GoalWait | null {
  if (
    scheduleAnswerWaiting ||
    hasPendingChildApproval(thread.childRequests) ||
    hasPendingSettingsChange(thread.settingsRequests) ||
    awaitingInvite(thread.agentRequests) !== undefined ||
    hasWaitingCommandCard(thread)
  ) {
    return "user";
  }
  return awaitedChildRequestCount(thread.childRequests) > 0 ? "threads" : null;
}

/**
 * Whether a turn is about to start: the session is starting one, or a message
 * waits in the queue to go next (a report from a thread it started is queued
 * in the same decision that settles its request, then sent).
 */
export function turnAboutToStart(
  thread: Pick<OrchestrationThread, "session" | "queuedFollowUps">,
): boolean {
  return thread.session?.status === "starting" || (thread.queuedFollowUps ?? []).length > 0;
}

/**
 * What to do with the thread's goal now: the mark it should carry, and what
 * to send the provider, if anything. Null: leave it as it is.
 *
 * - The user acted on the goal (`userActed`: a pause, resume, edit, clear or
 *   Stop) while the thread waits or while it carries our mark: it is theirs
 *   for this wait.
 * - Waiting, an active goal with no mark: pause it.
 * - The wait is over and we paused it: resume it, marked `resuming` until the
 *   provider confirms. A resume not yet confirmed is sent again only when
 *   asked (`retryResume`: after a restart), never on every look. Not while a
 *   turn is about to start: resumed while idle, the provider starts a goal
 *   turn of its own, and it would race the turn that ended the wait (a report,
 *   a command's output). Resumed while that turn runs, the goal carries on
 *   after it.
 * - The wait is over and the user acted during it: forget the mark.
 * - Waiting again before a resume was confirmed: pause it again, sent, so a
 *   resume still on its way doesn't win.
 */
export function goalWaitStep(input: {
  readonly goal: Pick<OrchestrationThreadGoal, "status" | "waitPause"> | null;
  readonly waiting: boolean;
  readonly turnStarting: boolean;
  readonly userActed?: boolean | undefined;
  readonly retryResume?: boolean | undefined;
}): { readonly mark: GoalWaitMark | null; readonly send: "paused" | "active" | null } | null {
  const { goal } = input;
  if (goal === null) return null;
  const mark = goal.waitPause;
  if (input.userActed === true && mark !== "user" && (input.waiting || mark !== undefined)) {
    return { mark: "user", send: null };
  }
  if (input.waiting) {
    if (mark === undefined) {
      return goal.status === "active" ? { mark: "paused", send: "paused" } : null;
    }
    return mark === "resuming" ? { mark: "paused", send: "paused" } : null;
  }
  if (mark === "user") return { mark: null, send: null };
  if (mark === "paused" || mark === "resuming") {
    if (goal.status === "paused") {
      if (input.turnStarting || (mark === "resuming" && input.retryResume !== true)) return null;
      return { mark: "resuming", send: "active" };
    }
    // Active with `paused`: our pause is on its way; with `resuming`: our
    // resume, confirmed in the next report. Anything else is the provider's
    // own ending, not ours to undo.
    return goal.status === "active" ? null : { mark: null, send: null };
  }
  return null;
}

/**
 * The mark a goal the provider reported keeps: ours while the goal is still
 * active (a pause on its way) or paused; `resuming` until the provider says it
 * is active again; the user's until the goal is gone or complete.
 */
export function carriedGoalWaitMark(
  previous: Pick<OrchestrationThreadGoal, "waitPause"> | null,
  next: Pick<OrchestrationThreadGoal, "status"> | null,
): GoalWaitMark | undefined {
  const mark = previous?.waitPause;
  if (mark === undefined || next === null || next.status === "complete") return undefined;
  switch (mark) {
    case "paused":
      return next.status === "active" || next.status === "paused" ? "paused" : undefined;
    case "resuming":
      return next.status === "paused" ? "resuming" : undefined;
    case "user":
      return "user";
  }
}

/**
 * The goal bar's words for a goal this paused, read from the facts the
 * sidebar reads, so the two never disagree: a card first, else the threads
 * at work.
 */
export function goalWaitPauseLabel(thread: {
  readonly pendingChildApproval?: boolean | undefined;
  readonly pendingSettingsChange?: boolean | undefined;
  readonly pendingScheduleApproval?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly awaitedChildThreadCount?: number | undefined;
}): string {
  const cardWaits =
    thread.pendingChildApproval === true ||
    thread.pendingSettingsChange === true ||
    thread.pendingScheduleApproval === true ||
    thread.hasPendingUserInput === true;
  return !cardWaits && (thread.awaitedChildThreadCount ?? 0) > 0
    ? "Paused while its threads work"
    : "Paused until you answer";
}
