import type { ThreadId, ThreadWorktreeOrigin } from "@threadlines/contracts";

/**
 * The thread whose worktree a guest thread works in, when it is another
 * thread's (ThreadWorktreeOrigin `thread`). Null for a thread in its own
 * worktree, and for one the user pointed at a worktree the repository
 * already had (`existing`): that one has no other thread to name.
 */
export function lendingThreadId(origin: ThreadWorktreeOrigin | null | undefined): ThreadId | null {
  return origin?.kind === "thread" ? origin.threadId : null;
}
