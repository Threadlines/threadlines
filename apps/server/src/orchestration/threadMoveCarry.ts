/**
 * What a thread carries when it moves (docs/design/fleet.md, Part 3e,
 * "Shared pieces"): its goal, check-backs, pull request switches, General
 * Chats folder, queued messages and plans, and which of the other computer's
 * capabilities each needs. One pure description for the three that must
 * agree: the move checks (`threadMoveRefusals`: refused or not), the dialog's
 * lines (the preview), and the export (what to pack).
 *
 * What the move's stop already took (ThreadMoveInterrupted: a goal that was
 * working, check-backs that ended with the session) counts as the thread's,
 * so a move that stopped its agent still carries them.
 */
import type {
  OrchestrationCheckBack,
  OrchestrationProposedPlan,
  OrchestrationQueuedFollowUp,
  OrchestrationThread,
  OrchestrationThreadGoal,
  OrchestrationThreadLinkedPullRequest,
  PullRequestMergeMethod,
  ThreadMoveInterrupted,
  ThreadMoveTakes,
} from "@threadlines/contracts";
import { PEER_MOVE_STATE_MAX_PLANS } from "@threadlines/contracts";
import { linkedPullRequestArmed } from "@threadlines/shared/linkedPullRequests";

/** What a move view needs of a project to tell a General Chats thread. */
export interface ThreadMoveCarryView {
  readonly projects: ReadonlyArray<{
    readonly id: OrchestrationThread["projectId"];
    readonly kind?: string | undefined;
  }>;
}

export interface ThreadMoveCarry {
  /** (a) The thread's goal, in any status; null: none. */
  readonly goal: OrchestrationThreadGoal | null;
  /** (a) It was working when (or before) the move stopped its agent. */
  readonly goalWorking: boolean;
  /** (b) Its agents' check-backs, with the ones the move's stop ended. */
  readonly checkBacks: ReadonlyArray<OrchestrationCheckBack>;
  /** (c) Its pull request switches, when any is on; null: none on. */
  readonly pullRequests: {
    readonly autoFix: boolean;
    readonly autoMerge: PullRequestMergeMethod | null;
    readonly linked: ReadonlyArray<OrchestrationThreadLinkedPullRequest>;
  } | null;
  /** (d) A General Chats thread: its folder moves, not a checkout. */
  readonly generalChat: boolean;
  /** (e) The user's own queued messages, in order. */
  readonly queuedFollowUps: ReadonlyArray<OrchestrationQueuedFollowUp>;
  /** (e) Messages queued by something on this computer, which keep blocking. */
  readonly foreignQueued: ReadonlyArray<OrchestrationQueuedFollowUp>;
  /** (f) The plans that come along: the newest PEER_MOVE_STATE_MAX_PLANS, oldest first. */
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  /** (f) Older plans past the limit, which stay here. */
  readonly plansLeftBehind: number;
  /** (f) A plan waits for the user's Implement or Dismiss. */
  readonly planWaiting: boolean;
  /** What the other computer must take for this thread to move there. */
  readonly needs: { readonly threadState: boolean; readonly generalChats: boolean };
}

/** Everything a current computer takes: the preview's "as if it took everything". */
export const ALL_MOVE_TAKES: ThreadMoveTakes = { threadState: true, generalChats: true };

/** A queued message the user wrote: none of an agent's, a thread's, an outside assistant's or a scheduled run's. */
export const isUsersQueuedFollowUp = (entry: OrchestrationQueuedFollowUp) =>
  entry.fromAgent === undefined &&
  entry.fromThread === undefined &&
  entry.fromOutside === undefined &&
  entry.scheduledTaskId === undefined;

/**
 * The plan Implement and Dismiss act on: the newest one on the latest turn,
 * unanswered. A thread with no turn yet (one that moved here and hasn't
 * worked since) offers its newest plan, as the app does.
 */
export function waitingPlanOf(
  thread: Pick<OrchestrationThread, "proposedPlans" | "latestTurn">,
): OrchestrationProposedPlan | null {
  const unanswered = (plan: OrchestrationProposedPlan) =>
    plan.implementedAt === null && plan.dismissedAt === null;
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (latestTurnId === null) {
    const newest = thread.proposedPlans.at(-1);
    return newest !== undefined && unanswered(newest) ? newest : null;
  }
  return (
    thread.proposedPlans.findLast((plan) => plan.turnId === latestTurnId && unanswered(plan)) ??
    null
  );
}

/** What a move's stop took, merged with what the thread holds now (it is only ever added to). */
export function mergeInterrupted(
  thread: Pick<OrchestrationThread, "goal" | "checkBacks">,
  earlier: ThreadMoveInterrupted | null | undefined,
): ThreadMoveInterrupted | undefined {
  const goalActive = earlier?.goalActive === true || thread.goal?.status === "active";
  const byId = new Map<string, OrchestrationCheckBack>();
  for (const checkBack of earlier?.checkBacks ?? []) byId.set(checkBack.id, checkBack);
  for (const checkBack of thread.checkBacks ?? []) byId.set(checkBack.id, checkBack);
  const checkBacks = [...byId.values()].toSorted((left, right) =>
    left.scheduledFor.localeCompare(right.scheduledFor),
  );
  if (!goalActive && checkBacks.length === 0) return undefined;
  return {
    ...(goalActive ? { goalActive: true as const } : {}),
    ...(checkBacks.length > 0 ? { checkBacks } : {}),
  };
}

/** Whether two records of what a stop took say the same. */
export function sameInterrupted(
  left: ThreadMoveInterrupted | null | undefined,
  right: ThreadMoveInterrupted | null | undefined,
): boolean {
  const ids = (value: ThreadMoveInterrupted | null | undefined) =>
    (value?.checkBacks ?? []).map((checkBack) => checkBack.id).join("\0");
  return (left?.goalActive === true) === (right?.goalActive === true) && ids(left) === ids(right);
}

/** What the thread's move under way or waiting recorded its stop took. */
export const interruptedOf = (
  thread: Pick<OrchestrationThread, "pendingMove" | "move">,
): ThreadMoveInterrupted | undefined =>
  thread.move?.interrupted ?? thread.pendingMove?.interrupted ?? undefined;

/** What `thread` carries if it moves now (docs/design/fleet.md, Part 3e). */
export function threadMoveCarry(
  view: ThreadMoveCarryView,
  thread: OrchestrationThread,
): ThreadMoveCarry {
  const interrupted = mergeInterrupted(thread, interruptedOf(thread));
  const goal = thread.goal ?? null;
  const checkBacks = interrupted?.checkBacks ?? [];
  const linkedArmed = (thread.linkedPullRequests ?? []).filter(linkedPullRequestArmed);
  const ownArmed = thread.pullRequestAutoFix || thread.pullRequestAutoMerge !== null;
  const pullRequests =
    ownArmed || linkedArmed.length > 0
      ? {
          autoFix: thread.pullRequestAutoFix,
          autoMerge: thread.pullRequestAutoMerge,
          linked: linkedArmed,
        }
      : null;
  const generalChat =
    view.projects.find((project) => project.id === thread.projectId)?.kind === "general-chat";
  const queued = thread.queuedFollowUps ?? [];
  const queuedFollowUps = queued.filter(isUsersQueuedFollowUp);
  const foreignQueued = queued.filter((entry) => !isUsersQueuedFollowUp(entry));
  const proposedPlans = thread.proposedPlans.slice(-PEER_MOVE_STATE_MAX_PLANS);
  const planWaiting = waitingPlanOf(thread) !== null;
  return {
    goal,
    goalWorking: interrupted?.goalActive === true,
    checkBacks,
    pullRequests,
    generalChat,
    queuedFollowUps,
    foreignQueued,
    proposedPlans,
    plansLeftBehind: thread.proposedPlans.length - proposedPlans.length,
    planWaiting,
    needs: {
      threadState:
        (goal !== null && goal.status !== "complete") ||
        checkBacks.length > 0 ||
        pullRequests !== null ||
        queuedFollowUps.length > 0 ||
        planWaiting,
      generalChats: generalChat,
    },
  };
}

/**
 * The first thing the thread carries that `takes` doesn't cover, as the end
 * of "Update Threadlines on <computer> to move this thread: …", or null when
 * it covers everything.
 */
export function carryNotTaken(
  carry: ThreadMoveCarry,
  takes: ThreadMoveTakes | null | undefined,
): string | null {
  if (carry.needs.generalChats && takes?.generalChats !== true) return "it's a general chat";
  if (!carry.needs.threadState || takes?.threadState === true) return null;
  if (carry.goal !== null && carry.goal.status !== "complete") return "it has a goal";
  if (carry.checkBacks.length > 0) return "its agent set itself a time to come back";
  if (carry.pullRequests !== null) return "it has pull request auto-fix or auto-merge on";
  if (carry.queuedFollowUps.length > 0) return "it has queued messages";
  return "it has a plan waiting";
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

/** Which switches watch, in words: "Auto-fix", "Auto-merge", or both. */
function switchesWords(
  fix: boolean,
  merge: boolean,
): { readonly words: string; readonly verb: string } {
  if (fix && merge) return { words: "Auto-fix and auto-merge", verb: "keep" };
  return { words: fix ? "Auto-fix" : "Auto-merge", verb: "keeps" };
}

/**
 * What the pull request switches watch, in words ("pull request #212", or
 * "this thread's pull request"), and which switches are on.
 */
export function pullRequestCarryWords(pullRequests: NonNullable<ThreadMoveCarry["pullRequests"]>) {
  const fix = pullRequests.autoFix || pullRequests.linked.some((entry) => entry.autoFix);
  const merge =
    pullRequests.autoMerge !== null ||
    pullRequests.linked.some((entry) => entry.autoMerge !== null);
  const numbers = pullRequests.linked.map((entry) => `#${entry.number}`);
  const own = pullRequests.autoFix || pullRequests.autoMerge !== null;
  const what =
    numbers.length === 0
      ? "this thread's pull request"
      : numbers.length === 1 && !own
        ? `pull request ${numbers[0]}`
        : `pull requests ${[...(own ? ["its own"] : []), ...numbers].join(", ")}`;
  return { ...switchesWords(fix, merge), what };
}

/**
 * The move dialog's lines for what comes along (ThreadMovePreview.brings),
 * one per thing, in the server's words.
 */
export function carryBringsWords(carry: ThreadMoveCarry): ReadonlyArray<string> {
  const lines: string[] = [];
  const goal = carry.goal;
  if (goal !== null && goal.status !== "complete") {
    lines.push(
      goal.status === "active" || carry.goalWorking
        ? "Its goal carries on there."
        : "Its goal arrives paused.",
    );
  }
  if (carry.checkBacks.length > 0) {
    lines.push(
      carry.checkBacks.length === 1
        ? "Its agent sets its check-back again there."
        : `Its agent sets its ${carry.checkBacks.length} check-backs again there.`,
    );
  }
  if (carry.pullRequests !== null) {
    const { words, verb, what } = pullRequestCarryWords(carry.pullRequests);
    lines.push(`${words} ${verb} watching ${what} from there.`);
  }
  if (carry.queuedFollowUps.length > 0) {
    lines.push(
      carry.queuedFollowUps.length === 1
        ? "1 queued message is sent there."
        : `${carry.queuedFollowUps.length} queued messages are sent there.`,
    );
  }
  if (carry.planWaiting) lines.push("The plan waits for you there.");
  if (carry.plansLeftBehind > 0) {
    lines.push(
      `${plural(carry.plansLeftBehind, "older plan stays", "older plans stay")} on this computer.`,
    );
  }
  return lines;
}
