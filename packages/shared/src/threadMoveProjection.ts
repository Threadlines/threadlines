/**
 * A thread's move state after one of its move events: its queued move
 * (ThreadPendingMove, docs/design/fleet.md, Part 3b), its move under way or
 * done (OrchestrationThreadMove, Part 3), and how its last move went
 * (ThreadMoveOutcome, Part 3c). One rule for the in-memory projector and the
 * SQLite projection on the server, and the web app's live store, so none of
 * them disagree.
 *
 * Every event names the request or transfer it is about; one for another
 * leaves the state as it is. The outcome is set by the same events that end a
 * queued move without starting it (cancelled, blocked, gone) or settle a move
 * (aborted, moved away), and by the progress that says the other computer has
 * every byte and waits for its user (`staged`). It outlives the queued move
 * and the move it answers, so a batch can read each thread's answer later.
 * A move that didn't happen says why as a code (`reason`) beside its words.
 *
 * @module threadMoveProjection
 */
import type {
  OrchestrationEvent,
  OrchestrationThreadMove,
  ThreadMoveOutcome,
  ThreadMoveOutcomeReason,
  ThreadPendingMove,
} from "@threadlines/contracts";

export type ThreadMoveEvent = Extract<
  OrchestrationEvent,
  {
    readonly type:
      | "thread.move-queued"
      | "thread.move-mode-set"
      | "thread.move-quiescing"
      | "thread.move-queue-status-set"
      | "thread.move-queue-ended"
      | "thread.move-started"
      | "thread.move-progressed"
      | "thread.move-cancel-requested"
      | "thread.move-aborted"
      | "thread.moved-away";
  }
>;

export interface ThreadMoveState {
  readonly move: OrchestrationThreadMove | null;
  readonly pendingMove: ThreadPendingMove | null;
  readonly lastMoveOutcome: ThreadMoveOutcome | null;
}

const CANCELLED_WORDS = "You cancelled the move.";

/** The thread's queued move after `event`; the same object when it doesn't change. */
function nextPendingMove(
  current: ThreadPendingMove | null,
  event: ThreadMoveEvent,
): ThreadPendingMove | null {
  if (event.type === "thread.move-queued") return event.payload.pendingMove;
  if (!("requestId" in event.payload)) return current;
  if (current === null || current.requestId !== event.payload.requestId) return current;
  switch (event.type) {
    // "Stop the agents and move now": the sessions end in the same decision,
    // so the fence holds from here, as for a move queued that way.
    case "thread.move-mode-set":
      return { ...current, mode: event.payload.mode, stage: "quiescing" };
    case "thread.move-quiescing":
      return { ...current, stage: "quiescing" };
    case "thread.move-queue-status-set":
      return { ...current, waitsFor: event.payload.waitsFor, hold: event.payload.hold };
    case "thread.move-queue-ended":
      return null;
    default:
      return current;
  }
}

/** The thread's move after `event`; the same object when it doesn't change. */
function nextMove(
  move: OrchestrationThreadMove | null,
  event: ThreadMoveEvent,
): OrchestrationThreadMove | null {
  if (event.type === "thread.move-started") {
    const payload = event.payload;
    return {
      transferId: payload.transferId,
      target: payload.target,
      agent: payload.agent,
      phase: "exporting",
      cancelRequested: false,
      startedAt: payload.startedAt,
      ...(payload.queuedRequestId !== undefined
        ? { queuedRequestId: payload.queuedRequestId }
        : {}),
      ...(payload.batchId !== undefined ? { batchId: payload.batchId } : {}),
    };
  }
  if (!("transferId" in event.payload)) return move;
  if (move === null || move.transferId !== event.payload.transferId) return move;
  switch (event.type) {
    case "thread.move-progressed": {
      const payload = event.payload;
      // Waiting for the other computer lasts until its next step says otherwise.
      const { waitingForTarget: _waiting, ...rest } = move;
      return {
        ...rest,
        phase: payload.phase,
        ...(payload.waitingForTarget === true ? { waitingForTarget: true } : {}),
        ...(payload.sentBytes !== undefined ? { sentBytes: payload.sentBytes } : {}),
        ...(payload.totalBytes !== undefined ? { totalBytes: payload.totalBytes } : {}),
      };
    }
    case "thread.move-cancel-requested":
      return { ...move, cancelRequested: true };
    case "thread.move-aborted":
      return null;
    case "thread.moved-away":
      return {
        ...move,
        movedAway: { threadId: event.payload.movedThreadId, movedAt: event.payload.movedAt },
      };
    default:
      return move;
  }
}

/** The outcome a move under way reaches. */
function moveOutcome(
  move: OrchestrationThreadMove,
  result: ThreadMoveOutcome["result"],
  at: string,
  why?: { readonly words: string; readonly reason: ThreadMoveOutcomeReason | undefined },
): ThreadMoveOutcome {
  return {
    result,
    target: move.target,
    ...(move.queuedRequestId !== undefined ? { requestId: move.queuedRequestId } : {}),
    transferId: move.transferId,
    ...(move.batchId !== undefined ? { batchId: move.batchId } : {}),
    ...(why !== undefined ? { words: why.words } : {}),
    ...(why?.reason !== undefined ? { reason: why.reason } : {}),
    at,
  };
}

/** How the thread's last move went after `event`, read against the state before it. */
function nextOutcome(state: ThreadMoveState, event: ThreadMoveEvent): ThreadMoveOutcome | null {
  const current = state.lastMoveOutcome;
  switch (event.type) {
    case "thread.move-queue-ended": {
      const pending = state.pendingMove;
      const payload = event.payload;
      if (pending === null || pending.requestId !== payload.requestId) return current;
      if (payload.reason === "started") return current;
      return {
        result: "not_moved",
        target: pending.target,
        requestId: pending.requestId,
        ...(pending.batchId !== undefined ? { batchId: pending.batchId } : {}),
        words: payload.words ?? CANCELLED_WORDS,
        reason: payload.reason,
        at: payload.endedAt,
      };
    }
    case "thread.move-progressed": {
      const move = state.move;
      const payload = event.payload;
      if (move === null || move.transferId !== payload.transferId) return current;
      if (payload.phase !== "awaiting_approval" || payload.staged !== true) return current;
      return moveOutcome(move, "awaiting_approval", payload.updatedAt);
    }
    case "thread.move-aborted": {
      const move = state.move;
      if (move === null || move.transferId !== event.payload.transferId) return current;
      return moveOutcome(move, "not_moved", event.payload.updatedAt, {
        words: event.payload.reason,
        reason: event.payload.code,
      });
    }
    case "thread.moved-away": {
      const move = state.move;
      if (move === null || move.transferId !== event.payload.transferId) return current;
      if (move.movedAway !== undefined) return current;
      return moveOutcome(move, "moved", event.payload.movedAt);
    }
    default:
      return current;
  }
}

/** The thread's move state after `event`; the same object when nothing changed. */
export function nextThreadMoveState(
  state: ThreadMoveState,
  event: ThreadMoveEvent,
): ThreadMoveState {
  const pendingMove = nextPendingMove(state.pendingMove, event);
  const move = nextMove(state.move, event);
  const lastMoveOutcome = nextOutcome(state, event);
  return pendingMove === state.pendingMove &&
    move === state.move &&
    lastMoveOutcome === state.lastMoveOutcome
    ? state
    : { move, pendingMove, lastMoveOutcome };
}
