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
import { LEAD_MOVE_REFUSAL } from "@threadlines/shared/projectLead";
import {
  EventId,
  MessageId,
  PEER_MOVE_ROOM_MAX_PARTICIPANTS,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationQueuedFollowUp,
  type OrchestrationThread,
  type OrchestrationThreadDoneOverride,
  type OrchestrationThreadMove,
  type ThreadId,
  type ThreadMoveFamily,
  type ThreadMoveHold,
  type ThreadMoveInterrupted,
  type ThreadMoveRestore,
  type ThreadMoveTakes,
  type ThreadMoveTarget,
  ThreadMoveNotStartedActivityKind,
  type ThreadMoveNotStartedPayload,
  type ThreadMoveWait,
  type ThreadMoveWaitCode,
  ThreadNativeSessionFellBackActivityKind,
  type ThreadNativeSessionFellBackPayload,
  type ThreadPendingMove,
} from "@threadlines/contracts";
import { withinModeCeiling } from "@threadlines/shared/childThreads";
import { hasLiveCommandRun } from "@threadlines/shared/commandRuns";
import { threadPullRequestAutomationArmed } from "@threadlines/shared/linkedPullRequests";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  countPendingUserInputs,
} from "@threadlines/shared/pendingRequests";
import { isAgentOrigin } from "@threadlines/shared/roomAgentRequests";
import { liveSideTurns } from "@threadlines/shared/sideTurns";
import { isValidParticipantId } from "@threadlines/shared/threadParticipants";

import { arrivalMessageText, resumedGoalMessageText } from "../moves/arrivalMessage.ts";
import { linkMoveCopyThreadId } from "../moves/linkMoveIds.ts";
import { decideAgentChainStop } from "./agentRequestDecisions.ts";
import { derivedUuid } from "./childRequestIds.ts";
import {
  adoptedThereEvents,
  attachedChildrenOf,
  cameHomeEvents,
  leftBehindEvents,
  movedAloneEvents,
} from "./childThreadDecisions.ts";
import { hasBackgroundWork } from "./sessionBackgroundTasks.ts";
import {
  drainsWhileMoveWaits,
  interruptedOf,
  isFamilyQueued,
  isRoomAgentQueued,
  mergeInterrupted,
  sameInterrupted,
  threadMoveCarry,
  waitingPlanOf,
} from "./threadMoveCarry.ts";
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
  | "fenced"
  | "child"
  | "has_children"
  | "queued_messages"
  | "plan"
  | "goal"
  | "check_back"
  | "command_request"
  | "pull_request_automation"
  | "outside_work"
  | "lead";

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
const STOP_NOW_COMMAND_RUN_WORDS =
  "A command from this thread is running in your terminal. Stop it there, or move the thread when it's done.";
const SHARED_CHECKOUT_WORDS =
  "Another thread is working in the same folder. Wait for it to finish, then move this one.";

const wait = (code: ThreadMoveWaitCode, words = WAIT_WORDS[code]): ThreadMoveRefusalEntry => ({
  kind: "wait",
  code,
  words,
});

/** A room's agents still asking each other: no wait code of its own (a closed set), its own words. */
const ROOM_CHAIN_WORDS = "when its agents finish";
/** A parent waiting on its children's answers (Part 3f, (g)): the `background` code, its own words. */
const FAMILY_WAIT_WORDS = "when the threads it started report back";
/** A child whose parent's move ended before it, or was never there. */
export const PARENT_DIDNT_MOVE_WORDS = "Its parent thread didn't move.";
const CHILD_WORDS =
  "This thread belongs to the thread that started it. Make it its own thread first.";
const FAMILY_CHILD_WORDS =
  "This thread moves with the thread that started it. Move that thread to bring this one along, or make this its own thread first.";
const blocked = (code: ThreadMoveBlockCode, words: string): ThreadMoveRefusalEntry => ({
  kind: "blocked",
  code,
  words,
});

/** What the move checks read: the projects, and the threads they can see. */
export interface ThreadMoveView {
  readonly projects: ReadonlyArray<
    Pick<
      OrchestrationReadModel["projects"][number],
      "id" | "kind" | "workspaceRoot" | "leadThreadId"
    >
  >;
  readonly threads: ReadonlyArray<OrchestrationThread>;
}

/**
 * A thread's checkout, as a key two threads share when they work in the same
 * files: its worktree, else its project's folder. A general chat works in a
 * folder of its own (generalChatThreadScratchCwd), so no two of them share one.
 */
export function checkoutOf(
  readModel: Pick<ThreadMoveView, "projects">,
  thread: Pick<OrchestrationThread, "id" | "projectId" | "worktreePath">,
) {
  if (thread.worktreePath !== null) return thread.worktreePath;
  const project = readModel.projects.find((entry) => entry.id === thread.projectId);
  if (project === undefined) return null;
  return project.kind === "general-chat"
    ? `${project.workspaceRoot}\u0000${thread.id}`
    : project.workspaceRoot;
}

/** Whose queued message keeps a thread here, in words. */
function foreignQueuedWords(entry: OrchestrationQueuedFollowUp): string {
  const whose =
    entry.scheduledTaskId !== undefined
      ? "A scheduled task's message"
      : entry.fromOutside !== undefined
        ? "An outside assistant's message"
        : entry.fromThread !== undefined
          ? "A message from another thread"
          : "An agent's message";
  return `${whose} is waiting its turn. Move once it has been sent, or remove it.`;
}

/**
 * Every reason `thread` can't move right now (docs/design/fleet.md, Parts 3
 * and 3b), each as a `wait` or a `blocked` with words for the user. Every
 * check runs, so a busy thread doesn't hide a goal behind its running turn.
 * The same check runs in `moves.preview` (so the dialog explains before
 * anyone clicks), in `thread.move.queue`, and in the freeze decision. A
 * pending move isn't one of them: each caller decides about that itself.
 * `family` is the family the move goes with (Part 3f, (g)): the thread's own
 * queued move's or move's when not given. `target` is the computer it goes
 * to: the move's own when not given; null asks about any computer (the
 * dialog, which then says per computer).
 */
export function threadMoveRefusals(
  readModel: ThreadMoveView,
  thread: OrchestrationThread,
  takes?: ThreadMoveTakes | null,
  family: ThreadMoveFamily | undefined = thread.pendingMove?.family ?? thread.move?.family,
  target: ThreadMoveTarget | null = thread.pendingMove?.target ?? thread.move?.target ?? null,
): ReadonlyArray<ThreadMoveRefusalEntry> {
  const found: ThreadMoveRefusalEntry[] = [];
  // What rides along (docs/design/fleet.md, Part 3e) is refused only when the
  // other computer doesn't take it. Absent `takes`: nothing beyond v1.
  const carry = threadMoveCarry(readModel, thread);
  const takesState = takes?.threadState === true;
  const takesFamilies = takes?.families === true;
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
  if (project?.kind === "general-chat" && takes?.generalChats !== true) {
    found.push(blocked("general_chat", "General chats can't move yet."));
  }
  // Words only: the move's refusal code is a closed set older peers decode.
  if ((project?.leadThreadId ?? null) === thread.id && thread.archivedAt === null) {
    found.push(blocked("lead", LEAD_MOVE_REFUSAL));
  }
  // A room moves with its agents to a computer that takes rooms (Part 3f,
  // (i)); its agents' requests of each other are then something to wait for.
  const takesRooms = takes?.rooms === true;
  if (carry.room && !takesRooms) {
    found.push(blocked("room", "Threads with more than one agent can't move yet."));
  }
  if (takesRooms && thread.participants.length > PEER_MOVE_ROOM_MAX_PARTICIPANTS) {
    found.push(
      blocked(
        "room",
        `This room has had more than ${PEER_MOVE_ROOM_MAX_PARTICIPANTS} agents, so it can't move.`,
      ),
    );
  }
  // An agent outside work limits stays limited where it goes (OrchestrationOutsideWork).
  if (carry.needs.outsideWork && takes?.outsideWork !== true) {
    found.push(
      blocked(
        "outside_work",
        "An outside assistant's work limits this thread's agent. Start the agent fresh, then move.",
      ),
    );
  }
  // Another computer's agent started it: it goes back there, and nowhere
  // else (Part 3f, (h), rule 2).
  const origin = thread.remoteOrigin ?? null;
  if (origin !== null) {
    const refusal = remoteOriginMoveRefusal(origin, takes, target);
    if (refusal !== null) found.push(blocked("remote_origin", refusal));
  } else {
    // What a move brought works behind the fence until a person here takes
    // it over; until then it goes back where it came from, and nowhere else,
    // so no chain of moves carries another computer's work to a third.
    const refusal = fencedMoveRefusal(thread, target);
    if (refusal !== null) found.push(blocked("fenced", refusal));
  }
  // A child moves with its parent (Part 3f, (g)): its move names the
  // parent's family, and the parent holds a move of that family (waiting,
  // under way, or done). Or it moves alone (Part 3f, (h)) to a computer that
  // keeps it its parent's child across the link.
  if (thread.parentThreadId !== null && thread.attachedToParent) {
    const withParent =
      takesFamilies &&
      family?.parentThreadId === thread.parentThreadId &&
      parentHoldsFamily(readModel, family);
    const alone = family === undefined && takes?.linkLineage === true;
    if (!withParent && !alone) {
      found.push(
        blocked(
          "child",
          takesFamilies && family?.parentThreadId !== undefined
            ? PARENT_DIDNT_MOVE_WORDS
            : takesFamilies
              ? FAMILY_CHILD_WORDS
              : CHILD_WORDS,
        ),
      );
    }
    // Alone, never while its parent moves (Part 3f, (h)): the parent would
    // leave it behind on its way out while it lands there as the parent's
    // child. A parent that queued after this child's own move waits for it
    // instead (below), so the earlier move goes first.
    if (family === undefined) {
      const parent = readModel.threads.find((entry) => entry.id === thread.parentThreadId);
      const parentMove = parent?.move ?? null;
      const ownMove = (thread.pendingMove ?? null) !== null || (thread.move ?? null) !== null;
      const parentMoving =
        (parentMove !== null && parentMove.movedAway === undefined) ||
        ((parent?.pendingMove ?? null) !== null && !ownMove);
      if (parent !== undefined && parent.deletedAt === null && parentMoving) {
        const label = (parent.move ?? parent.pendingMove)?.target.label ?? "another computer";
        found.push(
          blocked(
            "child",
            `The thread that started it is moving to ${label}. Move this one once that's done, or with it.`,
          ),
        );
      }
    }
  }
  // A child of this thread moving on its own: this thread goes once it has
  // (Part 3f, (h)), so it never leaves the child behind mid-move. No wait
  // code of its own (a closed set): `background`, with its own words.
  const childMovingAlone = readModel.threads.find(
    (candidate) =>
      candidate.parentThreadId === thread.id &&
      candidate.attachedToParent &&
      candidate.deletedAt === null &&
      movesAlone(candidate),
  );
  if (childMovingAlone !== undefined) {
    found.push(wait("background", `when '${childMovingAlone.title}' finishes moving`));
  }
  const hasLocalChildren = readModel.threads.some(
    (candidate) =>
      candidate.parentThreadId === thread.id &&
      candidate.attachedToParent &&
      candidate.deletedAt === null,
  );
  if (
    !takesFamilies &&
    (hasLocalChildren ||
      (thread.childRequests.remoteChildren ?? []).length > 0 ||
      thread.childRequests.open.length > 0)
  ) {
    found.push(blocked("has_children", "Threads that started other threads can't move yet."));
  }
  // A message queued by something on this computer answers to it (a
  // scheduled run, an outside assistant, another thread), so it is sent
  // here. The user's own travel when the other computer takes them.
  // A room agent's hand-off or reply, and the family's own requests and
  // answers, drain while the move waits (Part 3f, review change 4):
  // something to wait for, not something to clear.
  const foreign = carry.foreignQueued.find(
    (entry) =>
      !(takesRooms && isRoomAgentQueued(entry)) &&
      !(takesFamilies && isFamilyQueued(thread, entry)),
  );
  if (foreign !== undefined) {
    found.push(blocked("queued_messages", foreignQueuedWords(foreign)));
  } else if (carry.queuedFollowUps.length > 0 && !takesState) {
    // They would start the next turn the moment this one ends.
    found.push(blocked("queued_messages", "Send or remove your queued messages first."));
  }
  // Only the user's answer clears a plan, and implementing it starts a turn.
  if (carry.planWaiting && !takesState) {
    found.push(blocked("plan", "Implement or dismiss the plan first."));
  }
  if (carry.goal !== null && carry.goal.status !== "complete" && !takesState) {
    found.push(blocked("goal", "This thread has a goal set. Clear it first."));
  }
  if (carry.checkBacks.length > 0 && !takesState) {
    // A saved one can't be cancelled here: stopping the runtime doesn't remove it.
    found.push(
      blocked(
        "check_back",
        carry.checkBacks.every((checkBack) => checkBack.durable)
          ? "Claude saved this thread's check-back to disk. Ask the agent to delete it, then move."
          : "This thread's agent set itself a time to come back. Cancel it first.",
      ),
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
  if (threadPullRequestAutomationArmed(thread) && !takesState) {
    found.push(
      blocked(
        "pull_request_automation",
        "Turn off pull request auto-fix and auto-merge for this thread first.",
      ),
    );
  }

  // What goes away on its own.
  found.push(
    ...workWaits(thread, {
      rooms: takesRooms,
      families: takesFamilies,
      sendable: thread.queuedFollowUps ?? [],
    }),
  );
  if (sharedCheckoutBusyThreads(readModel, thread).length > 0) found.push(wait("shared_checkout"));
  return found;
}

/**
 * The other threads at work in `thread`'s checkout (the `shared_checkout`
 * wait): they could change the files while they are being packed. One
 * frozen for its own move can't: its agent is stopped, and nothing it holds
 * (a plan, a queue) runs while it moves. The move queue looks again when
 * any of them changes.
 */
export function sharedCheckoutBusyThreads(
  readModel: ThreadMoveView,
  thread: OrchestrationThread,
): ReadonlyArray<ThreadId> {
  const checkout = checkoutOf(readModel, thread);
  return readModel.threads
    .filter(
      (candidate) =>
        candidate.id !== thread.id &&
        candidate.deletedAt === null &&
        (candidate.move ?? null) === null &&
        checkoutOf(readModel, candidate) === checkout &&
        busyInFolder(candidate),
    )
    .map((candidate) => candidate.id);
}

/**
 * What `thread` is doing now that goes away on its own (docs/design/fleet.md,
 * Parts 3b and 3f), as its move's waits: a turn and what it asks of the user,
 * side answers, background work, a command in the terminal, a workflow, a
 * voice chat, and (`rooms`, `families`) its agents' requests of each other
 * and the threads it started, with the queued messages among `sendable` that
 * keep those going. The one list a thread's own move waits on and the one
 * a move in the same folder waits on (`busyInFolder`), so the two can't drift.
 */
function workWaits(
  thread: OrchestrationThread,
  options: {
    readonly rooms: boolean;
    readonly families: boolean;
    /** Its queued messages that can still be sent. */
    readonly sendable: ReadonlyArray<OrchestrationQueuedFollowUp>;
  },
): ThreadMoveRefusalEntry[] {
  const found: ThreadMoveRefusalEntry[] = [];
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
  if (liveSideTurns(thread).length > 0) found.push(wait("side_turn"));
  if (options.rooms) {
    const open = thread.agentRequests.open;
    // An invite waiting for the user's answer; the rest are agents at work.
    if (open.some((request) => request.status === "awaiting_user")) {
      found.push(wait("approval"));
    }
    if (
      open.some((request) => request.status !== "awaiting_user") ||
      options.sendable.some(isRoomAgentQueued)
    ) {
      found.push(wait("side_turn", ROOM_CHAIN_WORDS));
    }
  }
  // Waiting on the threads it started (Part 3f, (g)): "Move when it's done"
  // waits for their answers; a start waiting for the user's OK, for them.
  if (options.families) {
    const open = thread.childRequests.open;
    if (open.some((request) => request.status === "awaiting_user")) {
      found.push(wait("approval"));
    }
    if (
      open.some((request) => request.status !== "awaiting_user") ||
      options.sendable.some((entry) => isFamilyQueued(thread, entry))
    ) {
      found.push(wait("background", FAMILY_WAIT_WORDS));
    }
  }
  if (hasBackgroundWork(session, "any")) found.push(wait("background"));
  if (hasLiveCommandRun(thread.commandRuns)) found.push(wait("command_run"));
  if ((thread.workflowRuns ?? []).some((run) => run.status === "running")) {
    found.push(wait("workflow_run"));
  }
  if (thread.voiceActive === true) found.push(wait("voice"));
  return found;
}

/**
 * Whether another thread working in a folder could still change its files
 * (the `shared_checkout` wait): anything its own move would wait on
 * (workWaits, room and family work included), and the queued messages and
 * waiting plan that can still start a turn. What its own queued move holds
 * back doesn't count: its user's queued messages and its plan wait for that
 * move (the guard refuses them); while it waits (`waiting`) a room agent's
 * hand-off and the family's requests and answers still drain, and from
 * `quiescing` on nothing queued is sent. Counting what is held would let two
 * moves wait on each other for good: two family members sharing a folder
 * (Part 3f, (g)), or a parent waiting for its child's own move while the
 * child waits for the parent's held message (Part 3f, (h)).
 */
function busyInFolder(thread: OrchestrationThread): boolean {
  const pending = thread.pendingMove ?? null;
  const queued = thread.queuedFollowUps ?? [];
  const sendable =
    pending === null
      ? queued
      : pending.stage === "waiting"
        ? queued.filter((entry) => drainsWhileMoveWaits(thread, entry))
        : [];
  return (
    sendable.length > 0 ||
    (pending === null && waitingPlanOf(thread) !== null) ||
    workWaits(thread, { rooms: true, families: true, sendable }).length > 0
  );
}

/**
 * Why a thread another computer's agent started (`origin`) can't move to
 * `target`, or null (docs/design/fleet.md, Part 3f, (h), rule 2): it goes
 * only back to that computer, only when the link proved which computer that
 * is (`environmentPinned`), and only to one that takes it back as its
 * child. A null `target` asks whether it can go anywhere: the home check is
 * then the dialog's, per computer.
 */
export function remoteOriginMoveRefusal(
  origin: NonNullable<OrchestrationThread["remoteOrigin"]>,
  takes: ThreadMoveTakes | null | undefined,
  target: ThreadMoveTarget | null,
): string | null {
  const home = origin.environmentLabel;
  if (origin.environmentPinned !== true) {
    return `This thread was started by an agent on ${home}, and this computer's link can't confirm which computer that is, so it stays here.`;
  }
  if (target === null) return null;
  if (target.environmentId !== origin.environmentId) return remoteOriginElsewhereWords(home);
  if (takes?.linkLineage !== true) {
    return `This thread was started by an agent on ${home}. Update Threadlines on ${target.label} to move it back there.`;
  }
  return null;
}

/**
 * Why a thread a move brought here, still behind the fence (`movedFrom.fenced`:
 * no person here has sent it a message yet), can't move to `target`, or null
 * (docs/design/fleet.md, Part 3f, (h)): it goes back to the computer it came
 * from, and nowhere else. Over a link that never proved which computer that
 * is (`environmentPinned`), where it came from is only the sender's word, so
 * it goes nowhere. Once a person here takes it over, the usual rules hold. A
 * null `target` asks about any computer: the dialog says per computer.
 *
 * The same holds for a thread another computer's agent started here that
 * its parent took back when it moved here (`adoptedFromLink.fenced`, Part
 * 3f, (g)): it goes back to that computer only, which its link proved.
 */
export function fencedMoveRefusal(
  thread: Pick<OrchestrationThread, "movedFrom" | "adoptedFromLink">,
  target: ThreadMoveTarget | null,
): string | null {
  if (target === null) return null;
  const from = thread.movedFrom ?? null;
  if (from !== null && from.fenced === true) {
    if (from.environmentPinned !== true) {
      return `This thread moved here from ${from.label}, and this computer's link can't confirm which computer that is, so it stays here until you send it a message.`;
    }
    if (target.environmentId !== from.environmentId) return fencedElsewhereWords(from.label);
  }
  const adopted = thread.adoptedFromLink ?? null;
  if (adopted !== null && adopted.fenced && target.environmentId !== adopted.environmentId) {
    return `This thread was started by an agent on ${adopted.label}, and until you send it a message here it can only move back to ${adopted.label}.`;
  }
  return null;
}

/** The words for a fenced moved thread, moving anywhere but back where it came from. */
export const fencedElsewhereWords = (from: string) =>
  `This thread moved here from ${from}, and until you send it a message here it can only move back to ${from}.`;

/** Whether a child is moving on its own (Part 3f, (h)): queued or under way, not in a family. */
const movesAlone = (thread: Pick<OrchestrationThread, "pendingMove" | "move">) => {
  const pending = thread.pendingMove ?? null;
  const move = thread.move ?? null;
  return (
    (pending !== null && pending.family === undefined) ||
    (move !== null && move.family === undefined && move.movedAway === undefined)
  );
};

/** The words for a thread another computer's agent started, moving anywhere but home. */
export const remoteOriginElsewhereWords = (home: string) =>
  `This thread was started by an agent on ${home}, which still directs it. It can move back to ${home}, not to another computer.`;

/**
 * Whether the parent a family names holds a move of that family: queued,
 * under way, or done (Part 3f, (g)). A child's move is only ever queued, and
 * only goes on, while it does.
 */
export function parentHoldsFamily(
  readModel: Pick<ThreadMoveView, "threads">,
  family: ThreadMoveFamily,
): boolean {
  return holdsFamily(
    readModel.threads.find((entry) => entry.id === family.parentThreadId),
    family,
  );
}

/** Whether `thread` (a family's parent, as read) holds a move of `family`. */
export const holdsFamily = (
  thread: Pick<OrchestrationThread, "pendingMove" | "move" | "deletedAt"> | undefined,
  family: ThreadMoveFamily,
) =>
  thread !== undefined &&
  thread.deletedAt === null &&
  (thread.pendingMove?.family?.id === family.id || thread.move?.family?.id === family.id);

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
  takes?: ThreadMoveTakes | null,
  family?: ThreadMoveFamily,
  target?: ThreadMoveTarget | null,
): string | null {
  const refusals = threadMoveRefusals(readModel, thread, takes, family, target);
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
  // What the provider reports of its goal as the move's stop pauses it: the
  // goal bar must say what the provider holds, should the move be dropped.
  "thread.goal.state.set",
  "thread.pull-request.link",
  "thread.diffstat.rebase",
  "thread.realtime.state.set",
  "thread.settings-change.settle",
  "thread.settings-change.report-device",
  // A linked computer confirmed the cancels the move's stop owed it (Part
  // 3f, (g)): they drain from a frozen parent, never stranded on it.
  "thread.remote-cancels.delivered",
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
  // The queue doesn't drain while a move waits, or the thread is never free
  // (docs/design/fleet.md, Part 3e, (e)); what goes into a running turn still does.
  "thread.follow-up.send-queued",
  // An agent's new request of another (a hand-off, an ask, a review, an
  // invite) starts work; its open ones still settle (Part 3f, review change 4).
  "thread.agent-request.submit",
  // So does a new thread, or a new message to one; answers already owed
  // still come back (Part 3f, (g), review change 4).
  "thread.child.start",
  "thread.child.send",
]);

/**
 * Whether `command`, on its own thread, starts work there. While a move
 * waits for its thread (`waiting`), a room agent's hand-off or reply, or the
 * family's request or answer, already queued is still sent: what the thread
 * has going drains, so it gets free (docs/design/fleet.md, Part 3f, review
 * change 4). Not from `quiescing` on.
 */
function startsWork(command: OrchestrationCommand, thread: OrchestrationThread): boolean {
  if (!WORK_START_COMMANDS.has(command.type)) return false;
  switch (command.type) {
    // Turning a switch off is always allowed.
    case "thread.pull-request-automation.set":
      return (
        command.autoFix === true || (command.autoMerge !== undefined && command.autoMerge !== null)
      );
    case "thread.continue-at-reset.set":
      return command.enabled;
    case "thread.follow-up.send-queued": {
      if (command.steeredTurnId !== undefined || command.steerIntoTurnId !== undefined) {
        return false;
      }
      const queued = (thread.queuedFollowUps ?? []).find(
        (entry) => entry.messageId === command.messageId,
      );
      return !(
        thread.pendingMove?.stage === "waiting" &&
        queued !== undefined &&
        drainsWhileMoveWaits(thread, queued)
      );
    }
    default:
      return true;
  }
}

/**
 * Whether `command` is the turn a room's queued hand-off or reply, or the
 * family's request or answer, starts as it is sent while the move waits
 * (docs/design/fleet.md, Part 3f, review change 4): the turn for exactly that
 * message, only at `waiting`.
 */
function drainsRoomChain(
  thread: OrchestrationThread,
  command: OrchestrationCommand,
  drained: OrchestrationQueuedFollowUp | undefined,
): boolean {
  return (
    drained !== undefined &&
    command.type === "thread.turn.start" &&
    command.message.messageId === drained.messageId &&
    thread.pendingMove?.stage === "waiting" &&
    (thread.move ?? null) === null &&
    drainsWhileMoveWaits(thread, drained)
  );
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
  /**
   * A room's queued hand-off or reply being sent now (`thread.follow-up.send-queued`
   * deciding its turn): that turn is the chain draining, not new work.
   */
  drained?: OrchestrationQueuedFollowUp,
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
      startsWork(command, thread) &&
      !drainsRoomChain(thread, command, drained)
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
  // What the other computer said just now that it takes.
  const takes = command.targetTakes;
  if (queuedRequestId === undefined) {
    if (pending !== null) {
      return refuse(`A move to ${pending.target.label} is already waiting. Cancel it first.`);
    }
    // A move that doesn't wait never takes a family (Part 3f, (g)): an app
    // that starts one expects the thread's children to come, so a thread with
    // any is refused as before; nor does it cross the link its work came
    // over (Part 3f, (h)). Both move through the queue.
    const { families: _families, linkLineage: _linkLineage, ...alone } = takes ?? {};
    const refusal = threadMoveRefusal(readModel, thread, alone, undefined, command.target);
    if (refusal !== null) return refuse(refusal);
  } else {
    if (pending === null || pending.requestId !== queuedRequestId) {
      return refuse("That queued move was cancelled or replaced.");
    }
    const refusals = threadMoveRefusals(readModel, thread, takes, undefined, command.target);
    const block = firstMoveBlock(refusals);
    if (block !== null) return refuse(block.words);
    if (refusals.length > 0) return refuse(BUSY_WORDS);
    if (pending.stage !== "quiescing" || !sessionStopped(thread)) {
      return refuse("This thread's agent hasn't stopped yet.");
    }
  }
  // What its stop took: a queued move's, with what a stop planned here (a
  // direct move whose session still runs) takes now.
  // What an earlier move that didn't happen still owes the thread comes along.
  const owed = thread.moveRestoreOwed ?? null;
  const interrupted =
    queuedRequestId !== undefined
      ? mergeInterrupted(thread, pending?.interrupted)
      : sessionStopped(thread) && owed === null
        ? undefined
        : mergeInterrupted(thread, owed?.interrupted);
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
      ...(pending?.batchId !== undefined && queuedRequestId !== undefined
        ? { batchId: pending.batchId }
        : {}),
      ...(interrupted !== undefined ? { interrupted } : {}),
      ...(takes !== undefined ? { targetTakes: takes } : {}),
      ...(command.roomAgents !== undefined ? { roomAgents: command.roomAgents } : {}),
      ...(pending?.family !== undefined && queuedRequestId !== undefined
        ? { family: pending.family }
        : {}),
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
  // The move holds what was owed now (its `interrupted`).
  const absorbed = owed !== null ? [restoreSet(thread, null, command.createdAt, baseFor)] : [];
  if (sessionStopped(thread)) {
    return [...cancelled, ...absorbed, ...queueEnded, started];
  }
  return [
    ...cancelled,
    ...absorbed,
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

/** Records what a move that didn't happen owes the thread back, or (null) that it is paid. */
function restoreSet(
  thread: OrchestrationThread,
  owed: ThreadMoveRestore | null,
  at: string,
  baseFor: EventBase,
): PlannedEvent {
  return {
    ...baseFor(thread.id),
    type: "thread.move-restore-set",
    payload: { threadId: thread.id, moveRestoreOwed: owed, updatedAt: at },
  };
}

/**
 * What a move that ends without moving owes the thread (docs/design/fleet.md,
 * Part 3e, "Put back"): what its stop took, and a send of the queued messages
 * that waited for it. None when there is nothing to put back.
 */
function restoreOwedEvents(
  thread: OrchestrationThread,
  target: ThreadMoveTarget,
  interrupted: ThreadMoveInterrupted | undefined,
  at: string,
  baseFor: EventBase,
): PlannedEvent[] {
  // An archived or deleted thread is gone: nothing starts on it.
  if (thread.deletedAt !== null || thread.archivedAt !== null) return [];
  const queued = (thread.queuedFollowUps ?? []).length > 0;
  if (interrupted === undefined && !queued) return [];
  return [
    restoreSet(
      thread,
      {
        target,
        ...(interrupted !== undefined ? { interrupted } : {}),
        ...(queued ? { queued: true as const } : {}),
        at,
      },
      at,
      baseFor,
    ),
  ];
}

/**
 * Ending every runtime of the thread: "Stop and move now", and the barrier
 * before a freeze. Every side answer runs in a runtime of its own (a room
 * can have several). A room's agents still asking each other end as Stop
 * ends them (decideAgentChainStop: their requests settle as stopped, their
 * queued messages are taken back); a room with nothing open keeps its chain
 * as it is, so a cancelled move doesn't leave it held.
 */
function sessionStopEvents(
  thread: OrchestrationThread,
  createdAt: string,
  baseFor: EventBase,
): PlannedEvent[] {
  const chainOpen =
    thread.agentRequests.open.length > 0 ||
    liveSideTurns(thread).some((sideTurn) => sideTurn.askedBy !== undefined) ||
    (thread.queuedFollowUps ?? []).some(isAgentOrigin);
  const chainStop = chainOpen
    ? decideAgentChainStop(thread, () => baseFor(thread.id), createdAt)
    : [];
  return [
    {
      ...baseFor(thread.id),
      type: "thread.session-stop-requested",
      payload: { threadId: thread.id, createdAt },
    },
    // The chain's stop already interrupts the answers agents asked for.
    ...liveSideTurns(thread)
      .filter((sideTurn) => chainStop.length === 0 || sideTurn.askedBy === undefined)
      .map((sideTurn): PlannedEvent => ({
        ...baseFor(thread.id),
        type: "thread.side-turn-interrupt-requested",
        payload: { threadId: thread.id, sideTurnId: sideTurn.sideTurnId, createdAt },
      })),
    ...chainStop,
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
  // A family's member names its family; a child's must be its parent's (Part 3f, (g)).
  if (
    command.family?.parentThreadId !== undefined &&
    command.family.parentThreadId !== thread.parentThreadId
  ) {
    return refuse("That thread didn't start this one.");
  }
  const refusals = threadMoveRefusals(
    readModel,
    thread,
    command.targetTakes,
    command.family,
    command.target,
  );
  const block = firstMoveBlock(refusals);
  if (block !== null) return refuse(block.words);
  // A command runs in the user's own terminal tab, which the server doesn't
  // stop: "Stop and move now" would wait on it with nothing to show why.
  if (command.mode === "stop-now" && refusals.some((entry) => entry.code === "command_run")) {
    return refuse(STOP_NOW_COMMAND_RUN_WORDS);
  }
  // What an earlier move that didn't happen still owes comes along, and what
  // "Stop and move now" stops is recorded before it is gone: its waits on the
  // threads it started end as Stop ends them (the caller plans that).
  const owed = thread.moveRestoreOwed ?? null;
  const interrupted =
    command.mode === "stop-now"
      ? mergeInterrupted(thread, owed?.interrupted, thread.childRequests.open.length)
      : owed?.interrupted;
  const queued: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.move-queued",
    payload: {
      threadId: thread.id,
      pendingMove: {
        requestId: command.requestId,
        target: command.target,
        ...(command.agent !== undefined ? { agent: command.agent } : {}),
        mode: command.mode,
        stage: command.mode === "stop-now" ? "quiescing" : "waiting",
        requestedAt: command.createdAt,
        requestedBy: command.requestedBy,
        waitsFor: moveWaitsOf(refusals),
        hold: null,
        ...(command.batchId !== undefined ? { batchId: command.batchId } : {}),
        ...(interrupted !== undefined ? { interrupted } : {}),
        ...(command.targetTakes !== undefined ? { targetTakes: command.targetTakes } : {}),
        ...(command.roomAgents !== undefined ? { roomAgents: command.roomAgents } : {}),
        ...(command.family !== undefined ? { family: command.family } : {}),
      },
    },
  };
  const absorbed = owed !== null ? [restoreSet(thread, null, command.createdAt, baseFor)] : [];
  return command.mode === "stop-now"
    ? [...absorbed, queued, ...sessionStopEvents(thread, command.createdAt, baseFor)]
    : [...absorbed, queued];
}

/**
 * "Stop the agents and move now" for a move already waiting (docs/design/
 * fleet.md, Part 3c): the queued move `requestId` switches to `stop-now`, and
 * its thread's sessions end in the same decision, as a move queued that way
 * does. One that already started, ended or was replaced changes nothing; the
 * caller adds what Stop holds (command output that would wake the agent).
 */
export function decideMoveSetMode(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.set-mode">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = currentPendingMove(thread, command.requestId);
  if (pending === null || pending.mode === command.mode) return [];
  const refusals = threadMoveRefusals(readModel, thread, pending.targetTakes);
  if (refusals.some((entry) => entry.code === "command_run")) {
    return refuse(STOP_NOW_COMMAND_RUN_WORDS);
  }
  const interrupted = mergeInterrupted(
    thread,
    pending.interrupted,
    thread.childRequests.open.length,
  );
  const modeSet: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.move-mode-set",
    payload: {
      threadId: thread.id,
      requestId: command.requestId,
      mode: command.mode,
      ...(interrupted !== undefined ? { interrupted } : {}),
      updatedAt: command.createdAt,
    },
  };
  return sessionStopped(thread) &&
    liveSideTurns(thread).length === 0 &&
    thread.childRequests.open.length === 0
    ? [modeSet]
    : [modeSet, ...sessionStopEvents(thread, command.createdAt, baseFor)];
}

/**
 * A child whose own move ended here after its parent moved to another
 * computer (docs/design/fleet.md, Part 3f, (g)): it stays as its own thread,
 * and says why. Nothing for any other thread.
 */
function leftBehindAfterParent(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  at: string,
  baseFor: EventBase,
): ReadonlyArray<PlannedEvent> {
  if (thread.parentThreadId === null || !thread.attachedToParent) return [];
  const parent = readModel.threads.find((entry) => entry.id === thread.parentThreadId);
  const move = parent?.move ?? null;
  if (parent === undefined || move === null || move.movedAway === undefined) return [];
  return leftBehindEvents(readModel, baseFor, parent, thread, move.target.label, at);
}

/** Cancel: the queued move `requestId` ends; a cancel for an older one changes nothing. */
export function decideMoveUnqueue(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.unqueue">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = currentPendingMove(thread, command.requestId);
  if (pending === null) return [];
  return [
    ...leftBehindAfterParent(readModel, thread, command.createdAt, baseFor),
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
    ...restoreOwedEvents(thread, pending.target, pending.interrupted, command.createdAt, baseFor),
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
  const refusals = threadMoveRefusals(readModel, thread, pending.targetTakes);
  const block = firstMoveBlock(refusals);
  if (block !== null) return refuse(block.words);
  if (refusals.length > 0) return refuse(BUSY_WORDS);
  // What the stop takes, recorded before it is gone; only ever added to, so a
  // move that went back to waiting doesn't forget its goal was working.
  const interrupted = mergeInterrupted(thread, pending.interrupted);
  const quiescing: PlannedEvent = {
    ...baseFor(thread.id),
    type: "thread.move-quiescing",
    payload: {
      threadId: thread.id,
      requestId: command.requestId,
      ...(interrupted !== undefined ? { interrupted } : {}),
      updatedAt: command.createdAt,
    },
  };
  if (pending.stage === "quiescing") {
    if (sessionStopped(thread)) return [];
    return [
      ...(sameInterrupted(interrupted, pending.interrupted) ? [] : [quiescing]),
      ...sessionStopEvents(thread, command.createdAt, baseFor),
    ];
  }
  return [quiescing, ...sessionStopEvents(thread, command.createdAt, baseFor)];
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
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.queue-end">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const pending = currentPendingMove(thread, command.requestId);
  if (pending === null) return [];
  const leftBehind =
    command.reason === "blocked"
      ? leftBehindAfterParent(readModel, thread, command.createdAt, baseFor)
      : [];
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
    // An archived or deleted thread gets nothing back.
    ...(command.reason === "blocked"
      ? restoreOwedEvents(thread, pending.target, pending.interrupted, command.createdAt, baseFor)
      : []),
    ...leftBehind,
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
        ...(command.waitingForTarget === true ? { waitingForTarget: true } : {}),
        ...(command.sentBytes !== undefined ? { sentBytes: command.sentBytes } : {}),
        ...(command.totalBytes !== undefined ? { totalBytes: command.totalBytes } : {}),
        ...(command.staged === true ? { staged: true } : {}),
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

/**
 * The other computer confirmed the move was dropped: the thread unfreezes, and
 * says why. A child whose parent moved meanwhile stays as its own thread.
 */
export function decideMoveAbort(
  readModel: OrchestrationReadModel,
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
        ...(command.code !== undefined ? { code: command.code } : {}),
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
    ...restoreOwedEvents(thread, move.target, move.interrupted, command.createdAt, baseFor),
    ...leftBehindAfterParent(readModel, thread, command.createdAt, baseFor),
  ];
}

/**
 * The other computer committed the move: the thread lives there now, and its
 * copy here is read-only. Its children here that didn't come with it (not
 * moving in its family, archived ones aside) become their own threads in the
 * same decision (docs/design/fleet.md, Part 3f, (g)), and the threads it
 * started on that computer that are its children there now (`adopted`)
 * leave its records. A child that moved without its parent leaves the family
 * here, and stays the parent's child on that computer when that computer
 * kept it so (`keptParent`, Part 3f, (h)).
 */
export function decideMoveComplete(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.complete">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const move = currentMove(thread, command.transferId);
  if (move === null) return refuse("This thread isn't moving.");
  if (move.movedAway !== undefined) return [];
  return moveCompleteEvents(readModel, thread, move, command, baseFor);
}

/**
 * decideMoveComplete's events for a move under way. Also what an import
 * that proves a lone child's move landed records for it (`completesMoveOf`):
 * the thread came back before this computer heard (`returned: "adopted"`).
 * A lone child whose moved thread is already back here never becomes the
 * parent's child on that computer, whichever came first.
 */
function moveCompleteEvents(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
  move: OrchestrationThreadMove,
  command: Pick<
    CommandOf<"thread.move.complete">,
    "transferId" | "movedThreadId" | "keptParent" | "adopted" | "createdAt"
  >,
  baseFor: EventBase,
  returned?: "adopted",
): PlannedEvent[] {
  const familyId = move.family?.id;
  const comesAlong = (child: OrchestrationThread) =>
    familyId !== undefined &&
    (child.pendingMove?.family?.id === familyId || child.move?.family?.id === familyId);
  const leftBehind = readModel.threads
    .filter(
      (child) =>
        child.parentThreadId === thread.id &&
        child.attachedToParent &&
        child.deletedAt === null &&
        child.archivedAt === null &&
        !comesAlong(child),
    )
    .flatMap((child) =>
      leftBehindEvents(readModel, baseFor, thread, child, move.target.label, command.createdAt),
    );
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
    ...readOnlyCopyEvents(thread, command.createdAt, baseFor),
    ...leftBehind,
    // Its threads on that computer that are its children there now (Part 3f, (g)).
    ...adoptedThereEvents(
      readModel,
      baseFor,
      thread,
      move.target.environmentId,
      command.adopted ?? [],
      command.createdAt,
    ),
    ...(move.family === undefined
      ? movedAloneEvents(
          readModel,
          baseFor,
          thread,
          {
            target: move.target,
            threadId: command.movedThreadId,
            keptParent: command.keptParent === true,
            returned:
              returned ??
              (cameBackFrom(readModel, move.target.environmentId, command.movedThreadId)
                ? "own"
                : undefined),
          },
          command.createdAt,
        )
      : []),
  ];
}

/**
 * Whether the thread `threadId` on `environmentId` has since moved here.
 * One deleted since still came back: that computer's copy is read-only.
 */
const cameBackFrom = (
  readModel: Pick<OrchestrationReadModel, "threads">,
  environmentId: string,
  threadId: string,
) =>
  readModel.threads.some(
    (entry) =>
      entry.movedFrom?.environmentId === environmentId && entry.movedFrom.threadId === threadId,
  );

/**
 * Whether `thread` is `parentThreadId`'s child here moving on its own
 * (docs/design/fleet.md, Part 3f, (h)) to `environmentId`, with that
 * computer's answer still to come: the move a thread coming back from there
 * can complete (`thread.import`'s `adopt.completesMoveOf`).
 */
export function awaitsLoneMoveAnswer(
  thread: Pick<OrchestrationThread, "deletedAt" | "parentThreadId" | "attachedToParent" | "move">,
  parentThreadId: ThreadId,
  environmentId: string,
): boolean {
  const move = thread.move ?? null;
  return (
    thread.deletedAt === null &&
    thread.parentThreadId === parentThreadId &&
    thread.attachedToParent &&
    move !== null &&
    move.family === undefined &&
    move.movedAway === undefined &&
    move.target.environmentId === environmentId
  );
}

/**
 * The read-only copy a moved thread leaves keeps nothing that acts for it
 * (docs/design/fleet.md, Part 3e): its queued messages went with it, and its
 * pull request switches are off, so neither the queue nor the watcher here
 * ever works for a thread that lives on the other computer now.
 */
function readOnlyCopyEvents(
  thread: OrchestrationThread,
  at: string,
  baseFor: EventBase,
): PlannedEvent[] {
  const unqueued: PlannedEvent[] = (thread.queuedFollowUps ?? []).map((entry) => ({
    ...baseFor(thread.id),
    type: "thread.follow-up-unqueued",
    payload: {
      threadId: thread.id,
      messageId: entry.messageId,
      reason: "cancelled",
      createdAt: at,
    },
  }));
  const switchesOff = (pullRequestNumber?: number): PlannedEvent => ({
    ...baseFor(thread.id),
    type: "thread.pull-request-automation-changed",
    payload: {
      threadId: thread.id,
      ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
      autoFix: false,
      autoMerge: null,
      updatedAt: at,
    },
  });
  const own = thread.pullRequestAutoFix || thread.pullRequestAutoMerge !== null;
  const linked = (thread.linkedPullRequests ?? []).filter(
    (entry) => entry.autoFix || entry.autoMerge !== null,
  );
  return [
    ...unqueued,
    ...(own ? [switchesOff()] : []),
    ...linked.map((entry) => switchesOff(entry.number)),
  ];
}

/** The "Moved here" line's word on the fence a moved thread works behind (ThreadMovedFrom.fenced). */
const MOVED_FENCE_WORDS =
  "Its agent can't use other threads, rooms or schedules here until you send it a message.";
/** The same for a child that stays its parent's across the link: fenced for good (Part 3f, (h)). */
const remoteParentFenceWords = (origin: NonNullable<OrchestrationThread["remoteOrigin"]>) =>
  `Started by '${origin.threadTitle}' on ${origin.environmentLabel}, which still directs it. Its agent can't use other threads, rooms or schedules here.`;

/**
 * A moved thread arriving: created with its history and the boundary that
 * says where it came from, in one decision. Refused when the thread exists,
 * so a repeated import is no second copy. Every import comes from another
 * computer, so the thread arrives fenced (docs/design/fleet.md, Part 3e).
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
  const roomRefusal = importedRoomRefusal(command);
  if (roomRefusal !== null) return refuse(roomRefusal);
  const familyRefusal = importedFamilyRefusal(readModel, command);
  if (familyRefusal !== null) return refuse(familyRefusal);
  const linkRefusal = importedLinkLineageRefusal(readModel, command);
  if (linkRefusal !== null) return refuse(linkRefusal);
  const adoption = importedAdoption(readModel, command);
  // Every id it brings is its own: one another thread here already has would
  // move that thread's message into this one (the projection keys messages
  // by id alone).
  const incoming = new Set<string>([
    ...command.messages.map((message) => message.messageId),
    ...(command.queuedFollowUps ?? []).map((entry) => entry.messageId),
    ...(command.arrival?.message !== undefined ? [command.arrival.message.messageId] : []),
  ]);
  if (
    readModel.threads.some(
      (thread) =>
        thread.id !== command.threadId &&
        thread.messages.some((message) => incoming.has(message.id)),
    )
  ) {
    return refuse("A message it brings is already another thread's here.");
  }
  const lineage = command.lineage;
  const adopt = command.adopt;
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
      // A child that came with its parent (Part 3f, (g)): in its family here,
      // its answers owed nothing yet (a fresh attachment epoch).
      ...(lineage !== undefined
        ? {
            parentThreadId: lineage.parentThreadId,
            ...(lineage.parentTurnId !== null ? { parentTurnId: lineage.parentTurnId } : {}),
            attachedToParent: true,
          }
        : {}),
      // Back home, under the thread that started it there (Part 3f, (h)).
      ...(adopt !== undefined
        ? { parentThreadId: adopt.parentThreadId, attachedToParent: true }
        : {}),
      // Still its parent's on the computer it came from, fenced for good (Part 3f, (h)).
      ...(command.remoteOrigin !== undefined ? { remoteOrigin: command.remoteOrigin } : {}),
      // A family member in another member's folder: never its owner here.
      ...(command.worktreeOrigin !== undefined ? { worktreeOrigin: command.worktreeOrigin } : {}),
      // It came from another computer: fenced until the user here sends it a message.
      movedFrom: { ...command.movedFrom, fenced: true },
      historySeedOwed: true,
      ...(command.nativeSession !== undefined ? { nativeSession: command.nativeSession } : {}),
      // An agent outside work limited there stays limited here.
      ...(command.outsideWork !== undefined && command.outsideWork.length > 0
        ? { outsideWork: command.outsideWork }
        : {}),
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    },
  };
  // A room's agents (Part 3f, (i)), written as a room set up with the thread is.
  const room: PlannedEvent[] = [
    ...(command.agentRole !== undefined
      ? [
          {
            ...base(),
            type: "thread.participant-updated" as const,
            payload: {
              threadId: command.threadId,
              participantId: null,
              role: command.agentRole,
              updatedAt: command.createdAt,
            },
          },
        ]
      : []),
    ...(command.participants ?? []).map((participant): PlannedEvent => ({
      ...base(),
      type: "thread.participant-added",
      payload: { threadId: command.threadId, participant, updatedAt: command.createdAt },
    })),
  ];
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
      // A room's: who it was to or from, and the request it made or answered.
      ...(message.participantId !== undefined ? { participantId: message.participantId } : {}),
      ...(message.fromAgent !== undefined ? { fromAgent: message.fromAgent } : {}),
      ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
      ...(message.requestKind !== undefined ? { requestKind: message.requestKind } : {}),
      ...(message.requestOutcome !== undefined ? { requestOutcome: message.requestOutcome } : {}),
      ...(message.requestError !== undefined ? { requestError: message.requestError } : {}),
      // A family's request or answer between threads that moved together.
      ...(message.fromThread !== undefined ? { fromThread: message.fromThread } : {}),
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    },
  }));
  const activities: PlannedEvent[] = command.activities.map((activity) => ({
    ...base(),
    type: "thread.activity-appended",
    payload: { threadId: command.threadId, activity: { ...activity, turnId: null } },
  }));
  const arrival = command.arrival;
  const brought = [...(arrival?.brought ?? []), ...adoption.brought];
  const left = [
    ...(arrival?.left ?? []),
    ...adoption.left,
    command.remoteOrigin !== undefined
      ? remoteParentFenceWords(command.remoteOrigin)
      : MOVED_FENCE_WORDS,
  ];
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
          // Which the agent got: its own session, or (absent) a summary.
          ...(command.nativeSession !== undefined ? { nativeSession: command.nativeSession } : {}),
          // What came along, and what didn't, in plain words.
          ...(brought.length > 0 ? { brought } : {}),
          left,
        },
        turnId: null,
        createdAt: command.createdAt,
      },
    },
  };
  // Home again: the parent's record of it on the computer it came from goes.
  const adoptedBy =
    adopt === undefined
      ? undefined
      : readModel.threads.find((thread) => thread.id === adopt.parentThreadId);
  const cameHome =
    adoptedBy === undefined
      ? []
      : cameHomeEvents(
          readModel,
          baseFor,
          adoptedBy,
          { environmentId: command.movedFrom.environmentId, threadId: command.movedFrom.threadId },
          command.createdAt,
        );
  // Its arrival proves the move it left on landed there: that move completes
  // now, unless its answer already did (the parent then held it, above).
  const returned =
    adoptedBy === undefined ? null : returnCompletes(readModel, command, adoptedBy.id);
  const completed =
    returned === null
      ? []
      : moveCompleteEvents(
          readModel,
          returned.thread,
          returned.move,
          {
            transferId: returned.move.transferId,
            movedThreadId: command.movedFrom.threadId,
            createdAt: command.createdAt,
          },
          baseFor,
          "adopted",
        );
  return [
    created,
    ...room,
    ...messages,
    ...activities,
    ...importedState(command, base),
    boundary,
    ...adoptedEvents(command, adoption.adopted, baseFor),
    ...cameHome,
    ...completed,
  ];
}

/** At most this many titles a "Moved here" line names. */
const ADOPTED_TITLES_NAMED = 10;

const titlesOf = (threads: ReadonlyArray<{ readonly title: string }>) =>
  threads
    .slice(0, ADOPTED_TITLES_NAMED)
    .map((thread) => thread.title)
    .join(", ");

/**
 * Which of the threads here that the arriving thread's agent started over
 * its link (`adoptsChildren`, docs/design/fleet.md, Part 3f, (g)) become its
 * children, and the "Moved here" words for them and for the ones that stay
 * apart. Never refuses the import: a thread that doesn't qualify stays as it
 * is, with why. One gone meanwhile is left out of the words.
 */
function importedAdoption(
  readModel: OrchestrationReadModel,
  command: CommandOf<"thread.import">,
): {
  readonly adopted: ReadonlyArray<{
    readonly thread: OrchestrationThread;
    readonly override: OrchestrationThreadDoneOverride | undefined;
  }>;
  readonly brought: ReadonlyArray<string>;
  readonly left: ReadonlyArray<string>;
} {
  const asked = command.adoptsChildren;
  // Only a thread arriving on its own takes threads as its children here.
  if (
    asked === undefined ||
    command.lineage !== undefined ||
    command.remoteOrigin !== undefined ||
    command.adopt !== undefined
  ) {
    return { adopted: [], brought: [], left: [] };
  }
  const adopted: Array<{
    readonly thread: OrchestrationThread;
    readonly override: OrchestrationThreadDoneOverride | undefined;
  }> = [];
  const apart: Array<{ readonly title: string; readonly why: string }> = [];
  const seen = new Set<string>();
  for (const entry of asked.children) {
    if (seen.has(entry.threadId)) continue;
    seen.add(entry.threadId);
    const child = readModel.threads.find((thread) => thread.id === entry.threadId);
    if (child === undefined || child.deletedAt !== null) continue;
    const why = adoptionRefusal(readModel, command, asked.linkDeviceId, child);
    if (why === null) adopted.push({ thread: child, override: entry.override });
    else apart.push({ title: child.title, why });
  }
  const [only] = adopted;
  const brought =
    adopted.length === 0
      ? []
      : [
          adopted.length === 1 && only !== undefined
            ? `Its thread '${only.thread.title}' was already on this computer. It's this thread's again.`
            : `Its ${adopted.length} threads already on this computer are this thread's again: ${titlesOf(adopted.map((entry) => entry.thread))}.`,
        ];
  const left = apart.map(
    (entry) =>
      `Its thread '${entry.title}' is already on this computer. It stays separate because ${entry.why}, so this thread can't reach it.`,
  );
  return { adopted, brought, left };
}

/**
 * Why `child`, a thread here, can't become the arriving thread's child, in
 * words that finish "It stays separate because ...", or null. It must be
 * one this very link started for the very thread that arrives, from the
 * computer that link proved it is; in the arriving thread's project; not
 * archived, moving or a parent itself; and asking no more access than the
 * arriving thread has here (its modes as this import writes them): a child
 * never has more access than its parent, and its access is never lowered
 * for it.
 */
function adoptionRefusal(
  readModel: OrchestrationReadModel,
  command: CommandOf<"thread.import">,
  linkDeviceId: string,
  child: OrchestrationThread,
): string | null {
  const origin = child.remoteOrigin ?? null;
  if (
    origin === null ||
    origin.linkDeviceId !== linkDeviceId ||
    origin.threadId !== command.movedFrom.threadId ||
    origin.environmentPinned !== true ||
    command.movedFrom.environmentPinned !== true ||
    origin.environmentId !== command.movedFrom.environmentId
  ) {
    return "this computer can't confirm this thread started it";
  }
  if (child.projectId !== command.projectId) return "it's in another project here";
  if (child.archivedAt !== null) return "it's archived";
  if ((child.move ?? null) !== null || (child.pendingMove ?? null) !== null) {
    return "it's moving";
  }
  if (
    (child.parentThreadId !== null && child.attachedToParent) ||
    attachedChildrenOf(readModel, child.id).length > 0
  ) {
    return "it's in another family here";
  }
  if (
    !withinModeCeiling(child, {
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
    })
  ) {
    return "it has more access than this thread has here";
  }
  return null;
}

/**
 * Each adopted thread becomes the arriving thread's child (no parent turn, a
 * fresh attachment epoch, so nothing owed under its old one comes back),
 * stops being the other computer's (`remoteOrigin` goes) and works fenced
 * until the user here sends it a message (`adoptedFromLink`). The user's
 * Wrap up or Reopen given there stands when it is newer than the one here
 * (the rule `fromLinkedComputer` follows). Its timeline says what happened.
 */
function adoptedEvents(
  command: CommandOf<"thread.import">,
  adopted: ReadonlyArray<{
    readonly thread: OrchestrationThread;
    readonly override: OrchestrationThreadDoneOverride | undefined;
  }>,
  baseFor: EventBase,
): PlannedEvent[] {
  const at = command.createdAt;
  const label = command.movedFrom.label;
  return adopted.flatMap(({ thread, override }): PlannedEvent[] => {
    const epoch = thread.parentAttachmentEpoch + 1;
    const newer =
      override !== undefined &&
      (thread.doneOverride === null ||
        Date.parse(thread.doneOverride.at) < Date.parse(override.at));
    return [
      {
        ...baseFor(thread.id),
        type: "thread.parent-attachment-set",
        payload: {
          threadId: thread.id,
          attached: true,
          attachmentEpoch: epoch,
          at,
          adoptedBy: {
            parentThreadId: command.threadId,
            fromLink: { environmentId: command.movedFrom.environmentId, label, fenced: true },
          },
        },
      },
      ...(newer
        ? [
            {
              ...baseFor(thread.id),
              type: "thread.done-override-set" as const,
              payload: { threadId: thread.id, state: override.state, at: override.at },
            },
          ]
        : []),
      {
        ...baseFor(thread.id),
        type: "thread.activity-appended",
        payload: {
          threadId: thread.id,
          activity: {
            id: EventId.make(`adopted-by-moved-parent:${thread.id}:${epoch}`),
            tone: "info",
            kind: AdoptedByMovedParentActivityKind,
            summary: `'${command.title}' moved here from ${label}, and this is its thread again. Its agent can't use other threads, rooms or schedules here until you send it a message.`,
            payload: { parentThreadId: command.threadId, fromLabel: label },
            turnId: null,
            createdAt: at,
          },
        },
      },
    ];
  });
}

/** Activity on a thread its parent took back when it moved here (Part 3f, (g)). */
export const AdoptedByMovedParentActivityKind = "thread.adopted-by-moved-parent";

/**
 * Why a thread moving across the link its work came over can't land as it
 * says, or null (docs/design/fleet.md, Part 3f, (h)). Both kinds move on
 * their own, never in a family. `remoteOrigin` keeps it the child of a
 * thread on the computer it came from, only for a link that proved which
 * computer that is. `adopt` puts it under one of this computer's threads
 * only when that thread already holds exactly this thread, on exactly that
 * computer, as its child: a linked computer can never attach a thread under
 * one of this computer's own.
 */
function importedLinkLineageRefusal(
  readModel: OrchestrationReadModel,
  command: CommandOf<"thread.import">,
): string | null {
  const origin = command.remoteOrigin;
  const adopt = command.adopt;
  if (origin === undefined && adopt === undefined) return null;
  if (origin !== undefined && adopt !== undefined) return "A thread lands under one parent.";
  if (
    command.lineage !== undefined ||
    command.movedFrom.familyKey !== undefined ||
    command.worktreeOrigin !== undefined
  ) {
    return "A thread that moves across its link moves on its own.";
  }
  if (origin !== undefined) {
    if (origin.environmentPinned !== true) {
      return "Only a link that proved its computer can keep a thread's parent.";
    }
    if (origin.environmentId !== command.movedFrom.environmentId) {
      return "It can only stay the child of a thread on the computer it came from.";
    }
    return null;
  }
  if (adopt === undefined) return null;
  const parent = readModel.threads.find((entry) => entry.id === adopt.parentThreadId);
  if (parent === undefined || parent.deletedAt !== null) {
    return "The thread that started it isn't here.";
  }
  if ((parent.move ?? null) !== null || (parent.pendingMove ?? null) !== null) {
    return "The thread that started it is moving.";
  }
  if (parent.parentThreadId !== null && parent.attachedToParent) {
    return "The thread that started it is itself another thread's.";
  }
  if (parent.projectId !== command.projectId) {
    return "The thread that started it is in another project.";
  }
  const held = (parent.childRequests.remoteChildren ?? []).some(
    (entry) =>
      entry.environmentId === command.movedFrom.environmentId &&
      entry.threadId === command.movedFrom.threadId,
  );
  if (held) return null;
  // Back before this computer heard its move there landed. Had the answer
  // landed first, the parent holds it (above).
  return returnCompletes(readModel, command, parent.id) !== null
    ? null
    : "The thread that started it doesn't hold this thread.";
}

/**
 * The move an import coming home completes (`adopt.completesMoveOf`), or
 * null: the thread it moved over from is still `parentThreadId`'s child
 * here, moving alone to exactly the computer it comes from with that
 * computer's answer still to come, and the import is the very copy that
 * move made there (its id is the one the transfer gives it there, from this
 * computer's device on that computer). Anything else could put another
 * thread under the parent, or end a move that never landed.
 */
function returnCompletes(
  readModel: Pick<OrchestrationReadModel, "threads">,
  command: CommandOf<"thread.import">,
  parentThreadId: ThreadId,
): { readonly thread: OrchestrationThread; readonly move: OrchestrationThreadMove } | null {
  const completes = command.adopt?.completesMoveOf;
  if (completes === undefined) return null;
  const thread = readModel.threads.find((entry) => entry.id === completes.threadId);
  const move = thread?.move ?? null;
  return thread !== undefined &&
    move !== null &&
    awaitsLoneMoveAnswer(thread, parentThreadId, command.movedFrom.environmentId) &&
    linkMoveCopyThreadId(completes.deviceId, move.transferId) === command.movedFrom.threadId
    ? { thread, move }
    : null;
}

/**
 * Why a moved room's agents can't be written as they are, or null: at most
 * PEER_MOVE_ROOM_MAX_PARTICIPANTS, each with a UUID id of its own, no two
 * agents still in the room with one name, and every message and outside
 * mark naming an agent that came.
 */
function importedRoomRefusal(command: CommandOf<"thread.import">): string | null {
  const participants = command.participants ?? [];
  if (participants.length > PEER_MOVE_ROOM_MAX_PARTICIPANTS) return "The room has too many agents.";
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const participant of participants) {
    if (!isValidParticipantId(participant.id) || ids.has(participant.id)) {
      return `Agent '${participant.id}' can't be added.`;
    }
    ids.add(participant.id);
    if (participant.leftAt !== null) continue;
    const handle = participant.handle.trim().toLowerCase();
    if (handles.has(handle)) return `Two agents are called ${participant.handle}.`;
    handles.add(handle);
  }
  const known = (id: string | null | undefined) => id === null || id === undefined || ids.has(id);
  for (const message of command.messages) {
    if (!known(message.participantId) || !known(message.fromAgent?.participantId)) {
      return "A message names an agent that didn't come.";
    }
  }
  for (const entry of command.outsideWork ?? []) {
    if (!known(entry.participantId)) return "An outside mark names an agent that didn't come.";
  }
  return null;
}

/**
 * Why a moved family member can't be written as it is, or null (docs/design/
 * fleet.md, Part 3f, (g)). A child lands under its parent only when that
 * parent is here, came in the same family (the key this computer derived from
 * the link both came over), is in the same project, isn't a child itself, and
 * isn't moving on again: a linked computer can never put a thread under one
 * of this computer's own. A guest marker names a member of the same family.
 */
function importedFamilyRefusal(
  readModel: OrchestrationReadModel,
  command: CommandOf<"thread.import">,
): string | null {
  const familyKey = command.movedFrom.familyKey;
  const lineage = command.lineage;
  if (lineage !== undefined) {
    const parent = readModel.threads.find((entry) => entry.id === lineage.parentThreadId);
    if (familyKey === undefined) return "A thread can only land under a parent that moved with it.";
    if (parent === undefined || parent.deletedAt !== null) {
      return "The thread that started it isn't here.";
    }
    if ((parent.movedFrom ?? null)?.familyKey !== familyKey) {
      return "The thread that started it didn't move with it.";
    }
    if (parent.projectId !== command.projectId) {
      return "The thread that started it is in another project.";
    }
    if (parent.parentThreadId !== null && parent.attachedToParent) {
      return "The thread that started it is itself another thread's.";
    }
    if ((parent.move ?? null) !== null || (parent.pendingMove ?? null) !== null) {
      return "The thread that started it is moving again.";
    }
  }
  const origin = command.worktreeOrigin;
  if (origin !== undefined) {
    if (familyKey === undefined || origin.kind !== "thread") {
      return "Only a thread that moved with its family can work in another's folder.";
    }
    const owner = readModel.threads.find((entry) => entry.id === origin.threadId);
    if (owner !== undefined && (owner.movedFrom ?? null)?.familyKey !== familyKey) {
      return "The folder it works in isn't its family's.";
    }
  }
  return null;
}

/**
 * What a moved thread had going, written with it (docs/design/fleet.md, Part
 * 3e): its goal as it arrives, its pull requests, its plans, and its queue
 * (the arrival message first). The pull requests' switches stay off whatever
 * the command says: only the user here turns one on (the offer is
 * `movedFrom.pullRequestSwitches`). The queue's events are marked `imported`:
 * nothing sends on them; the move's own kick sends its head.
 */
function importedState(
  command: CommandOf<"thread.import">,
  base: () => Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
): PlannedEvent[] {
  const threadId = command.threadId;
  const at = command.createdAt;
  const events: PlannedEvent[] = [];
  if (command.goal !== undefined) {
    events.push({
      ...base(),
      type: "thread.goal-state-set",
      payload: { threadId, goal: { ...command.goal, threadId }, updatedAt: at },
    });
  }
  const pullRequests = command.pullRequests;
  if (pullRequests !== undefined) {
    for (const linked of pullRequests.linked) {
      events.push({
        ...base(),
        type: "thread.pull-request-linked",
        payload: { threadId, number: linked.number, url: linked.url, linkedAt: at },
      });
    }
  }
  for (const proposedPlan of command.proposedPlans ?? []) {
    events.push({
      ...base(),
      type: "thread.proposed-plan-upserted",
      payload: { threadId, proposedPlan },
    });
  }
  const message = command.arrival?.message;
  const queue: OrchestrationQueuedFollowUp[] = [
    ...(message !== undefined
      ? [
          {
            messageId: message.messageId,
            text: message.text,
            attachments: [],
            afterMove: true as const,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            createdAt: at,
          },
        ]
      : []),
    // Sent there by the user, but here by the move: no turn of theirs lifts
    // the fence. The other computer said where it was sent from, and only
    // this server stamps that (MessageSentFrom), so it is dropped.
    ...(command.queuedFollowUps ?? []).map(
      ({ sentFrom: _peerSaid, ...entry }): OrchestrationQueuedFollowUp => ({
        ...entry,
        imported: true as const,
      }),
    ),
  ];
  for (const followUp of queue) {
    events.push({
      ...base(),
      type: "thread.follow-up-queued",
      payload: { threadId, followUp, imported: true },
    });
  }
  return events;
}

/**
 * Puts back what a move that didn't happen took (docs/design/fleet.md, Part
 * 3e, "Put back"), from what was recorded when it stopped the agent, not
 * from how the goal reads now: a goal that was working is on again (one that
 * finished since stays finished, one the user paused stays paused), the
 * agent is told what it had going (queued ahead of the user's messages, and
 * sent like them), and the queued messages that waited are sent. One
 * decision, which clears what was owed, so it is paid once.
 */
export function decideMoveRestore(
  thread: OrchestrationThread,
  command: CommandOf<"thread.move.restore">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const owed = thread.moveRestoreOwed ?? null;
  // Paid already, or a newer record since: no news.
  if (owed === null || owed.at !== command.at) return [];
  const at = command.createdAt;
  // The last of it: its message went, the queue is through, the provider
  // holds the goal again.
  if (command.finished === true) {
    return isRestorePaid(owed) ? [restoreSet(thread, null, at, baseFor)] : [];
  }
  if (isRestorePaid(owed)) return [];
  const events: PlannedEvent[] = [];
  // Paused by the move's stop (Codex): on again. Claude can't pause one, so
  // it still reads active; the agent's message brings it back to work, and
  // the provider is given it once that is done (`goalOwed`).
  const goal = thread.goal;
  const goalBack =
    owed.interrupted?.goalActive === true &&
    goal !== null &&
    (goal.status === "active" || goal.status === "paused");
  if (goalBack && goal !== null && goal.status === "paused") {
    events.push({
      ...baseFor(thread.id),
      type: "thread.goal-state-set",
      payload: {
        threadId: thread.id,
        goal: { ...goal, status: "active", updatedAt: at },
        updatedAt: at,
      },
    });
  }
  if (command.message !== undefined) {
    events.push({
      ...baseFor(thread.id),
      type: "thread.follow-up-queued",
      payload: {
        threadId: thread.id,
        followUp: {
          messageId: command.message.messageId,
          text: command.message.text,
          attachments: [],
          afterMove: true,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: at,
        },
      },
    });
  }
  // Paid; what is still to come stays on record until it is done, so a
  // restart before the message went (or before the goal was given) finishes it.
  const told = command.message?.messageId;
  events.push(
    restoreSet(
      thread,
      told !== undefined || goalBack
        ? {
            target: owed.target,
            ...(told !== undefined ? { told } : {}),
            ...(goalBack ? { goalOwed: true as const } : {}),
            at: owed.at,
          }
        : null,
      at,
      baseFor,
    ),
  );
  return events;
}

/**
 * Whether a move's record of what it owes back is already paid, and only
 * its last steps are left (ThreadMoveRestore.told, goalOwed).
 */
export const isRestorePaid = (owed: ThreadMoveRestore) =>
  owed.interrupted === undefined && owed.queued !== true;

/**
 * Resume, on a moved thread whose agent hasn't been given the conversation
 * yet (docs/design/fleet.md, Part 3e, (a)): no provider call, which would
 * set the goal on an agent that doesn't know the thread. The goal reads
 * active, and a message for the agent is queued; once it is sent, the
 * reactor gives the provider the goal (what is left of its budget). Null:
 * not that case, decided as any other goal change.
 */
export function decideMovedGoalResume(
  thread: OrchestrationThread,
  command: CommandOf<"thread.goal.set">,
  baseFor: EventBase,
): ThreadMoveDecision | null {
  const current = thread.goal;
  // A resume, an edit or a new goal: anything that would set the goal working.
  const working = command.status === undefined || command.status === "active";
  const objective = command.objective ?? current?.objective;
  if (
    !working ||
    objective === undefined ||
    (thread.movedFrom ?? null) === null ||
    thread.historySeedOwed !== true ||
    (command.objective === undefined && current?.status === "active")
  ) {
    return null;
  }
  const at = command.createdAt;
  const goal = {
    threadId: thread.id,
    objective,
    status: "active" as const,
    tokenBudget:
      command.tokenBudget !== undefined
        ? command.tokenBudget
        : command.objective !== undefined
          ? null
          : (current?.tokenBudget ?? null),
    tokensUsed: command.objective !== undefined ? 0 : (current?.tokensUsed ?? 0),
    timeUsedSeconds: command.objective !== undefined ? 0 : (current?.timeUsedSeconds ?? 0),
    createdAt: command.objective !== undefined ? at : (current?.createdAt ?? at),
    updatedAt: at,
  };
  return [
    {
      ...baseFor(thread.id),
      type: "thread.goal-state-set",
      payload: { threadId: thread.id, goal, updatedAt: at },
    },
    {
      ...baseFor(thread.id),
      type: "thread.follow-up-queued",
      payload: {
        threadId: thread.id,
        followUp: {
          messageId: MessageId.make(derivedUuid("move-goal-resume", command.commandId)),
          text: resumedGoalMessageText(objective),
          attachments: [],
          afterMove: true,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: at,
        },
      },
    },
  ];
}

/**
 * The message a move that didn't happen leaves for the thread's agent, or
 * null: what its stop took, from the record of it.
 */
export function restoreMessageText(
  thread: Pick<OrchestrationThread, "goal">,
  owed: ThreadMoveRestore,
  now: string,
  canSetCheckBacks: boolean,
): string | null {
  const goal = thread.goal;
  const goalWorking =
    owed.interrupted?.goalActive === true &&
    goal !== null &&
    (goal.status === "active" || goal.status === "paused");
  return arrivalMessageText({
    kind: "stayed",
    from: "",
    to: owed.target.label,
    goal: goalWorking && goal !== null ? { objective: goal.objective } : null,
    // Saved ones too: the agent's next session restores them, and the
    // message has it look (CronList) before it sets any again.
    checkBacks: owed.interrupted?.checkBacks ?? [],
    canSetCheckBacks,
    now,
  });
}

export function decideHistorySeedDelivered(
  thread: OrchestrationThread,
  command: CommandOf<"thread.history-seed.delivered">,
  baseFor: EventBase,
): ThreadMoveDecision {
  // Recorded for any thread that moved here, owed or not as this read model
  // has it: the projections agree on where the conversation went.
  if ((thread.movedFrom ?? null) === null) return [];
  // A room agent's carried session (Part 3f, (i)): only its own proves itself.
  if (command.participantId !== undefined) {
    const participant = thread.participants.find((entry) => entry.id === command.participantId);
    if (command.nativeSession !== "resumed" || participant?.nativeSession !== "carried") {
      return refuse("That agent's session is no longer the one it carried.");
    }
    return [
      {
        ...baseFor(thread.id),
        type: "thread.history-seed-delivered",
        payload: {
          threadId: thread.id,
          messageId: command.messageId,
          nativeSession: "resumed",
          participantId: command.participantId,
          updatedAt: command.createdAt,
        },
      },
    ];
  }
  // A carried session's success counts only while it is still the one in
  // use: one that fell back meanwhile still owes its summary.
  if (command.nativeSession === "resumed" && thread.nativeSession !== "carried") {
    return refuse("This thread's agent session is no longer the one it carried.");
  }
  return [
    {
      ...baseFor(thread.id),
      type: "thread.history-seed-delivered",
      payload: {
        threadId: thread.id,
        messageId: command.messageId,
        ...(command.nativeSession !== undefined ? { nativeSession: command.nativeSession } : {}),
        updatedAt: command.createdAt,
      },
    },
  ];
}

/**
 * A moved thread's carried session can't be used here (docs/design/fleet.md,
 * Part 3d): recorded as fallen back, with the line that says so, and the
 * conversation stays owed for the next send's summary. Only while it is
 * `carried`, so a thread falls back once and its message is sent again once.
 */
export function decideNativeSessionFallBack(
  thread: OrchestrationThread,
  command: CommandOf<"thread.native-session.fall-back">,
  baseFor: EventBase,
): ThreadMoveDecision {
  const participantId = command.participantId;
  const participant =
    participantId === undefined
      ? undefined
      : thread.participants.find((entry) => entry.id === participantId);
  const carried =
    participantId === undefined
      ? thread.nativeSession === "carried"
      : participant?.nativeSession === "carried";
  if (!carried) {
    return refuse("This thread has no carried agent session to fall back from.");
  }
  const payload: ThreadNativeSessionFellBackPayload = {
    reason: command.reason,
    ...(command.resendMessageId !== undefined ? { resendMessageId: command.resendMessageId } : {}),
    ...(participantId !== undefined ? { participantId } : {}),
  };
  // The thread's own agent's, or (a room) one agent's own record.
  const fellBack: PlannedEvent =
    participantId === undefined
      ? {
          ...baseFor(thread.id),
          type: "thread.meta-updated",
          payload: {
            threadId: thread.id,
            nativeSession: "fell_back",
            updatedAt: command.createdAt,
          },
        }
      : {
          ...baseFor(thread.id),
          type: "thread.participant-updated",
          payload: {
            threadId: thread.id,
            participantId,
            nativeSession: "fell_back",
            updatedAt: command.createdAt,
          },
        };
  return [
    fellBack,
    {
      ...baseFor(thread.id),
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity: {
          id: EventId.make(
            participantId === undefined
              ? `native-session-fell-back:${thread.id}`
              : `native-session-fell-back:${thread.id}:${participantId}`,
          ),
          tone: "info",
          kind: ThreadNativeSessionFellBackActivityKind,
          summary: NATIVE_SESSION_FELL_BACK_WORDS,
          payload,
          turnId: null,
          createdAt: command.createdAt,
        },
      },
    },
  ];
}

/** The timeline's words for a carried session that fell back. */
export const NATIVE_SESSION_FELL_BACK_WORDS =
  "Couldn't resume the agent's session here, so it got a summary instead.";
