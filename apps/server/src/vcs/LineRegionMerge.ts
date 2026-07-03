/**
 * LineRegionMerge - Exact coordinate-based merge of two edits from a common base.
 *
 * Selective revert knows three states of a file precisely: the thread's last
 * snapshot (base), the revert target, and the current worktree content. Both
 * `base -> target` (the thread's inverse change) and `base -> current` (other
 * actors' drift) are expressed as line regions anchored at base coordinates,
 * so the inverse change can be applied onto the current content by exact
 * position arithmetic — no fuzzy context matching.
 *
 * This deliberately differs from `git apply`/`git merge-file`, which treat
 * adjacent regions as conflicts (e.g. two sessions appending consecutive
 * blocks at the end of a file). Regions here only conflict when they truly
 * overlap on base lines; everything applied is additionally verified verbatim
 * against the current content before any result is produced.
 *
 * @module LineRegionMerge
 */

/** Replaces base lines [baseStart, baseStart + baseLines.length) with newLines. */
export interface LineEditRegion {
  /**
   * 1-indexed first base line consumed by the region. For pure insertions
   * (baseLines empty) this is the base line the new lines are inserted before.
   */
  readonly baseStart: number;
  readonly baseLines: ReadonlyArray<string>;
  readonly newLines: ReadonlyArray<string>;
}

/**
 * Parses a single-file unified diff into base-anchored edit regions.
 *
 * Returns null for anything that cannot be interpreted exactly: binary
 * stubs, missing-newline markers, or malformed hunks. Callers treat null as
 * "do not attempt the merge".
 */
export function parseUnifiedDiffRegions(patch: string): LineEditRegion[] | null {
  const regions: LineEditRegion[] = [];
  const lines = patch.split("\n");

  let inHunk = false;
  let baseCursor = 0;
  let openRegion: { baseStart: number; baseLines: string[]; newLines: string[] } | null = null;

  const closeRegion = (): void => {
    if (openRegion !== null) {
      regions.push(openRegion);
      openRegion = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!header) {
        return null;
      }
      closeRegion();
      const baseStart = Number(header[1]);
      const baseCount = header[2] === undefined ? 1 : Number(header[2]);
      // A zero-length base side means the hunk inserts after base line
      // `baseStart`, so the cursor points at the following line.
      baseCursor = baseCount === 0 ? baseStart + 1 : baseStart;
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        return null;
      }
      continue;
    }

    if (line.length === 0 && index === lines.length - 1) {
      // Trailing newline of the patch itself.
      continue;
    }

    const marker = line[0];
    if (marker === "\\") {
      // "\ No newline at end of file" — exact merging across missing-newline
      // boundaries is not supported; fail safe.
      return null;
    }
    if (marker === " ") {
      closeRegion();
      baseCursor += 1;
      continue;
    }
    if (marker === "-") {
      openRegion ??= { baseStart: baseCursor, baseLines: [], newLines: [] };
      openRegion.baseLines.push(line.slice(1));
      baseCursor += 1;
      continue;
    }
    if (marker === "+") {
      openRegion ??= { baseStart: baseCursor, baseLines: [], newLines: [] };
      openRegion.newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("diff --git")) {
      // Only single-file patches are supported.
      return null;
    }
    return null;
  }

  closeRegion();
  return regions;
}

function regionsOverlap(left: LineEditRegion, right: LineEditRegion): boolean {
  const leftStart = left.baseStart;
  const leftCount = left.baseLines.length;
  const rightStart = right.baseStart;
  const rightCount = right.baseLines.length;

  if (leftCount === 0 && rightCount === 0) {
    // Two insertions at the same base point have no deterministic order.
    return leftStart === rightStart;
  }
  return leftStart < rightStart + rightCount && rightStart < leftStart + leftCount;
}

export interface MergeRegionEditsInput {
  /** The change to apply, expressed against the base (e.g. base -> target). */
  readonly editRegions: ReadonlyArray<LineEditRegion>;
  /** How the current content drifted from the base (base -> current). */
  readonly driftRegions: ReadonlyArray<LineEditRegion>;
  /** Current content lines (without a trailing empty element). */
  readonly currentLines: ReadonlyArray<string>;
}

/**
 * Applies `editRegions` onto the current content by mapping base coordinates
 * through `driftRegions`. Returns the merged lines, or null when any edit
 * region overlaps a drift region or the current content does not match the
 * expected base lines at the mapped position.
 */
export function mergeRegionEditsIntoCurrent(input: MergeRegionEditsInput): string[] | null {
  for (const edit of input.editRegions) {
    for (const drift of input.driftRegions) {
      if (regionsOverlap(edit, drift)) {
        return null;
      }
    }
  }

  const sortedEdits = input.editRegions.toSorted((left, right) => left.baseStart - right.baseStart);

  const result: string[] = [];
  let currentCursor = 0;
  for (const edit of sortedEdits) {
    // Offset by every drift region that sits fully before this edit in base
    // coordinates; disjointness guarantees each drift is fully before or
    // fully after.
    let offset = 0;
    for (const drift of input.driftRegions) {
      if (drift.baseStart + drift.baseLines.length <= edit.baseStart) {
        offset += drift.newLines.length - drift.baseLines.length;
      }
    }

    const currentStart = edit.baseStart - 1 + offset;
    if (currentStart < currentCursor || currentStart > input.currentLines.length) {
      return null;
    }
    // The lines being replaced must still be exactly the base lines.
    for (let index = 0; index < edit.baseLines.length; index += 1) {
      if (input.currentLines[currentStart + index] !== edit.baseLines[index]) {
        return null;
      }
    }

    result.push(...input.currentLines.slice(currentCursor, currentStart));
    result.push(...edit.newLines);
    currentCursor = currentStart + edit.baseLines.length;
  }
  result.push(...input.currentLines.slice(currentCursor));

  return result;
}
