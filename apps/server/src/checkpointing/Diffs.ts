import { parsePatchFiles } from "@pierre/diffs";

import { normalizeCheckpointFilePath } from "./SelectiveRevert.ts";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const files = parsedPatches.flatMap((patch) =>
    patch.files.map((file) => ({
      path: file.name,
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    })),
  );

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/** One path's uncommitted line counts; `previousPath` is set for a rename. */
export interface UncommittedFileSummary extends TurnDiffFileSummary {
  readonly previousPath?: string | undefined;
}

/**
 * Estimates how much of a checkout's uncommitted change belongs to one thread:
 * per path, the smaller of what the thread's counted turns changed there and
 * what is uncommitted there now, additions and deletions each. A renamed path
 * also draws on what the thread changed under its old name, and each path's
 * share is spent once, so two uncommitted paths that fold to the same name
 * cannot both claim it.
 *
 * Work that was merged in, committed, or discarded drops out because nothing
 * is uncommitted there; lines rewritten across turns count once because the
 * net change is no larger than the turn sum; another thread's edits to a
 * shared path count only up to this thread's own change to it. It stays an
 * estimate: line counts carry no line identity, so a path where someone else
 * replaced this thread's lines still counts this thread's amount, and turn
 * summaries keep only a rename's new name, so a file renamed again in a later
 * turn loses the share it earned under the middle name.
 */
export function estimateThreadUncommittedDiffStat(input: {
  readonly turnFiles: ReadonlyArray<ReadonlyArray<TurnDiffFileSummary>>;
  readonly uncommittedFiles: ReadonlyArray<UncommittedFileSummary>;
}): { readonly additions: number; readonly deletions: number } {
  const threadByPath = new Map<string, { additions: number; deletions: number }>();
  for (const files of input.turnFiles) {
    for (const file of files) {
      const key = normalizeCheckpointFilePath(file.path);
      const total = threadByPath.get(key) ?? { additions: 0, deletions: 0 };
      total.additions += file.additions;
      total.deletions += file.deletions;
      threadByPath.set(key, total);
    }
  }

  let additions = 0;
  let deletions = 0;
  for (const file of input.uncommittedFiles) {
    const keys = new Set(
      [file.path, file.previousPath]
        .filter((path) => path !== undefined)
        .map(normalizeCheckpointFilePath),
    );
    const shares = [...keys].flatMap((key) => {
      const share = threadByPath.get(key);
      return share ? [share] : [];
    });
    additions += spendShares(shares, "additions", file.additions);
    deletions += spendShares(shares, "deletions", file.deletions);
  }
  return { additions, deletions };
}

// Takes up to `wanted` lines from the shares in order and returns how many.
function spendShares(
  shares: ReadonlyArray<{ additions: number; deletions: number }>,
  side: "additions" | "deletions",
  wanted: number,
): number {
  let spent = 0;
  for (const share of shares) {
    const taken = Math.min(share[side], wanted - spent);
    share[side] -= taken;
    spent += taken;
  }
  return spent;
}
