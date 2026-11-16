/**
 * A thread's queued move (ThreadPendingMove, docs/design/fleet.md, Part 3b)
 * after one of its events: one rule for the in-memory projector and the
 * SQLite projection, so the two never disagree. Every event names the
 * request it is about; one for another request leaves the pending move as it
 * is.
 */
import type { OrchestrationEvent, ThreadPendingMove } from "@threadlines/contracts";

export type PendingMoveEvent = Extract<
  OrchestrationEvent,
  {
    readonly type:
      | "thread.move-queued"
      | "thread.move-quiescing"
      | "thread.move-queue-status-set"
      | "thread.move-queue-ended";
  }
>;

export function nextPendingMove(
  current: ThreadPendingMove | null,
  event: PendingMoveEvent,
): ThreadPendingMove | null {
  if (event.type === "thread.move-queued") return event.payload.pendingMove;
  if (current === null || current.requestId !== event.payload.requestId) return current;
  switch (event.type) {
    case "thread.move-quiescing":
      return { ...current, stage: "quiescing" };
    case "thread.move-queue-status-set":
      return { ...current, waitsFor: event.payload.waitsFor, hold: event.payload.hold };
    case "thread.move-queue-ended":
      return null;
  }
}
