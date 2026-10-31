/**
 * The facts a thread's wrap-up rules read that don't depend on the device
 * looking at it: when its work last moved, and whether it holds a finished
 * turn or a failure the user hasn't opened. The sidebar reads them for the
 * threads it shows (apps/web Sidebar.logic.ts), and a linked computer sends
 * them for each thread it runs for a parent on another computer
 * (`remoteThreadFilingOf`), so both computers file that thread alike.
 */
import type { OrchestrationThreadShell, RemoteThreadFiling } from "@threadlines/contracts";

import { isHandedBackCompletion } from "./childThreads.ts";

interface ActivityInput {
  readonly latestUserMessageAt?: string | null | undefined;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly updatedAt?: string | undefined;
  readonly createdAt: string;
}

/** When a thread's work last moved: its newest message or turn, else when it last changed. */
export function threadLastActivityAt(thread: ActivityInput): string {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest ?? thread.updatedAt ?? thread.createdAt;
}

/** Its newest turn finished after the user last saw it (or they never did). */
export function hasUnseenCompletion(
  thread: { readonly latestTurn: { readonly completedAt: string | null } | null },
  seenAt: string | null | undefined,
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!seenAt) return true;
  const seenMs = Date.parse(seenAt);
  return Number.isNaN(seenMs) || completedAt > seenMs;
}

/** Its session failed after the user last saw it (or they never did). */
export function hasUnseenSessionFailure(
  thread: {
    readonly session: { readonly status: string; readonly updatedAt: string } | null | undefined;
  },
  seenAt: string | null | undefined,
): boolean {
  if (thread.session?.status !== "error") return false;
  const failedAt = Date.parse(thread.session.updatedAt);
  if (Number.isNaN(failedAt)) return false;
  if (seenAt == null) return true;
  const seenMs = Date.parse(seenAt);
  return Number.isNaN(seenMs) || failedAt > seenMs;
}

/**
 * How the computer a thread runs on files it, for the parent's computer: the
 * facts behind its own wrap-up rules, read from the thread's shell, its seen
 * stamp the server's (a device's first-load guess never leaves that device).
 */
export function remoteThreadFilingOf(
  shell: Pick<
    OrchestrationThreadShell,
    | "latestTurn"
    | "latestUserMessageAt"
    | "updatedAt"
    | "createdAt"
    | "pinnedAt"
    | "doneOverride"
    | "lastSeenAt"
    | "handedBackAt"
    | "handedBackTurnId"
    | "session"
    | "checkBacks"
    | "queuedFollowUps"
  >,
): RemoteThreadFiling {
  const handedBack = isHandedBackCompletion({
    handedBackTurnId: shell.handedBackTurnId,
    latestTurn: shell.latestTurn,
  });
  return {
    handedBackAt: handedBack ? shell.handedBackAt : null,
    pinned: shell.pinnedAt !== null,
    override: shell.doneOverride,
    lastActivityAt: threadLastActivityAt(shell),
    seenAt: shell.lastSeenAt,
    unseen:
      hasUnseenCompletion(shell, shell.lastSeenAt) ||
      hasUnseenSessionFailure(shell, shell.lastSeenAt),
    waiting:
      (shell.checkBacks?.length ?? 0) > 0 ||
      (shell.session?.continueAtReset ?? null) !== null ||
      (shell.queuedFollowUps?.length ?? 0) > 0,
    archived: false,
  };
}
