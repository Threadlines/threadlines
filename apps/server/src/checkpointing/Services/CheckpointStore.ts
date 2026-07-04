/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef } from "@threadlines/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface ResolveCheckpointCommitInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointEntriesInput {
  readonly cwd: string;
  /** Resolved commit oid for the "from" side (e.g. the revert target snapshot). */
  readonly fromCommit: string;
  /** Resolved commit oid for the "to" side (e.g. the thread's latest snapshot). */
  readonly toCommit: string;
}

export interface CheckpointEntry {
  /** Repository-root-relative path. */
  readonly path: string;
  /** Blob oid on the "from" side, or null when the path does not exist there. */
  readonly fromOid: string | null;
  /** Blob oid on the "to" side, or null when the path does not exist there. */
  readonly toOid: string | null;
  /** True when either side is not a regular file blob (symlink, submodule, ...). */
  readonly hasUnsupportedMode: boolean;
}

export interface HashWorktreePathsInput {
  readonly cwd: string;
  /** Repository-root-relative paths. */
  readonly paths: ReadonlyArray<string>;
}

export type WorktreePathKind = "file" | "missing" | "other";

export interface WorktreePathState {
  readonly path: string;
  readonly kind: WorktreePathKind;
  /** Blob oid of the current worktree content; null unless kind is "file". */
  readonly oid: string | null;
}

export interface RestoreCheckpointPathsInput {
  readonly cwd: string;
  /** Resolved commit oid of the snapshot to restore path contents from. */
  readonly checkpointCommit: string;
  /** Repository-root-relative paths that exist in the snapshot. */
  readonly restorePaths: ReadonlyArray<string>;
  /** Repository-root-relative paths absent from the snapshot (deleted on restore). */
  readonly deletePaths: ReadonlyArray<string>;
}

/** One snapshot transition to undo: the file's change from fromCommit to toCommit. */
export interface CheckpointFileEditStep {
  /** Resolved commit oid of the later snapshot (e.g. a turn's post-state). */
  readonly fromCommit: string;
  /** Resolved commit oid of the earlier snapshot (e.g. that turn's pre-state). */
  readonly toCommit: string;
}

export interface RestoreCheckpointFileEditsInput {
  readonly cwd: string;
  /** Repository-root-relative path to patch. */
  readonly path: string;
  /**
   * Transitions to undo in order (newest first for turn-by-turn rollback).
   * All steps are composed in memory and written atomically, or not at all.
   */
  readonly steps: ReadonlyArray<CheckpointFileEditStep>;
  /** When true, verify the merge without writing anything to the worktree. */
  readonly dryRun?: boolean;
}

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   *
   * Uses an isolated temporary Git index and writes a hidden ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Resolve a checkpoint ref to its commit oid.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   * Returns null when neither resolves.
   */
  readonly resolveCheckpointCommit: (
    input: ResolveCheckpointCommitInput,
  ) => Effect.Effect<string | null, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint refs.
   *
   * Can optionally treat missing "from" ref as `HEAD`.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * List per-path blob transitions between two checkpoint commits.
   */
  readonly diffCheckpointEntries: (
    input: DiffCheckpointEntriesInput,
  ) => Effect.Effect<ReadonlyArray<CheckpointEntry>, CheckpointStoreError>;

  /**
   * Report the current worktree state (kind and blob oid) for the given paths.
   */
  readonly hashWorktreePaths: (
    input: HashWorktreePathsInput,
  ) => Effect.Effect<ReadonlyArray<WorktreePathState>, CheckpointStoreError>;

  /**
   * Restore only the given paths to a checkpoint's state, leaving all other
   * workspace files untouched. Used by shared-checkout selective revert.
   */
  readonly restoreCheckpointPaths: (
    input: RestoreCheckpointPathsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Undo one or more of a file's snapshot transitions on the current worktree
   * file, preserving non-overlapping edits by other actors. Multi-step inputs
   * roll a thread's turns back one at a time so edits made between the turns
   * survive.
   *
   * Returns false (leaving the file untouched) when any step does not merge
   * cleanly.
   */
  readonly restoreCheckpointFileEdits: (
    input: RestoreCheckpointFileEditsInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Best-effort delete: missing refs are tolerated.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreShape>()(
  "threadlines/checkpointing/Services/CheckpointStore",
) {}
