/**
 * SelectiveRevert - Pure planning logic for shared-checkout checkpoint revert.
 *
 * A thread revert in a shared checkout must only touch bytes that can be
 * attributed to that thread. This module classifies the paths that changed
 * between two of the thread's snapshots against per-turn attribution data and
 * the current worktree state, producing a plan of provably-safe restores.
 *
 * Invariant: a path is only planned for restore when its current content
 * exactly matches the thread's last captured state for that path, it is
 * attributed to the thread's reverted turn range, and it was not also changed
 * outside the thread's turn windows.
 *
 * @module SelectiveRevert
 */
import type { CheckpointEntry, WorktreePathState } from "./Services/CheckpointStore.ts";

/**
 * Normalizes a checkpoint file path for attribution comparisons across
 * provider-reported and git-derived sources (separator and case differences).
 */
export function normalizeCheckpointFilePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

export interface SelectiveRevertPlan {
  /** Safe to restore from the target snapshot (path exists there). */
  readonly restorePaths: ReadonlyArray<string>;
  /** Safe to delete (path does not exist in the target snapshot). */
  readonly deletePaths: ReadonlyArray<string>;
  /** Already at the target state; nothing to do. */
  readonly noopPaths: ReadonlyArray<string>;
  /**
   * Attributed files changed by another actor after the thread's last
   * checkpoint. Candidates for a hunk-level inverse patch: revertible when
   * the thread's hunks do not overlap the later edits, conflicts otherwise.
   */
  readonly hunkCandidatePaths: ReadonlyArray<string>;
  /** Attributed to the thread but changed by another actor; left untouched. */
  readonly conflictPaths: ReadonlyArray<string>;
  /** Changed between the snapshots but not attributed to the thread; left untouched. */
  readonly unattributedPaths: ReadonlyArray<string>;
}

export interface BuildSelectiveRevertPlanInput {
  /**
   * Path transitions diffed from the revert target snapshot ("from") to the
   * thread's latest snapshot ("to").
   */
  readonly entries: ReadonlyArray<CheckpointEntry>;
  /** Normalized paths attributed to the thread within the reverted turn range. */
  readonly attributedPaths: ReadonlySet<string>;
  /**
   * Normalized paths that also changed outside the thread's turn windows
   * (between-turn edits by other sessions, the user, or external tools).
   */
  readonly contestedPaths: ReadonlySet<string>;
  /** Current worktree state for attributed candidate paths, keyed by entry path. */
  readonly worktreeStates: ReadonlyMap<string, WorktreePathState>;
}

export function buildSelectiveRevertPlan(
  input: BuildSelectiveRevertPlanInput,
): SelectiveRevertPlan {
  const restorePaths: string[] = [];
  const deletePaths: string[] = [];
  const noopPaths: string[] = [];
  const hunkCandidatePaths: string[] = [];
  const conflictPaths: string[] = [];
  const unattributedPaths: string[] = [];

  for (const entry of input.entries) {
    const normalizedPath = normalizeCheckpointFilePath(entry.path);
    if (!input.attributedPaths.has(normalizedPath)) {
      unattributedPaths.push(entry.path);
      continue;
    }

    const worktreeState = input.worktreeStates.get(entry.path);
    if (entry.hasUnsupportedMode || worktreeState === undefined || worktreeState.kind === "other") {
      conflictPaths.push(entry.path);
      continue;
    }

    // entry.fromOid is the target state to restore to; entry.toOid is the
    // thread's last captured state for the path.
    const currentOid = worktreeState.kind === "file" ? worktreeState.oid : null;
    if (currentOid === entry.fromOid) {
      noopPaths.push(entry.path);
      continue;
    }
    if (input.contestedPaths.has(normalizedPath)) {
      // Interleaved edits inside the snapshot range cannot be separated at
      // the hunk level either: the thread's snapshot diff already contains
      // the other actor's bytes.
      conflictPaths.push(entry.path);
      continue;
    }
    if (currentOid !== entry.toOid) {
      // Another actor changed the path after the thread's last checkpoint.
      // A regular file may still be revertible hunk-by-hunk; anything else
      // (deleted or replaced by a non-file) is a conflict outright.
      if (worktreeState.kind === "file") {
        hunkCandidatePaths.push(entry.path);
      } else {
        conflictPaths.push(entry.path);
      }
      continue;
    }

    if (entry.fromOid === null) {
      deletePaths.push(entry.path);
    } else {
      restorePaths.push(entry.path);
    }
  }

  return {
    restorePaths,
    deletePaths,
    noopPaths,
    hunkCandidatePaths,
    conflictPaths,
    unattributedPaths,
  };
}

/**
 * Collects the normalized set of file paths attributed to a thread's turns in
 * the half-open turn-count range (afterTurnCount, throughTurnCount].
 */
export function attributedPathsForTurnRange(input: {
  readonly checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
    readonly files: ReadonlyArray<{ readonly path: string }>;
  }>;
  readonly afterTurnCount: number;
  readonly throughTurnCount: number;
}): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const checkpoint of input.checkpoints) {
    if (
      checkpoint.checkpointTurnCount <= input.afterTurnCount ||
      checkpoint.checkpointTurnCount > input.throughTurnCount
    ) {
      continue;
    }
    for (const file of checkpoint.files) {
      paths.add(normalizeCheckpointFilePath(file.path));
    }
  }
  return paths;
}
