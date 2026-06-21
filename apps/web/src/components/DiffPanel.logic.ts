import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { VcsStatusResult } from "@threadlines/contracts";

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

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Re-emits a unified diff with zero context: every run of consecutive +/-
 * lines becomes its own hunk with recomputed ranges, and context lines are
 * dropped. Line numbers are preserved, so the result renders a "changes only"
 * view of the same patch. Non-hunk content (file headers, binary notices)
 * passes through untouched.
 */
export function stripPatchContextLines(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let run: string[] = [];
  let runOldStart = 0;
  let runNewStart = 0;
  let runOldCount = 0;
  let runNewCount = 0;

  const flushRun = () => {
    if (run.length === 0) {
      return;
    }
    // Git's convention for empty ranges: the position is the line *before*
    // the change, e.g. `@@ -10,0 +11,3 @@` for a pure insertion.
    const oldStart = runOldCount === 0 ? runOldStart - 1 : runOldStart;
    const newStart = runNewCount === 0 ? runNewStart - 1 : runNewStart;
    out.push(`@@ -${oldStart},${runOldCount} +${newStart},${runNewCount} @@`);
    out.push(...run);
    run = [];
    runOldCount = 0;
    runNewCount = 0;
  };

  for (const line of lines) {
    const hunkHeader = HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeader) {
      flushRun();
      inHunk = true;
      oldLine = Number.parseInt(hunkHeader[1] ?? "0", 10);
      newLine = Number.parseInt(hunkHeader[3] ?? "0", 10);
      continue;
    }
    if (!inHunk) {
      out.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      if (run.length === 0) {
        runOldStart = oldLine;
        runNewStart = newLine;
      }
      run.push(line);
      newLine += 1;
      runNewCount += 1;
    } else if (line.startsWith("-")) {
      if (run.length === 0) {
        runOldStart = oldLine;
        runNewStart = newLine;
      }
      run.push(line);
      oldLine += 1;
      runOldCount += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the preceding line; keep it
      // only when that line is part of the current run.
      if (run.length > 0) {
        run.push(line);
      }
    } else if (line === "" || line.startsWith(" ")) {
      flushRun();
      oldLine += 1;
      newLine += 1;
    } else {
      // Start of the next file's headers (or trailing content).
      flushRun();
      inHunk = false;
      out.push(line);
    }
  }
  flushRun();
  return out.join("\n");
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
