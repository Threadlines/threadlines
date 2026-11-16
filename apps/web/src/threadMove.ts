/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3), as the
 * app words and decides it: when the move is offered, what a move takes with
 * it, how far one got, and whether one can still finish. Pure: the dialog,
 * the composer notice, the sidebar and the request rows read the same rules.
 *
 * @module threadMove
 */
import {
  type ModelSelection,
  type OrchestrationThreadMove,
  type OutboundComputerLink,
  type ThreadMoveChanges,
  ThreadMoveNotStartedActivityKind,
  type ThreadMoveTargetPreview,
  type ThreadMoveWait,
  type ThreadMoveWaitCode,
  type ThreadPendingMove,
} from "@threadlines/contracts";

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
 * "queued" while a move waits for the thread to be free (Part 3b), "moving"
 * until the other computer took it, "moved" after; undefined for none.
 */
export function threadMoveStatus(thread: {
  readonly move?: OrchestrationThreadMove | null | undefined;
  readonly pendingMove?: ThreadPendingMove | null | undefined;
}): ThreadMoveStatus | undefined {
  const move = thread.move ?? null;
  if (move !== null) return move.movedAway ? "moved" : "moving";
  return thread.pendingMove ? "queued" : undefined;
}

/** A move status as a sidebar row says it: "move queued", "moving", "moved". */
export function threadMoveStatusWord(status: ThreadMoveStatus): string {
  return status === "queued" ? "move queued" : status;
}

/**
 * Whether to offer "Move to another computer" for a thread: its computer
 * moves threads, links to at least one computer right now, and the thread
 * isn't moving or moved already. Everything else (a room, live work, a
 * computer that can't take it) the dialog shows with its reason.
 */
export function isThreadMoveOffered(input: {
  readonly supportsThreadMove: boolean;
  /** The thread's computer's own links, as last heard; null when not heard. */
  readonly outbound: ReadonlyArray<OutboundComputerLink> | null;
  readonly moveStatus: ThreadMoveStatus | undefined;
}): boolean {
  return (
    input.supportsThreadMove &&
    input.moveStatus === undefined &&
    (input.outbound ?? []).some((link) => link.state === "active")
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

/** Where an unfinished move is, in a few words: the composer notice's lead. */
export function describeThreadMoveProgress(move: OrchestrationThreadMove): string {
  const label = move.target.label;
  if (move.cancelRequested) return "Stopping the move…";
  switch (move.phase) {
    case "exporting":
      return `Getting ready to move to ${label}…`;
    case "awaiting_approval":
      return `Waiting for ${label} to allow the move`;
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
  return target.refusal === undefined || target.refusalCode === "unreachable";
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

/** The agent to preselect: the target's suggestion when it has it, else its first model. */
export function pickDefaultMoveAgent(
  target: Pick<ThreadMoveTargetPreview, "agents" | "suggestedAgent">,
): ThreadMoveAgentChoice | null {
  const suggested = target.suggestedAgent;
  if (
    suggested &&
    target.agents.some(
      (agent) =>
        agent.instanceId === suggested.instanceId &&
        agent.models.some((model) => model.model === suggested.model),
    )
  ) {
    return { instanceId: suggested.instanceId, model: suggested.model };
  }
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
export function threadMoveStopNowRefusal(waits: ReadonlyArray<ThreadMoveWait>): string | null {
  return waits.some((wait) => wait.code === "command_run")
    ? "A command from this thread is running in your terminal. Stop it there, or move the thread when it's done."
    : null;
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
