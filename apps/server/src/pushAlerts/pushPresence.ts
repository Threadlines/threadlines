/**
 * Who is around, as phone alerts need to know. Two things, both held only in
 * memory, since a client says them again when it reconnects:
 *
 * - Which threads someone is looking at, per connection
 *   (`presence.setViewing`). Each entry is a lease the client renews while it
 *   stays on that thread, so a phone that went to sleep, or a connection that
 *   died without a close, can't keep a thread muted for long.
 * - When a computer's Threadlines was last used (`presence.noteActive`). Not
 *   tied to a connection: a window that drops and comes back was still in use.
 *   See COMPUTER_IN_USE_MS for how long that lasts.
 */
import type { ThreadId } from "@threadlines/contracts";
import { COMPUTER_IN_USE_MS } from "@threadlines/shared/phoneAlerts";

/** How long one report holds; clients renew well inside it. */
export const PRESENCE_LEASE_MS = 90_000;

/** Who is looking at a thread. A computer's look can leave an alert waiting; a phone's can't. */
export type ThreadViewer = "computer" | "other";

export interface PushPresence {
  /** This connection is looking at `threadId` now, or (null) at no thread. */
  readonly set: (
    viewerId: string,
    threadId: ThreadId | null,
    nowMs: number,
    isComputer?: boolean,
  ) => void;
  /** The connection closed. */
  readonly release: (viewerId: string) => void;
  readonly isViewed: (threadId: ThreadId, nowMs: number) => boolean;
  /** Who is looking at the thread now: `other` if anyone but a computer is. */
  readonly viewerOf: (threadId: ThreadId, nowMs: number) => ThreadViewer | null;
  /** A computer's window was used `idleMs` ago. */
  readonly noteComputerActive: (idleMs: number, nowMs: number) => void;
  /** Someone used Threadlines on a computer within COMPUTER_IN_USE_MS. */
  readonly computerInUse: (nowMs: number) => boolean;
}

export function makePushPresence(): PushPresence {
  const viewers = new Map<
    string,
    { readonly threadId: ThreadId; readonly expiresAt: number; readonly isComputer: boolean }
  >();
  let computerUsedAt: number | null = null;
  const viewerOf: PushPresence["viewerOf"] = (threadId, nowMs) => {
    let viewer: ThreadViewer | null = null;
    for (const [viewerId, entry] of viewers) {
      if (entry.expiresAt <= nowMs) viewers.delete(viewerId);
      else if (entry.threadId === threadId) {
        viewer = entry.isComputer && viewer !== "other" ? "computer" : "other";
      }
    }
    return viewer;
  };
  return {
    set: (viewerId, threadId, nowMs, isComputer = false) => {
      if (threadId === null) viewers.delete(viewerId);
      else viewers.set(viewerId, { threadId, expiresAt: nowMs + PRESENCE_LEASE_MS, isComputer });
    },
    release: (viewerId) => {
      viewers.delete(viewerId);
    },
    isViewed: (threadId, nowMs) => viewerOf(threadId, nowMs) !== null,
    viewerOf,
    noteComputerActive: (idleMs, nowMs) => {
      const usedAt = nowMs - idleMs;
      // A time still ahead of now is from before this clock stepped back.
      if (computerUsedAt === null || computerUsedAt > nowMs || usedAt > computerUsedAt) {
        computerUsedAt = usedAt;
      }
    },
    computerInUse: (nowMs) =>
      computerUsedAt !== null &&
      computerUsedAt <= nowMs &&
      nowMs - computerUsedAt < COMPUTER_IN_USE_MS,
  };
}
