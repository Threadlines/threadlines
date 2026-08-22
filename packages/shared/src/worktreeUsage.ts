/**
 * Which threads are still using a worktree.
 *
 * Shared because two very different callers need the same answer: the server
 * refuses to remove a folder a thread is working in (see
 * `apps/server/src/vcs/WorktreeRemovalGuard.ts`), and the client greys out the
 * same folders in its cleanup list so the user is never offered a deletion the
 * server would decline.
 *
 * @module worktreeUsage
 */
import { normalizeWorkspacePath } from "./path.ts";

/** The subset of a thread shell this policy reads. */
export interface WorktreeUsageThread {
  readonly id: string;
  readonly title?: string | null | undefined;
  readonly worktreePath: string | null;
  readonly effectiveCwd?: string | null | undefined;
  readonly session?:
    | {
        readonly status: string;
        readonly checkoutCwd?: string | null | undefined;
      }
    | null
    | undefined;
}

export interface WorktreeBlockingThread {
  readonly threadId: string;
  readonly title: string | null;
  readonly hasLiveSession: boolean;
}

const samePath = (left: string | null | undefined, right: string): boolean =>
  typeof left === "string" &&
  left.length > 0 &&
  normalizeWorkspacePath(left) === normalizeWorkspacePath(right);

/**
 * A session counts as live unless it has been stopped. `error` and
 * `interrupted` sessions still own a runtime that can be resumed in place, so
 * they block too; only an explicitly stopped session releases the folder.
 */
const hasLiveSessionIn = (thread: WorktreeUsageThread, worktreePath: string): boolean => {
  const session = thread.session;
  if (!session || session.status === "stopped") {
    return false;
  }
  return (
    samePath(session.checkoutCwd, worktreePath) ||
    samePath(thread.effectiveCwd, worktreePath) ||
    samePath(thread.worktreePath, worktreePath)
  );
};

/**
 * Threads that still use `worktreePath`, either as their configured checkout or
 * as the directory a live session is actually running in. Pure so the policy is
 * testable without a database.
 */
export function findWorktreeBlockingThreads(input: {
  readonly worktreePath: string;
  readonly threads: ReadonlyArray<WorktreeUsageThread>;
}): ReadonlyArray<WorktreeBlockingThread> {
  const blocking: WorktreeBlockingThread[] = [];
  for (const thread of input.threads) {
    const live = hasLiveSessionIn(thread, input.worktreePath);
    const bound = samePath(thread.worktreePath, input.worktreePath);
    if (!live && !bound) {
      continue;
    }
    blocking.push({
      threadId: thread.id,
      title: thread.title?.trim() || null,
      hasLiveSession: live,
    });
  }
  return blocking;
}
