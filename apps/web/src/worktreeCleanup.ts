import type { VcsRef } from "@threadlines/contracts";

/** Any thread shape that records a checkout: live store threads and archived shells both qualify. */
export interface WorktreeLinkedThread {
  readonly id: string;
  readonly worktreePath: string | null;
}

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

/**
 * The worktree a thread would leave behind, or null when something else still
 * points at it.
 *
 * Archived threads count: they can recreate their checkout later through
 * checkout recovery, so deleting a live thread must not offer to remove the
 * folder an archived one is waiting on -- and the same in reverse. The target
 * thread may come from either list.
 */
export function getOrphanedWorktreePathForThread(
  threads: readonly WorktreeLinkedThread[],
  threadId: string,
  archivedThreads: readonly WorktreeLinkedThread[] = [],
): string | null {
  const targetThread =
    threads.find((thread) => thread.id === threadId) ??
    archivedThreads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = [...threads, ...archivedThreads].some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export type VcsRefBadge = "current" | "worktree" | "remote" | "default";

/**
 * The one-word tag a branch row carries in every picker.
 *
 * "worktree" means the branch is checked out somewhere other than the
 * project's root checkout, which is why the comparison is against the project
 * root and not whichever checkout the picker happens to be showing.
 */
export function getVcsRefBadge(ref: VcsRef, projectRootCwd: string | null): VcsRefBadge | null {
  if (ref.current) {
    return "current";
  }
  if (ref.worktreePath && projectRootCwd && ref.worktreePath !== projectRootCwd) {
    return "worktree";
  }
  if (ref.isRemote) {
    return "remote";
  }
  if (ref.isDefault) {
    return "default";
  }
  return null;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
