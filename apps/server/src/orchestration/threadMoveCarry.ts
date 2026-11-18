/**
 * What a thread carries when it moves (docs/design/fleet.md, Part 3e,
 * "Shared pieces"): its goal, check-backs, pull request switches, General
 * Chats folder, queued messages and plans, its room (Part 3f, (i)) and the
 * marks outside work left on its agents, and which of the other computer's
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
  OrchestrationOutsideWork,
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
import { pullRequestSwitchesWords } from "@threadlines/shared/threadMoveProjection";
import { isRoomThread } from "@threadlines/shared/threadParticipants";

/**
 * What a move view needs of a project to tell a General Chats thread, and
 * (when it has them) of other threads to tell a parent.
 */
export interface ThreadMoveCarryView {
  readonly projects: ReadonlyArray<{
    readonly id: OrchestrationThread["projectId"];
    readonly kind?: string | undefined;
  }>;
  readonly threads?: ReadonlyArray<
    Pick<OrchestrationThread, "id" | "parentThreadId" | "attachedToParent" | "deletedAt">
  >;
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
  /** (i) It has more than one agent, or requests between agents still open. */
  readonly room: boolean;
  /** Its agents outside work still limits (OrchestrationOutsideWork). */
  readonly outsideWork: ReadonlyArray<OrchestrationOutsideWork>;
  /**
   * (g) It started threads (here, or on other computers, or waits on some),
   * or another thread started it: it moves as part of a family.
   */
  readonly family: boolean;
  /** What the other computer must take for this thread to move there. */
  readonly needs: {
    readonly threadState: boolean;
    readonly generalChats: boolean;
    readonly rooms: boolean;
    readonly outsideWork: boolean;
    readonly families: boolean;
    /**
     * Another computer's agent started it (`remoteOrigin`): it can only go
     * back to that computer, as its child there (Part 3f, (h)).
     */
    readonly linkLineage: boolean;
  };
}

/** Everything a current computer takes: the preview's "as if it took everything". */
export const ALL_MOVE_TAKES: ThreadMoveTakes = {
  threadState: true,
  generalChats: true,
  rooms: true,
  outsideWork: true,
  families: true,
  linkLineage: true,
};

/**
 * A message from the thread's own family (docs/design/fleet.md, Part 3f,
 * (g)): a child's answer queued in its parent, here or from another
 * computer, or its parent's request queued in a child. A lead chat's pass
 * isn't one: the lead never moves.
 */
export const isFamilyQueued = (
  thread: Pick<OrchestrationThread, "parentThreadId">,
  entry: OrchestrationQueuedFollowUp,
) => {
  const origin = entry.fromThread;
  return (
    origin !== undefined &&
    origin.ceiling === undefined &&
    (origin.kind === "report" ||
      (origin.environmentId === undefined && origin.threadId === thread.parentThreadId))
  );
};

/**
 * Whether what acts for a thread's family stops for it (docs/design/fleet.md,
 * Part 3f, rule 5 and review change 4): from the move's stop on (`quiescing`)
 * and while it is frozen or moved away. A move still waiting (`waiting`)
 * lets the answers it waits for keep settling.
 */
export const familyWorkStopped = (thread: Pick<OrchestrationThread, "pendingMove" | "move">) =>
  (thread.move ?? null) !== null || thread.pendingMove?.stage === "quiescing";

/**
 * What a thread's queue still sends while its move waits (docs/design/
 * fleet.md, Part 3f, review change 4): a room agent's hand-off or reply, and
 * its family's requests and answers, so what the thread already has going
 * finishes and it gets free. The user's own messages wait to go with it.
 */
export const drainsWhileMoveWaits = (
  thread: Pick<OrchestrationThread, "parentThreadId">,
  entry: OrchestrationQueuedFollowUp,
) => isRoomAgentQueued(entry) || isFamilyQueued(thread, entry);

/** A message a room agent queued for another (a hand-off or a reply): the room's chain drains it. */
export const isRoomAgentQueued = (entry: OrchestrationQueuedFollowUp) =>
  entry.fromAgent !== undefined &&
  entry.fromThread === undefined &&
  entry.fromOutside === undefined &&
  entry.scheduledTaskId === undefined;

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

/**
 * What a move's stop took, merged with what the thread holds now (it is only
 * ever added to). `childRequestsStopped`: the waits on its children this stop
 * ends (Part 3f, (g)), added to the ones earlier stops ended.
 */
export function mergeInterrupted(
  thread: Pick<OrchestrationThread, "goal" | "checkBacks">,
  earlier: ThreadMoveInterrupted | null | undefined,
  childRequestsStopped = 0,
): ThreadMoveInterrupted | undefined {
  const goalActive = earlier?.goalActive === true || thread.goal?.status === "active";
  const byId = new Map<string, OrchestrationCheckBack>();
  for (const checkBack of earlier?.checkBacks ?? []) byId.set(checkBack.id, checkBack);
  for (const checkBack of thread.checkBacks ?? []) byId.set(checkBack.id, checkBack);
  const checkBacks = [...byId.values()].toSorted((left, right) =>
    left.scheduledFor.localeCompare(right.scheduledFor),
  );
  const stopped = (earlier?.childRequestsStopped ?? 0) + childRequestsStopped;
  if (!goalActive && checkBacks.length === 0 && stopped === 0) return undefined;
  return {
    ...(goalActive ? { goalActive: true as const } : {}),
    ...(checkBacks.length > 0 ? { checkBacks } : {}),
    ...(stopped > 0 ? { childRequestsStopped: stopped } : {}),
  };
}

/** Whether two records of what a stop took say the same. */
export function sameInterrupted(
  left: ThreadMoveInterrupted | null | undefined,
  right: ThreadMoveInterrupted | null | undefined,
): boolean {
  const ids = (value: ThreadMoveInterrupted | null | undefined) =>
    (value?.checkBacks ?? []).map((checkBack) => checkBack.id).join("\0");
  return (
    (left?.goalActive === true) === (right?.goalActive === true) &&
    ids(left) === ids(right) &&
    (left?.childRequestsStopped ?? 0) === (right?.childRequestsStopped ?? 0)
  );
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
  const room = isRoomThread(thread) || thread.agentRequests.open.length > 0;
  const outsideWork = thread.outsideWork ?? [];
  const family =
    (thread.parentThreadId !== null && thread.attachedToParent) ||
    (thread.childRequests.remoteChildren ?? []).length > 0 ||
    thread.childRequests.open.length > 0 ||
    (view.threads ?? []).some(
      (candidate) =>
        candidate.parentThreadId === thread.id &&
        candidate.attachedToParent &&
        candidate.deletedAt === null,
    );
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
    room,
    outsideWork,
    family,
    needs: {
      families: family,
      linkLineage: (thread.remoteOrigin ?? null) !== null,
      threadState:
        (goal !== null && goal.status !== "complete") ||
        checkBacks.length > 0 ||
        pullRequests !== null ||
        queuedFollowUps.length > 0 ||
        planWaiting,
      generalChats: generalChat,
      rooms: room,
      outsideWork: outsideWork.length > 0,
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
  if (carry.needs.rooms && takes?.rooms !== true) return "it has more than one agent";
  if (carry.needs.families && takes?.families !== true) return "it started other threads";
  if (carry.needs.linkLineage && takes?.linkLineage !== true) {
    return "an agent on another computer started it";
  }
  if (carry.needs.outsideWork && takes?.outsideWork !== true) {
    return "an outside assistant's work limits its agent here";
  }
  if (!carry.needs.threadState || takes?.threadState === true) return null;
  if (carry.goal !== null && carry.goal.status !== "complete") return "it has a goal";
  if (carry.checkBacks.length > 0) return "its agent set itself a time to come back";
  if (carry.pullRequests !== null) return "it has pull request auto-fix or auto-merge on";
  if (carry.queuedFollowUps.length > 0) return "it has queued messages";
  return "it has a plan waiting";
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

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
    // They arrive off: only the user there turns them on (Part 3e, (c)).
    const on = pullRequestSwitchesWords(carry.pullRequests);
    if (on !== null) {
      lines.push(
        `${on.words} for ${on.what} ${on.plural ? "arrive" : "arrives"} off, for you to turn on there.`,
      );
    }
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
