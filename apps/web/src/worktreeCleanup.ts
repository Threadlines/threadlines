import {
  GitCommandError,
  VcsWorktreeInUseError,
  type VcsRef,
  type VcsWorktreeStatus,
} from "@threadlines/contracts";
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
  /** See VcsWorktreeStatus.dirtyUnknown. */
  readonly dirtyUnknown: boolean;
  readonly unmergedCommitCount: number | null;
  /** See VcsWorktreeStatus.unrelatedHistory. */
  readonly unrelatedHistory: boolean;
  /** See VcsWorktreeStatus.mergedByContent. */
  readonly mergedByContent: boolean;
  /** See VcsWorktreeStatus.missing. */
  readonly missing: boolean;
  /** See VcsWorktreeStatus.lockReason. */
  readonly lockReason: string | null;
  readonly state: WorktreeCleanupState;
  /** Titles of the archived threads pointing here, for the confirm dialog. */
  readonly archivedThreadTitles: readonly string[];
  /** Titles of the active threads holding an in-use row. */
  readonly blockingThreadTitles: readonly string[];
  /** Archived threads could not be read, so one may still point here. */
  readonly archiveUnknown: boolean;
}

const threadTitle = (thread: { readonly title?: string | null | undefined }): string =>
  thread.title?.trim() || "Untitled thread";

/** The repository's secondary checkouts, tagged with what still points at them. */
export function classifyWorktreesForCleanup(input: {
  readonly worktrees: readonly VcsWorktreeStatus[];
  readonly liveThreads: readonly WorktreeUsageThread[];
  readonly archivedThreads: readonly WorktreeUsageThread[];
  /** The archived thread list failed to load. */
  readonly archivedThreadsUnknown?: boolean;
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
        dirtyUnknown: worktree.dirtyUnknown,
        unmergedCommitCount: worktree.unmergedCommitCount,
        unrelatedHistory: worktree.unrelatedHistory,
        mergedByContent: worktree.mergedByContent,
        missing: worktree.missing,
        lockReason: worktree.lockReason,
        state: live.length > 0 ? "in-use" : archived.length > 0 ? "archived" : "unused",
        archivedThreadTitles: archived.map((thread) => thread.title ?? "Untitled thread"),
        blockingThreadTitles: live.map((thread) => threadTitle(thread)),
        archiveUnknown: input.archivedThreadsUnknown === true,
      } satisfies WorktreeCleanupRow;
    });
}

/**
 * Every change on the branch is on the default branch: none of its commits
 * are missing there, or the ones that are were squash- or rebase-merged.
 */
function isBranchShipped(row: WorktreeCleanupRow): boolean {
  return (
    !row.unrelatedHistory &&
    row.unmergedCommitCount !== null &&
    (row.unmergedCommitCount === 0 || row.mergedByContent)
  );
}

/**
 * A checkout whose removal provably loses nothing: no uncommitted changes, all
 * of its branch's work already on the default branch, no lock, and nothing
 * pointing at it. A registration whose folder is already gone holds no files
 * at all. These are the rows the cleanup dialog pre-checks; everything else
 * the user opts into. Unknown is never safe: a status git could not read, a
 * commit count it could not take (a detached checkout, unrelated histories, no
 * resolvable default branch), or an archived thread list that did not load.
 */
export function isWorktreeSafeToDelete(row: WorktreeCleanupRow): boolean {
  if (
    row.state !== "unused" ||
    row.archiveUnknown ||
    row.archivedThreadTitles.length > 0 ||
    row.lockReason !== null
  ) {
    return false;
  }
  return row.missing || (!row.dirty && !row.dirtyUnknown && isBranchShipped(row));
}

/**
 * What the user should know before deleting, phrased for a muted note under
 * the row: mostly what a removal would lose. Empty for a row with nothing to
 * say. Shipped commits are not mentioned; the branch stays either way.
 */
export function describeWorktreeNotes(
  row: WorktreeCleanupRow,
  defaultBranchName: string | null,
): readonly string[] {
  const notes: string[] = [];
  const base = defaultBranchName ?? "the default branch";
  if (row.lockReason !== null) {
    notes.push(row.lockReason.length > 0 ? `locked: ${row.lockReason}` : "locked");
  }
  if (row.missing) {
    notes.push("folder already gone");
  } else {
    if (row.refName === null) {
      notes.push("detached checkout");
    }
    if (row.dirtyUnknown) {
      notes.push("couldn't check for uncommitted changes");
    } else if (row.dirty) {
      notes.push("uncommitted changes");
    }
    if (row.unrelatedHistory) {
      // Counting here would report the branch's entire history as unshipped work.
      notes.push(`no shared history with ${base}`);
    } else if (row.unmergedCommitCount === null) {
      if (row.refName !== null) {
        notes.push(`couldn't compare with ${base}`);
      }
    } else if (row.unmergedCommitCount > 0 && !row.mergedByContent) {
      notes.push(
        `${row.unmergedCommitCount} commit${row.unmergedCommitCount === 1 ? "" : "s"} not on ${base}`,
      );
    }
  }
  if (row.archivedThreadTitles.length > 0) {
    notes.push(
      `archived thread${row.archivedThreadTitles.length === 1 ? "" : "s"} point${
        row.archivedThreadTitles.length === 1 ? "s" : ""
      } here`,
    );
  } else if (row.archiveUnknown && row.state !== "in-use") {
    notes.push("couldn't check archived threads");
  }
  return notes;
}

/** Who holds an in-use row, for the muted label at its end. */
export function describeWorktreeHolder(row: WorktreeCleanupRow): string {
  const [first, ...rest] = row.blockingThreadTitles;
  if (first === undefined) {
    return "in use";
  }
  return rest.length === 0 ? `used by ${first}` : `used by ${first} +${rest.length}`;
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

function toSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  const capped = trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}...` : trimmed;
  const capitalized = capped.charAt(0).toUpperCase() + capped.slice(1);
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

/**
 * One plain sentence for a failed worktree removal, shown under its row or in
 * a toast. Known failures get a next step; anything else falls back to git's
 * own words without its "fatal:" prefix.
 */
export function describeWorktreeRemovalError(error: unknown): string {
  if (error instanceof VcsWorktreeInUseError) {
    const names = error.blockingThreads.map((thread) => `"${threadTitle(thread)}"`);
    return names.length > 0 ? `Now in use by ${names.join(", ")}.` : "Now in use by a thread.";
  }
  const detail =
    error instanceof GitCommandError ? error.detail : error instanceof Error ? error.message : "";
  if (/locked working tree/iu.test(detail)) {
    return "Something locked this worktree. Reopen the list to see what.";
  }
  if (/timed out/iu.test(detail)) {
    return "Deleting took too long. Try again to finish.";
  }
  if (
    /failed to delete|permission denied|resource busy|directory not empty|operation not permitted/iu.test(
      detail,
    )
  ) {
    return "Some files are still open. Close anything using this folder, then try again.";
  }
  if (/is not a working tree/iu.test(detail)) {
    return "Git no longer tracks this worktree, but its folder is still there.";
  }
  const gitMessage = /^(?:fatal|error): (.+)$/mu.exec(detail)?.[1] ?? detail.split("\n")[0] ?? "";
  return gitMessage.trim().length > 0 ? toSentence(gitMessage) : "Couldn't delete this worktree.";
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
