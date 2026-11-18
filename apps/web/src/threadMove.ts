/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3), as the
 * app words and decides it: when the move is offered, what a move takes with
 * it, how far one got, and whether one can still finish. Pure: the dialog,
 * the composer notice, the sidebar and the request rows read the same rules.
 *
 * @module threadMove
 */
import {
  GENERAL_CHATS_PROJECT_ID,
  type ModelSelection,
  type ThreadMoveBatchId,
  type ThreadMoveBatchMember,
  type ThreadMoveBatchMemberState,
  type ThreadMovePreviewManyThread,
  type OrchestrationThreadMove,
  type OutboundComputerLink,
  type ThreadMoveChanges,
  type ThreadMoveNote,
  type ThreadMovePreview,
  type ThreadMoveRoomAgentChoice,
  type ThreadParticipantId,
  THREAD_MOVE_BATCH_MAX,
  ThreadMoveNotStartedActivityKind,
  type ThreadMoveOutcome,
  type ThreadMoveSessionOutcome,
  type ThreadMoveTargetPreview,
  type ThreadMoveWait,
  type ThreadMoveWaitCode,
  type ThreadPendingMove,
} from "@threadlines/contracts";

import { formatDownloadProgress } from "./lib/formatBytes";
import type { ThreadMoveStatus } from "./types";

/**
 * The boundary on a thread that moved here: one activity after the imported
 * history, payload `{ fromEnvironmentId, fromLabel, fromThreadId, movedAt }`.
 */
export const THREAD_MOVED_IN_ACTIVITY_KIND = "thread.moved-in";
/**
 * A move that was dropped, on the thread that stayed: "Couldn't move to …",
 * payload `{ targetLabel, reason }`.
 */
export const THREAD_MOVE_FAILED_ACTIVITY_KIND = "thread.move-failed";
/**
 * A queued move that ended without starting (Part 3b): "Didn't move to …",
 * payload a ThreadMoveNotStartedPayload (`{ requestId, targetLabel, reason, words }`).
 */
export const THREAD_MOVE_NOT_STARTED_ACTIVITY_KIND = ThreadMoveNotStartedActivityKind;

/**
 * Whether the other computer has every byte of this move and only its user's
 * Allow is left (Part 3c): the thread's last outcome says so for this very
 * transfer. For quitting, such a move counts as done.
 */
export function isThreadMoveSent(thread: {
  readonly move?: OrchestrationThreadMove | null | undefined;
  readonly lastMoveOutcome?: ThreadMoveOutcome | null | undefined;
}): boolean {
  const move = thread.move ?? null;
  const outcome = thread.lastMoveOutcome ?? null;
  return (
    move !== null &&
    move.movedAway === undefined &&
    move.phase === "awaiting_approval" &&
    outcome !== null &&
    outcome.result === "awaiting_approval" &&
    outcome.transferId === move.transferId
  );
}

/**
 * "queued" while a move waits for the thread to be free (Part 3b), "moving"
 * until the other computer took it ("waiting" while that computer finishes
 * other moves, "sent" once it has every byte and waits for its user, Part
 * 3c), "moved" after; undefined for none.
 */
export function threadMoveStatus(thread: {
  readonly move?: OrchestrationThreadMove | null | undefined;
  readonly pendingMove?: ThreadPendingMove | null | undefined;
  readonly lastMoveOutcome?: ThreadMoveOutcome | null | undefined;
}): ThreadMoveStatus | undefined {
  const move = thread.move ?? null;
  if (move !== null) {
    if (move.movedAway) return "moved";
    if (move.waitingForTarget === true) return "waiting";
    return isThreadMoveSent(thread) ? "sent" : "moving";
  }
  return thread.pendingMove ? "queued" : undefined;
}

const MOVE_STATUS_WORDS: Record<ThreadMoveStatus, string> = {
  queued: "move queued",
  waiting: "move waiting",
  moving: "moving",
  sent: "move sent",
  moved: "moved",
};

/** A move status as a sidebar row says it: "move queued", "moving", "move sent", "moved". */
export function threadMoveStatusWord(status: ThreadMoveStatus): string {
  return MOVE_STATUS_WORDS[status];
}

/** A thread in General Chats: every computer files them under the same project. */
export function isGeneralChatsThread(thread: { readonly projectId: string }): boolean {
  return thread.projectId === GENERAL_CHATS_PROJECT_ID;
}

/**
 * Whether to offer "Move to another computer" for a thread: its computer
 * moves threads, links to at least one computer right now, and the thread
 * isn't moving or moved already. A General Chats thread also needs a
 * computer that moves those (`threadMoveState`, Part 3e). Everything else (a
 * room, live work, a computer that can't take it) the dialog shows with its
 * reason.
 */
export function isThreadMoveOffered(input: {
  readonly supportsThreadMove: boolean;
  /** The thread's computer moves threads with what they had going, General Chats ones included. */
  readonly movesThreadState: boolean;
  readonly generalChat: boolean;
  /** The thread's computer's own links, as last heard; null when not heard. */
  readonly outbound: ReadonlyArray<OutboundComputerLink> | null;
  readonly moveStatus: ThreadMoveStatus | undefined;
}): boolean {
  return (
    input.supportsThreadMove &&
    (!input.generalChat || input.movesThreadState) &&
    input.moveStatus === undefined &&
    (input.outbound ?? []).some((link) => link.state === "active")
  );
}

/**
 * Whether to offer "Move threads…" from a computer (Part 3c): it moves
 * several threads at once (`threadMoveBatch`) and links to a computer right
 * now, to `targetEnvironmentId` when one is named (that computer's page).
 */
export function isMoveThreadsOffered(input: {
  readonly supportsBatch: boolean;
  readonly outbound: ReadonlyArray<OutboundComputerLink> | null;
  readonly targetEnvironmentId: string | null;
}): boolean {
  return (
    input.supportsBatch &&
    (input.outbound ?? []).some(
      (link) =>
        link.state === "active" &&
        (input.targetEnvironmentId === null ||
          link.remoteEnvironmentId === input.targetEnvironmentId),
    )
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What a move takes with it, in one line: "12 messages · branch fix/x · 3
 * changed files · 1 new file · 2 commits not pushed". Counts of zero are left
 * out; the messages and the branch always show. The dialog's preview and a
 * move request (ComputerLinkPendingRequest.move) read alike.
 */
export function formatThreadMoveChanges(
  changes: Pick<
    ThreadMoveChanges,
    "messageCount" | "branch" | "trackedFiles" | "untrackedFiles" | "unpushedCommits"
  >,
): string {
  return [
    plural(changes.messageCount, "message", "messages"),
    changes.branch === null ? "not on a branch" : `branch ${changes.branch}`,
    changes.trackedFiles > 0 ? plural(changes.trackedFiles, "changed file", "changed files") : null,
    changes.untrackedFiles > 0 ? plural(changes.untrackedFiles, "new file", "new files") : null,
    changes.unpushedCommits > 0
      ? plural(changes.unpushedCommits, "commit not pushed", "commits not pushed")
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Where the dialog says the thread lands: "Lands in threadlines on Mac mini",
 * or "Lands on Mac mini" when the project's name isn't known. A General Chats
 * thread (`folder`) says how many files its folder takes along: "Lands in
 * General chats on Windows PC · 14 files".
 */
export function describeThreadMoveLanding(
  target: { readonly label: string; readonly projectName?: string | undefined },
  folder: ThreadMovePreview["folder"],
): string {
  const lands = target.projectName
    ? `Lands in ${target.projectName} on ${target.label}`
    : `Lands on ${target.label}`;
  return folder === undefined ? lands : `${lands} · ${plural(folder.files, "file", "files")}`;
}

/**
 * The words of the notes that hold for the agent picked (`instanceId`): those
 * for any agent, and those naming it. None picked yet (null): only those for
 * any agent.
 */
export function threadMoveNotesFor(
  notes: ReadonlyArray<ThreadMoveNote> | undefined,
  instanceId: string | null,
): string[] {
  return (notes ?? []).flatMap((note) =>
    note.instanceIds === undefined || (instanceId !== null && note.instanceIds.includes(instanceId))
      ? [note.words]
      : [],
  );
}

/**
 * How much of a move asking for Allow is here already (Part 3c): "Everything
 * is here", or "12.0 of 40.0 MB here". Null when the asking computer sends
 * only after Allow (an older one) and so says nothing.
 */
export function formatThreadMoveArrival(move: {
  readonly bytesReceived?: number | undefined;
  readonly totalBytes?: number | undefined;
}): string | null {
  const { bytesReceived, totalBytes } = move;
  if (bytesReceived === undefined || totalBytes === undefined) return null;
  if (bytesReceived >= totalBytes) return "Everything is here";
  return `${formatDownloadProgress(bytesReceived, totalBytes)} here`;
}

/** "Full access" as it reads after "with up to": "Full access", "Auto access". */
export function formatThreadMoveAccess(accessLabel: string): string {
  return /\baccess$/iu.test(accessLabel) ? accessLabel : `${accessLabel} access`;
}

/** How much of a move's data the other computer has, 0 to 100; null before it's known. */
export function threadMoveSentPercent(move: OrchestrationThreadMove): number | null {
  const total = move.totalBytes;
  if (total === undefined || total <= 0) return null;
  // Floored, so 100% only shows once every byte is there.
  return Math.min(100, Math.max(0, Math.floor(((move.sentBytes ?? 0) / total) * 100)));
}

/**
 * Where an unfinished move is, in a few words: the composer notice's lead.
 * `sent`: the other computer has every byte (isThreadMoveSent).
 */
export function describeThreadMoveProgress(
  move: OrchestrationThreadMove,
  options?: {
    readonly sent?: boolean;
    /**
     * A child moving with its parent (docs/design/fleet.md, Part 3f, (g)):
     * the parent's title while it hasn't moved yet. The child lands after it.
     */
    readonly withParent?: string | null;
  },
): string {
  const label = move.target.label;
  if (move.cancelRequested) return "Stopping the move…";
  if (options?.withParent != null) return `Moves to ${label} with ${options.withParent}.`;
  if (move.waitingForTarget === true) return `Waiting for ${label} to finish other moves`;
  switch (move.phase) {
    case "exporting":
      return `Getting ready to move to ${label}…`;
    case "awaiting_approval":
      return options?.sent === true
        ? `Sent. Waiting for ${label} to allow it`
        : `Waiting for ${label} to allow the move`;
    case "sending": {
      const percent = threadMoveSentPercent(move);
      return percent === null ? `Sending to ${label}…` : `Sending to ${label} · ${percent}%`;
    }
    case "importing":
      return `Setting up on ${label}…`;
  }
}

/** Why a moving or moved thread takes no message here: the locked composer's placeholder. */
export function threadMoveLockReason(move: OrchestrationThreadMove): string {
  return move.movedAway
    ? `This thread moved to ${move.target.label}`
    : `This thread is moving to ${move.target.label}`;
}

/**
 * An unfinished move that can't go on: this computer's link to the other one
 * is gone, isn't active, or can't reach it. The move then can neither finish
 * nor stop until they reconnect, since only the other computer can confirm
 * either. `outbound` null (links not heard) says nothing.
 */
export function isThreadMoveStalled(input: {
  readonly move: OrchestrationThreadMove | null | undefined;
  readonly outbound: ReadonlyArray<OutboundComputerLink> | null;
}): boolean {
  const { move, outbound } = input;
  if (!move || move.movedAway || outbound === null) return false;
  const link = outbound.find(
    (candidate) => candidate.remoteEnvironmentId === move.target.environmentId,
  );
  return link === undefined || link.state !== "active" || link.connection === "offline";
}

/**
 * A computer a move can be asked of: one that can take the thread, or one
 * that can't be reached right now, which a queued move waits for.
 */
export function isThreadMoveTargetPickable(target: ThreadMoveTargetPreview): boolean {
  return target.refusal === undefined || target.unreachable === true;
}

/**
 * The computer to offer first: the first that can take the thread, else the
 * first a queued move can wait for, else the first.
 */
export function pickDefaultMoveTarget(
  targets: ReadonlyArray<ThreadMoveTargetPreview>,
): ThreadMoveTargetPreview | null {
  return (
    targets.find((target) => target.refusal === undefined) ??
    targets.find(isThreadMoveTargetPickable) ??
    targets[0] ??
    null
  );
}

/** One of a target's agents and models, as the agent picker holds it. */
export interface ThreadMoveAgentChoice {
  readonly instanceId: string;
  readonly model: string;
}

const AGENT_KEY_SEPARATOR = "\u0000";

export const threadMoveAgentKey = (choice: ThreadMoveAgentChoice) =>
  `${choice.instanceId}${AGENT_KEY_SEPARATOR}${choice.model}`;

/** `suggested` as a pick, when the target has that agent and model; else null. */
function offeredChoice(
  agents: ThreadMoveTargetPreview["agents"],
  suggested: ModelSelection | undefined,
): ThreadMoveAgentChoice | null {
  if (
    suggested &&
    agents.some(
      (agent) =>
        agent.instanceId === suggested.instanceId &&
        agent.models.some((model) => model.model === suggested.model),
    )
  ) {
    return { instanceId: suggested.instanceId, model: suggested.model };
  }
  return null;
}

/** The agent to preselect: the target's suggestion when it has it, else its first model. */
export function pickDefaultMoveAgent(
  target: Pick<ThreadMoveTargetPreview, "agents" | "suggestedAgent">,
): ThreadMoveAgentChoice | null {
  const suggested = offeredChoice(target.agents, target.suggestedAgent);
  if (suggested) return suggested;
  for (const agent of target.agents) {
    const model = agent.models[0];
    if (model) return { instanceId: agent.instanceId, model: model.model };
  }
  return null;
}

/**
 * The agent a move asks for: the target's suggestion as it came (its options
 * included) when that is the one picked, else the picked agent and model.
 */
export function threadMoveAgentSelection(
  target: Pick<ThreadMoveTargetPreview, "suggestedAgent">,
  choice: ThreadMoveAgentChoice,
): ModelSelection {
  const suggested = target.suggestedAgent;
  if (suggested && suggested.instanceId === choice.instanceId && suggested.model === choice.model) {
    return suggested;
  }
  return { instanceId: choice.instanceId as ModelSelection["instanceId"], model: choice.model };
}

/**
 * The user's picks for a room's agents on one computer, by participant: an
 * agent there, or null to leave it out. An agent without one keeps its preset.
 */
export type ThreadMoveRoomPicks = ReadonlyMap<ThreadParticipantId, ThreadMoveAgentChoice | null>;

/** One of a room's agents (ThreadMovePreview.room) in the move dialog, on the computer picked. */
export interface ThreadMoveRoomAgentRow {
  readonly participantId: ThreadParticipantId;
  /** Its name here. */
  readonly name: string;
  /** The agent picked there, or null: it's left out. */
  readonly pick: ThreadMoveAgentChoice | null;
  /** Why no agent there matches, in the server's words; only while it's left out. */
  readonly cantCome: string | null;
  /** What the agent picked gets of its session; null while it's left out. */
  readonly session: ThreadMoveSessionOutcome | null;
  /** What the move asks for it (the suggestion as it came, when that is the pick). */
  readonly choice: ThreadMoveRoomAgentChoice;
}

/**
 * A room's agents besides the thread's own, on `target` (docs/design/fleet.md,
 * Part 3f, (i)): each preset to the agent `target` suggests for it, else left
 * out, unless the user picked otherwise (`picks`).
 */
export function threadMoveRoomAgentRows(
  room: NonNullable<ThreadMovePreview["room"]>,
  target: Pick<ThreadMoveTargetPreview, "agents" | "roomAgents">,
  picks: ThreadMoveRoomPicks,
): ThreadMoveRoomAgentRow[] {
  return room.agents.map(({ participantId, name }) => {
    const there = target.roomAgents?.find((entry) => entry.participantId === participantId);
    const pick = picks.has(participantId)
      ? (picks.get(participantId) ?? null)
      : offeredChoice(target.agents, there?.suggestedAgent);
    return {
      participantId,
      name,
      pick,
      cantCome: pick === null ? (there?.cantCome ?? null) : null,
      session: pick === null ? null : threadMoveSessionOutcome(there ?? {}, pick.instanceId),
      choice: {
        participantId,
        agent: pick === null ? null : threadMoveAgentSelection(there ?? {}, pick),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// A move that waits for the thread to be free (docs/design/fleet.md, Part 3b)
// ---------------------------------------------------------------------------

/**
 * What the thread is doing, in the user's words, by kind: each says it on
 * its own (`first`), and after a sentence about the agent (`after`), where
 * "it" is the agent. Listed in the order they're told.
 */
const WAIT_SENTENCES = {
  reply: { first: "The agent is still working on its reply.", after: null },
  answer: {
    first: "The agent is waiting for your answer.",
    after: "It's also waiting for your answer.",
  },
  started: {
    first: "Something the agent started is still running.",
    after: "Something it started is still running too.",
  },
  voice: { first: "A voice chat is still on.", after: "A voice chat is still on too." },
  folder: {
    first: "Another thread is working in the same folder.",
    after: "Another thread is working in the same folder too.",
  },
} as const;

type WaitKind = keyof typeof WAIT_SENTENCES;

const WAIT_KIND: Record<ThreadMoveWaitCode, WaitKind> = {
  turn: "reply",
  side_turn: "reply",
  approval: "answer",
  question: "answer",
  background: "started",
  command_run: "started",
  workflow_run: "started",
  voice: "voice",
  shared_checkout: "folder",
};

const AGENT_KINDS: ReadonlySet<WaitKind> = new Set(["reply", "answer", "started"]);

/**
 * What the thread is doing that a move waits for, in at most two short
 * sentences: "The agent is still working on its reply. Something it
 * started is still running too."
 */
export function describeThreadMoveWaits(waits: ReadonlyArray<ThreadMoveWait>): string {
  const present = new Set(waits.map((wait) => WAIT_KIND[wait.code]));
  const kinds = (Object.keys(WAIT_SENTENCES) as WaitKind[]).filter((kind) => present.has(kind));
  const [first, second] = kinds;
  if (first === undefined) return "";
  const lead = WAIT_SENTENCES[first].first;
  if (second === undefined) return lead;
  const follow = AGENT_KINDS.has(first)
    ? (WAIT_SENTENCES[second].after ?? WAIT_SENTENCES[second].first)
    : WAIT_SENTENCES[second].first;
  return `${lead} ${follow}`;
}

/**
 * Why "Stop the agent and move now" isn't offered, or null when it is: a
 * command from the thread runs in the user's own terminal, which nothing
 * here stops. The server refuses that move with these same words
 * (threadMoveDecisions.ts, decideMoveQueue).
 */
export function threadMoveStopNowRefusal(
  waits: ReadonlyArray<ThreadMoveWait>,
  options?: { readonly many?: boolean },
): string | null {
  if (!waits.some((wait) => wait.code === "command_run")) return null;
  return options?.many === true
    ? "A command from one of these threads is running in your terminal. Stop it there, or move them when each agent finishes."
    : "A command from this thread is running in your terminal. Stop it there, or move the thread when it's done.";
}

/** Why a thread whose move waits takes no new message: the send button's words. */
export function pendingMoveSendBlockReason(pendingMove: ThreadPendingMove): string {
  return `This thread is waiting to move to ${pendingMove.target.label}. Cancel the move to keep working here.`;
}

/** The composer notice's words for a move that waits. */
export interface PendingMoveNoticeWords {
  readonly lead: string;
  readonly severity: "info" | "warning";
  /** Held (the target is offline, or a stop wasn't confirmed): Try again asks the server to look now. */
  readonly retry: boolean;
}

/**
 * What a waiting move's notice says: what holds it, when something does;
 * else when it goes ("Moves to Mac mini when this turn ends."), in the
 * agent's name when the agent asked for it.
 */
export function describePendingMove(pendingMove: ThreadPendingMove): PendingMoveNoticeWords {
  const label = pendingMove.target.label;
  const hold = pendingMove.hold ?? null;
  if (hold !== null) {
    return {
      lead: hold.words,
      severity: hold.kind === "stop_unconfirmed" ? "warning" : "info",
      retry: true,
    };
  }
  if (pendingMove.stage === "quiescing") {
    return { lead: `Stopping the agent to move to ${label}…`, severity: "info", retry: false };
  }
  const words = pendingMove.waitsFor?.[0]?.words ?? null;
  if (pendingMove.requestedBy.kind === "agent") {
    return {
      lead: `Your agent asked to move this thread to ${label} ${words ?? "when this turn ends"}.`,
      severity: "info",
      retry: false,
    };
  }
  return {
    lead: words === null ? `Getting ready to move to ${label}…` : `Moves to ${label} ${words}.`,
    severity: "info",
    retry: false,
  };
}

// ---------------------------------------------------------------------------
// Several threads at once (docs/design/fleet.md, Part 3c)
// ---------------------------------------------------------------------------

/**
 * Where one thread of batch `batchId` stands, read from its own projection
 * (its waiting move, its move, its last outcome), in `moves.batchStatus`'s
 * words; null when the thread isn't (or is no longer) part of that batch.
 */
export function threadMoveBatchState(
  thread: {
    readonly move?: OrchestrationThreadMove | null | undefined;
    readonly pendingMove?: ThreadPendingMove | null | undefined;
    readonly lastMoveOutcome?: ThreadMoveOutcome | null | undefined;
  },
  batchId: ThreadMoveBatchId,
): ThreadMoveBatchMemberState | null {
  const pending = thread.pendingMove ?? null;
  if (pending !== null) {
    if (pending.batchId !== batchId) return null;
    return pending.stage === "quiescing" ? "stopping" : "waiting";
  }
  const move = thread.move ?? null;
  if (move !== null && move.batchId === batchId) {
    if (move.movedAway) return "moved";
    return isThreadMoveSent(thread) ? "awaiting_approval" : "moving";
  }
  const outcome = thread.lastMoveOutcome ?? null;
  return outcome !== null && outcome.batchId === batchId ? outcome.result : null;
}

/** Whether a batch member has its final answer (`moves.batchStatus`'s `final`). */
export function isMoveBatchStateFinal(state: ThreadMoveBatchMemberState): boolean {
  return state === "moved" || state === "not_moved" || state === "awaiting_approval";
}

/** How many of a batch's threads stand where. */
export interface MoveBatchCounts {
  readonly total: number;
  readonly moved: number;
  /** Sent, and waiting for the other computer's user to allow it. */
  readonly sent: number;
  readonly moving: number;
  readonly stopping: number;
  readonly waiting: number;
  readonly notMoved: number;
}

export function countMoveBatch(states: ReadonlyArray<ThreadMoveBatchMemberState>): MoveBatchCounts {
  const count = (state: ThreadMoveBatchMemberState) =>
    states.filter((candidate) => candidate === state).length;
  return {
    total: states.length,
    moved: count("moved"),
    sent: count("awaiting_approval"),
    moving: count("moving"),
    stopping: count("stopping"),
    waiting: count("waiting"),
    notMoved: count("not_moved"),
  };
}

/** Every thread of the batch has its final answer. */
export function isMoveBatchDone(counts: MoveBatchCounts): boolean {
  return counts.total > 0 && counts.moved + counts.sent + counts.notMoved === counts.total;
}

/**
 * Where a batch's threads stand, in one run of short parts: "1 moved, 2
 * waiting for their agents". Parts of zero are left out.
 */
export function describeMoveBatchCounts(counts: MoveBatchCounts): string {
  return [
    counts.moved > 0 ? `${counts.moved} moved` : null,
    counts.sent > 0 ? `${counts.sent} sent, waiting for Allow` : null,
    counts.moving > 0 ? `${counts.moving} on the way` : null,
    counts.stopping > 0
      ? `${counts.stopping} stopping ${counts.stopping === 1 ? "its agent" : "their agents"}`
      : null,
    counts.waiting > 0
      ? `${counts.waiting} waiting for ${counts.waiting === 1 ? "its agent" : "their agents"}`
      : null,
    counts.notMoved > 0 ? `${counts.notMoved} didn't move` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

/** One thread of a batch that didn't move, and why. */
export interface MoveBatchMiss {
  /** Where it's known: tells two threads with one title apart. */
  readonly threadId?: string;
  readonly title: string;
  readonly words: string;
}

const withoutFinalStop = (words: string) => words.replace(/[.\s]+$/u, "");

/**
 * A batch as its target's Fleet row and page say it: "Moving 3 threads
 * here: 1 moved, 2 waiting for their agents" while it runs; once every
 * thread has its answer, "Moved 3 threads to Windows PC.", or how many of
 * them, then the ones that didn't and why.
 */
export function describeMoveBatchProgress(input: {
  readonly counts: MoveBatchCounts;
  readonly targetLabel: string;
  readonly misses: ReadonlyArray<MoveBatchMiss>;
}): string {
  const { counts, targetLabel, misses } = input;
  const threads = plural(counts.total, "thread", "threads");
  if (!isMoveBatchDone(counts)) {
    return `Moving ${threads} here: ${describeMoveBatchCounts(counts)}`;
  }
  const arrived = counts.moved + counts.sent;
  const lead =
    arrived === counts.total
      ? `Moved ${threads} to ${targetLabel}.`
      : arrived === 0
        ? `Didn't move ${counts.total === 1 ? "the thread" : `the ${threads}`} to ${targetLabel}.`
        : `Moved ${arrived} of ${threads} to ${targetLabel}.`;
  const sent =
    counts.sent === 0
      ? ""
      : counts.sent === 1
        ? ` 1 waits for ${targetLabel} to allow it.`
        : ` ${counts.sent} wait for ${targetLabel} to allow them.`;
  const missed =
    misses.length === 0
      ? ""
      : ` Didn't move: ${misses
          .map((miss) => `${miss.title} (${withoutFinalStop(miss.words)})`)
          .join(", ")}.`;
  return `${lead}${sent}${missed}`;
}

/** The members of a `moves.batchStatus` answer that didn't move, with why. */
export function moveBatchMisses(members: ReadonlyArray<ThreadMoveBatchMember>): MoveBatchMiss[] {
  return members.flatMap((member) =>
    member.state === "not_moved"
      ? [
          {
            threadId: member.threadId,
            title: member.title ?? "A thread",
            words: member.words ?? "It couldn't move.",
          },
        ]
      : [],
  );
}

/** One of a computer's open threads, as the Move threads dialog and the quit offer list it. */
export interface MoveCandidate<TThreadId extends string = string> {
  readonly threadId: TThreadId;
  readonly title: string;
  /** Its agent is at work now (as this app last heard). */
  readonly working: boolean;
  /** The thread that started it, while it is in that thread's family. */
  readonly parentThreadId?: TThreadId;
}

/**
 * A computer's open threads, the ones a batch can ask to move: its inbox
 * rows (project threads, not archived, not wrapped up), then its general
 * chats (`generalChats`, given only when the computer moves them,
 * `threadMoveState`; they never join the inbox), less those already moving
 * or moved. Working ones first, each half in that order, at most
 * THREAD_MOVE_BATCH_MAX.
 */
export function listMoveCandidates<
  TThread extends {
    readonly id: string;
    readonly environmentId: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly moveStatus?: ThreadMoveStatus | undefined;
    readonly parentThreadId?: string | null | undefined;
    readonly attachedToParent?: boolean | undefined;
  },
>(
  entries: ReadonlyArray<{ readonly thread: TThread; readonly isDone: boolean }>,
  generalChats: ReadonlyArray<{ readonly thread: TThread }>,
  sourceEnvironmentId: string,
  isWorking: (thread: TThread) => boolean,
): MoveCandidate<TThread["id"]>[] {
  const listed = [...entries, ...generalChats.map(({ thread }) => ({ thread, isDone: false }))];
  const open = listed.flatMap(({ thread, isDone }) =>
    thread.environmentId === sourceEnvironmentId &&
    !isDone &&
    thread.archivedAt === null &&
    thread.moveStatus === undefined
      ? [
          {
            threadId: thread.id,
            title: thread.title,
            working: isWorking(thread),
            ...(thread.attachedToParent === true && typeof thread.parentThreadId === "string"
              ? { parentThreadId: thread.parentThreadId as TThread["id"] }
              : {}),
          },
        ]
      : [],
  );
  return [
    ...open.filter((candidate) => candidate.working),
    ...open.filter((candidate) => !candidate.working),
  ].slice(0, THREAD_MOVE_BATCH_MAX);
}

/**
 * The members of a running batch that wait on the user, with why: a stop
 * that couldn't be confirmed (its hold's words), or an agent waiting for an
 * answer. A quit waiting on the batch brings its window back for these.
 */
export function moveBatchNeedsYou(members: ReadonlyArray<ThreadMoveBatchMember>): MoveBatchMiss[] {
  return members.flatMap((member) => {
    if (member.final) return [];
    const title = member.title ?? "A thread";
    if (member.hold?.kind === "stop_unconfirmed") {
      return [{ threadId: member.threadId, title, words: member.hold.words }];
    }
    const answer = (member.waitsFor ?? []).some(
      (wait) => wait.code === "approval" || wait.code === "question",
    );
    return answer
      ? [{ threadId: member.threadId, title, words: "Its agent is waiting for your answer." }]
      : [];
  });
}

const SESSION_OUTCOME_WORDS: Record<ThreadMoveSessionOutcome, string> = {
  carries: "The agent keeps its full memory.",
  summary: "The agent gets a summary of the conversation.",
  too_large: "The agent gets a summary (its session is too large to send).",
};

/**
 * What a move does with the thread's agent session (docs/design/fleet.md,
 * Part 3d), as the dialogs say it under the agent: it keeps its full memory,
 * or gets a summary of the conversation.
 */
export function describeThreadMoveSession(outcome: ThreadMoveSessionOutcome): string {
  return SESSION_OUTCOME_WORDS[outcome];
}

/**
 * The session outcome for one of a target's agents, as the preview says it
 * for the thread's agent (or a room agent's entry, ThreadMoveRoomAgentTarget).
 * An agent it doesn't name (or a computer from before sessions travelled):
 * `summary`.
 */
export function threadMoveSessionOutcome(
  target: Pick<ThreadMoveTargetPreview, "sessionOutcomes">,
  instanceId: string | null,
): ThreadMoveSessionOutcome {
  return (
    target.sessionOutcomes?.find((entry) => entry.instanceId === instanceId)?.outcome ?? "summary"
  );
}

/** What moving one thread of the Move threads dialog means, in its row. */
export interface MoveCandidateWords {
  /** `refused`: it can't go there, greyed out with why. */
  readonly kind: "now" | "wait" | "refused";
  readonly words: string;
  /** What its agent gets of its session there (describeThreadMoveSession); absent when refused. */
  readonly session?: string;
  /** What comes along with it, in the server's words (Part 3e); absent when refused. */
  readonly brings?: ReadonlyArray<string>;
  /** What won't work there as it did, for the agent it moves with (Part 3e); absent when refused. */
  readonly notes?: ReadonlyArray<string>;
  /** A General Chats thread: "Lands in General chats on Windows PC · 14 files". */
  readonly landing?: string;
}

/**
 * One row of the Move threads dialog: "Moves now", "Moves when the agent
 * finishes", or why it can't go to `targetEnvironmentId`.
 */
export function describeMoveCandidate(
  preview: ThreadMovePreviewManyThread,
  targetEnvironmentId: string | null,
  /** The computer's name, for a General Chats thread's landing line. */
  targetLabel?: string,
): MoveCandidateWords {
  if (preview.refusal !== undefined) return { kind: "refused", words: preview.refusal };
  const targetRefusal =
    targetEnvironmentId === null
      ? undefined
      : preview.targetRefusals?.find((refusal) => refusal.environmentId === targetEnvironmentId);
  if (targetRefusal !== undefined) return { kind: "refused", words: targetRefusal.refusal };
  const outcome =
    preview.sessionOutcomes?.find((entry) => entry.environmentId === targetEnvironmentId)
      ?.outcome ?? "summary";
  const session = describeThreadMoveSession(outcome);
  // The agent there is the one it suggests, not named here: only the lines for any agent.
  const brings = threadMoveNotesFor(preview.brings, null);
  // The server says them already for that agent.
  const lines = preview.targetLines?.find((entry) => entry.environmentId === targetEnvironmentId);
  const notes = threadMoveNotesFor(lines?.notes, null);
  const landing =
    preview.folder !== undefined && targetLabel !== undefined
      ? describeThreadMoveLanding(
          {
            label: targetLabel,
            ...(lines?.projectName !== undefined ? { projectName: lines.projectName } : {}),
          },
          preview.folder,
        )
      : undefined;
  const waits = (preview.waitsFor ?? []).length > 0;
  return {
    kind: waits ? "wait" : "now",
    words: waits ? "Moves when the agent finishes" : "Moves now",
    session,
    ...(brings.length > 0 ? { brings } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(landing !== undefined ? { landing } : {}),
  };
}

/**
 * The Move threads dialog's order: threads whose agent is working first,
 * then the rest, each in the order given (the inbox's).
 */
export function orderMoveCandidates<T extends { readonly threadId: string }>(
  candidates: ReadonlyArray<T>,
  previewById: ReadonlyMap<string, ThreadMovePreviewManyThread>,
): T[] {
  const working = (candidate: T) =>
    (previewById.get(candidate.threadId)?.waitsFor ?? []).length > 0;
  return [...candidates.filter(working), ...candidates.filter((candidate) => !working(candidate))];
}

// ----- families (docs/design/fleet.md, Part 3f, (g)) --------------------------------------

/** A listed thread's family: its parent's id when that parent is listed too, else its own. */
function familyRootOf<T extends { readonly threadId: string; readonly parentThreadId?: string }>(
  candidates: ReadonlyArray<T>,
  candidate: T,
): string {
  const parent = candidate.parentThreadId;
  return parent !== undefined && candidates.some((entry) => entry.threadId === parent)
    ? parent
    : candidate.threadId;
}

/**
 * The Move threads dialog's rows with each family together: a parent, then
 * the children listed with it, in the order given otherwise. A family moves
 * as one group (`depth` 1 marks a child under its parent).
 */
export function groupMoveFamilies<
  T extends { readonly threadId: string; readonly parentThreadId?: string },
>(candidates: ReadonlyArray<T>): Array<{ readonly candidate: T; readonly depth: 0 | 1 }> {
  const grouped: Array<{ readonly candidate: T; readonly depth: 0 | 1 }> = [];
  for (const candidate of candidates) {
    if (familyRootOf(candidates, candidate) !== candidate.threadId) continue;
    grouped.push({ candidate, depth: 0 });
    for (const child of candidates) {
      if (
        child.threadId !== candidate.threadId &&
        familyRootOf(candidates, child) === candidate.threadId
      ) {
        grouped.push({ candidate: child, depth: 1 });
      }
    }
  }
  return grouped;
}

/**
 * A tick in the Move threads dialog, for families: ticking any member ticks
 * all of it that can go (a child moves only with its parent), unticking a
 * parent unticks its family, and unticking a child unticks only it, so it
 * stays here as its own thread. `canGo` says which can go to the computer picked.
 */
export function toggleMoveFamily<
  T extends { readonly threadId: string; readonly parentThreadId?: string },
>(
  ticked: ReadonlySet<T["threadId"]>,
  candidates: ReadonlyArray<T>,
  threadId: T["threadId"],
  on: boolean,
  canGo: (threadId: T["threadId"]) => boolean,
): Set<T["threadId"]> {
  const next = new Set(ticked);
  const candidate = candidates.find((entry) => entry.threadId === threadId);
  if (candidate === undefined) return next;
  const root = familyRootOf(candidates, candidate);
  const family = candidates.filter((entry) => familyRootOf(candidates, entry) === root);
  if (on) {
    for (const member of family) if (canGo(member.threadId)) next.add(member.threadId);
  } else if (candidate.threadId === root) {
    for (const member of family) next.delete(member.threadId);
  } else {
    next.delete(candidate.threadId);
  }
  return next;
}

/**
 * The threads a move takes when each must come with its whole family here
 * (the quit flow): every one asked, its parent when it is in a family, and
 * that parent's children not archived. Asked in that order, parents first.
 */
export function withMoveFamilies<TThreadId extends string>(
  threadIds: ReadonlyArray<TThreadId>,
  threads: ReadonlyArray<{
    readonly id: TThreadId;
    readonly parentThreadId?: TThreadId | null | undefined;
    readonly attachedToParent?: boolean | undefined;
    readonly archivedAt: string | null;
  }>,
): TThreadId[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const out = new Set<TThreadId>();
  for (const id of threadIds) {
    const thread = byId.get(id);
    const parent =
      thread?.attachedToParent === true && thread.parentThreadId != null
        ? byId.get(thread.parentThreadId)
        : undefined;
    const root = parent !== undefined && parent.archivedAt === null ? parent.id : id;
    out.add(root);
    for (const child of threads) {
      if (
        child.parentThreadId === root &&
        child.attachedToParent === true &&
        child.archivedAt === null
      ) {
        out.add(child.id);
      }
    }
    out.add(id);
  }
  return [...out];
}

/**
 * A child's choice to move with its family (docs/design/fleet.md, Part 3f,
 * (h)): "Move its whole family (4 threads)", the count when the server gave it.
 */
export function describeChildFamilyMove(familySize: number | undefined): string {
  return familySize === undefined
    ? "Move its whole family"
    : `Move its whole family (${familySize} threads)`;
}

/** "Its 3 threads move with it", for the threads of a family ticked to come. */
export function describeFamilyComing(count: number): string {
  return count === 0
    ? "None of its threads move with it."
    : count === 1
      ? "Its thread moves with it."
      : `Its ${count} threads move with it.`;
}

/**
 * "2 threads it started on Windows PC stay there. It can't reach them from
 * Mac mini.", one line per computer, for the threads its agent started on
 * other computers. Those on the computer it moves to, when that computer
 * takes them back (`adoptsChildren`), become its threads there again
 * (docs/design/fleet.md, Part 3f, (g)): "'Fix tests' on Mac mini becomes its
 * thread there again."
 */
export function describeRemoteChildrenStaying(
  remoteChildren: ReadonlyArray<{
    readonly label: string;
    readonly title: string;
    readonly environmentId?: string | undefined;
  }>,
  target: {
    readonly label: string;
    readonly environmentId: string;
    readonly adoptsChildren?: true | undefined;
  },
): string[] {
  const back = remoteChildren.filter(
    (child) => target.adoptsChildren === true && child.environmentId === target.environmentId,
  );
  const byLabel = new Map<string, number>();
  for (const child of remoteChildren) {
    if (back.includes(child)) continue;
    byLabel.set(child.label, (byLabel.get(child.label) ?? 0) + 1);
  }
  const [only] = back;
  return [
    ...(back.length === 0
      ? []
      : [
          back.length === 1 && only !== undefined
            ? `'${only.title}' on ${target.label} becomes its thread there again.`
            : `${back.length} threads it started on ${target.label} become its threads there again.`,
        ]),
    ...[...byLabel].map(([label, count]) =>
      count === 1
        ? `1 thread it started on ${label} stays there. It can't reach it from ${target.label}.`
        : `${count} threads it started on ${label} stay there. It can't reach them from ${target.label}.`,
    ),
  ];
}
