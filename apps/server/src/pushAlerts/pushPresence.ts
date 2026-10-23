/**
 * Which threads someone is looking at right now, per connection
 * (`presence.setViewing`). A thread on screen gets no alerts. Each entry is a
 * lease the client renews while it stays on that thread, so a phone that went
 * to sleep, or a connection that died without a close, can't keep a thread
 * muted for long.
 */
import type { ThreadId } from "@threadlines/contracts";

/** How long one report holds; clients renew well inside it. */
export const PRESENCE_LEASE_MS = 90_000;

export interface PushPresence {
  /** This connection is looking at `threadId` now, or (null) at no thread. */
  readonly set: (viewerId: string, threadId: ThreadId | null, nowMs: number) => void;
  /** The connection closed. */
  readonly release: (viewerId: string) => void;
  readonly isViewed: (threadId: ThreadId, nowMs: number) => boolean;
}

export function makePushPresence(): PushPresence {
  const viewers = new Map<string, { readonly threadId: ThreadId; readonly expiresAt: number }>();
  return {
    set: (viewerId, threadId, nowMs) => {
      if (threadId === null) viewers.delete(viewerId);
      else viewers.set(viewerId, { threadId, expiresAt: nowMs + PRESENCE_LEASE_MS });
    },
    release: (viewerId) => {
      viewers.delete(viewerId);
    },
    isViewed: (threadId, nowMs) => {
      let viewed = false;
      for (const [viewerId, entry] of viewers) {
        if (entry.expiresAt <= nowMs) viewers.delete(viewerId);
        else if (entry.threadId === threadId) viewed = true;
      }
      return viewed;
    },
  };
}
