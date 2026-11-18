/**
 * A goal pauses while its thread waits on something that will wake the agent
 * by itself, and carries on when the wait ends (docs/design/goal-wait-pause.md).
 *
 * An agent working toward a goal often asks for something through a card and
 * gets control back at once: threads to start, a scheduled task, a settings
 * change, an invite, a command for the user to run. Or it starts threads and
 * waits for their reports. The goal would otherwise keep running turns that
 * can only say "still pending". The server pauses it then, marking the goal
 * `pausedForWait` so that only its own pause is ever undone; the user's own
 * pause, resume or clear, and a goal that ends, take the mark away.
 */
import type { OrchestrationThread, OrchestrationThreadGoal } from "@threadlines/contracts";

import { awaitedChildRequestCount, hasPendingChildApproval } from "./childThreads.ts";
import { isCommandRunSettled } from "./commandRuns.ts";
import { awaitingInvite } from "./roomAgentRequests.ts";
import { hasPendingSettingsChange } from "./settingsChangeState.ts";

/** What the thread waits on: the user's answer on a card, or threads it started. */
export type GoalWait = "user" | "threads";

type GoalWaitFacts = Pick<
  OrchestrationThread,
  "childRequests" | "settingsRequests" | "agentRequests" | "commandRequests" | "commandRuns"
>;

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
    return (
      runs.length === 0 || runs.some((run) => run.autoSend && !isCommandRunSettled(run.status))
    );
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
 * What to do with the thread's goal now: pause an active goal while it waits,
 * resume one this paused once the wait is over, or nothing. A resume waits
 * while a turn is about to start (`turnStarting`): resumed while idle, the
 * provider starts a goal turn of its own, and it would race the turn that
 * ended the wait (a report, the output of a command). Resumed while that turn
 * runs, the goal carries on after it.
 */
export function goalWaitStep(input: {
  readonly goal: Pick<OrchestrationThreadGoal, "status" | "pausedForWait"> | null;
  readonly waiting: boolean;
  readonly turnStarting: boolean;
}): "pause" | "resume" | null {
  const { goal } = input;
  if (goal === null) return null;
  if (input.waiting) {
    return goal.status === "active" && goal.pausedForWait !== true ? "pause" : null;
  }
  return goal.pausedForWait === true && goal.status === "paused" && !input.turnStarting
    ? "resume"
    : null;
}

/**
 * Whether the mark carries over to a goal the provider reported: only while
 * the goal is still active (our pause on its way) or paused. A goal that
 * completed, blocked or hit a limit is the provider's to report, not ours to
 * resume.
 */
export function keepsGoalWaitMark(
  previous: Pick<OrchestrationThreadGoal, "pausedForWait"> | null,
  next: Pick<OrchestrationThreadGoal, "status"> | null,
): boolean {
  return (
    previous?.pausedForWait === true &&
    next !== null &&
    (next.status === "active" || next.status === "paused")
  );
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
