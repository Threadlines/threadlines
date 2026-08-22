import type { VcsRef, VcsWorktreeStatus } from "@threadlines/contracts";
import {
  findWorktreeBlockingThreads,
  type WorktreeUsageThread,
} from "@threadlines/shared/worktreeUsage";

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

/**
 * Why a worktree can or cannot be removed.
 *
 * `in-use` mirrors the server's removal guard exactly, so the cleanup list
 * never offers a deletion the server would refuse. `archived` still points
 * somewhere -- an archived thread can bring the checkout back through checkout
 * recovery -- but removing it is the user's call.
 */
export type WorktreeCleanupState = "in-use" | "archived" | "unused";

export interface WorktreeCleanupRow {
  readonly path: string;
  readonly refName: string | null;
  readonly dirty: boolean;
  readonly unmergedCommitCount: number | null;
  /** See VcsWorktreeStatus.unrelatedHistory. */
  readonly unrelatedHistory: boolean;
  readonly state: WorktreeCleanupState;
  /** Titles of the archived threads pointing here, for the confirm dialog. */
  readonly archivedThreadTitles: readonly string[];
}

/** The repository's secondary checkouts, tagged with what still points at them. */
export function classifyWorktreesForCleanup(input: {
  readonly worktrees: readonly VcsWorktreeStatus[];
  readonly liveThreads: readonly WorktreeUsageThread[];
  readonly archivedThreads: readonly WorktreeUsageThread[];
}): readonly WorktreeCleanupRow[] {
  return input.worktrees
    .filter((worktree) => !worktree.isRoot)
    .map((worktree) => {
      const live = findWorktreeBlockingThreads({
        worktreePath: worktree.path,
        threads: input.liveThreads,
      });
      const archived = findWorktreeBlockingThreads({
        worktreePath: worktree.path,
        threads: input.archivedThreads,
      });
      return {
        path: worktree.path,
        refName: worktree.refName,
        dirty: worktree.dirty,
        unmergedCommitCount: worktree.unmergedCommitCount,
        unrelatedHistory: worktree.unrelatedHistory,
        state: live.length > 0 ? "in-use" : archived.length > 0 ? "archived" : "unused",
        archivedThreadTitles: archived.map((thread) => thread.title ?? "Untitled thread"),
      } satisfies WorktreeCleanupRow;
    });
}

/**
 * A checkout whose removal provably loses nothing: no uncommitted changes, a
 * verified count of zero commits the default branch is missing, and nothing
 * pointing at it. These are the rows the cleanup dialog pre-checks; everything
 * else the user opts into. A null count means the state could not be read (a
 * detached checkout, unrelated histories, or no resolvable default branch) and
 * unknown is not safe. Unrelated history is spelled out rather than left to the
 * null count, because that is the whole point of the flag.
 */
export function isWorktreeSafeToDelete(row: WorktreeCleanupRow): boolean {
  return (
    row.state === "unused" &&
    !row.dirty &&
    !row.unrelatedHistory &&
    row.unmergedCommitCount === 0 &&
    row.archivedThreadTitles.length === 0
  );
}

/**
 * What a removal would throw away, phrased for a muted note under the row.
 * Empty means the row is safe.
 */
export function describeWorktreeRisks(
  row: WorktreeCleanupRow,
  defaultBranchName: string | null,
): readonly string[] {
  const risks: string[] = [];
  if (row.refName === null) {
    risks.push("detached checkout");
  }
  if (row.dirty) {
    risks.push("uncommitted changes");
  }
  if (row.unrelatedHistory) {
    // Counting here would report the branch's entire history as unshipped work.
    risks.push(`no shared history with ${defaultBranchName ?? "the default branch"}`);
  } else if (row.unmergedCommitCount !== null && row.unmergedCommitCount > 0) {
    risks.push(
      `${row.unmergedCommitCount} commit${row.unmergedCommitCount === 1 ? "" : "s"} not on ${
        defaultBranchName ?? "the default branch"
      }`,
    );
  }
  if (row.archivedThreadTitles.length > 0) {
    risks.push(
      `archived thread${row.archivedThreadTitles.length === 1 ? "" : "s"} point${
        row.archivedThreadTitles.length === 1 ? "s" : ""
      } here`,
    );
  }
  return risks;
}

/** What the cleanup dialog's confirm button needs to know about the ticked rows. */
export function summarizeWorktreeSelection(
  rows: readonly WorktreeCleanupRow[],
  selectedPaths: ReadonlySet<string>,
): { readonly count: number; readonly hasRisky: boolean } {
  const selected = rows.filter((row) => selectedPaths.has(row.path));
  return {
    count: selected.length,
    hasRisky: selected.some((row) => !isWorktreeSafeToDelete(row)),
  };
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
