import type { VcsRef } from "@threadlines/contracts";

import type { Thread } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: readonly Thread[],
  threadId: Thread["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
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
