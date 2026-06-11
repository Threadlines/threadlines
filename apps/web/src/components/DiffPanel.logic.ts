import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { VcsStatusResult } from "@t3tools/contracts";

import type { TurnDiffSummary } from "../types";

export interface DiffFileStat {
  readonly additions: number;
  readonly deletions: number;
}

export function computeFileDiffStat(fileDiff: FileDiffMetadata): DiffFileStat {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

export function sumDiffFileStats(stats: readonly DiffFileStat[]): DiffFileStat {
  let additions = 0;
  let deletions = 0;
  for (const stat of stats) {
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return { additions, deletions };
}

export function formatDiffFileCount(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

export interface TurnDiffSummaryStats {
  readonly fileCount: number;
  readonly lineStats: DiffFileStat | null;
}

/**
 * Per-turn totals for the source picker. Line stats are omitted when no file
 * in the summary carries numeric counts (older checkpoints).
 */
export function resolveTurnDiffSummaryStats(
  summary: Pick<TurnDiffSummary, "files">,
): TurnDiffSummaryStats {
  let additions = 0;
  let deletions = 0;
  let hasLineStats = false;
  for (const file of summary.files) {
    if (typeof file.additions === "number" || typeof file.deletions === "number") {
      hasLineStats = true;
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
  }
  return {
    fileCount: summary.files.length,
    lineStats: hasLineStats ? { additions, deletions } : null,
  };
}

/**
 * Stable fingerprint of the parts of git status that change what the
 * working-tree diff would render. Used to invalidate the diff query when the
 * tree changes underneath an open diff panel.
 */
export function buildWorkingTreeStatusDigest(status: VcsStatusResult | null): string | null {
  if (!status || !status.isRepo) {
    return null;
  }
  const fileParts = status.workingTree.files
    .map((file) =>
      [
        file.path,
        file.indexStatus ?? "",
        file.worktreeStatus ?? "",
        file.insertions,
        file.deletions,
      ].join(":"),
    )
    .toSorted();
  return [status.refName ?? "", ...fileParts].join("\n");
}

/**
 * Index of the file the viewport is "on": the last file whose top edge sits
 * at or above the reading line (scrollTop + offset). Clamps to the first file
 * before any has been reached.
 */
export function resolveActiveDiffFileIndex(
  fileTops: readonly number[],
  scrollTop: number,
  readingOffset = 0,
): number {
  if (fileTops.length === 0) {
    return -1;
  }
  let active = 0;
  for (const [index, top] of fileTops.entries()) {
    if (top <= scrollTop + readingOffset) {
      active = index;
    } else {
      break;
    }
  }
  return active;
}
