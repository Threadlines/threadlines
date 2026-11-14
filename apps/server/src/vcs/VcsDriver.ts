import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@threadlines/contracts";
import { CheckpointRef } from "@threadlines/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /**
   * Other refs for the same snapshot, written with `checkpointRef`: a single
   * capture when two points in the timeline are the same moment.
   */
  readonly alsoCheckpointRefs?: ReadonlyArray<CheckpointRef>;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  /** Repository-root-relative paths to include. Undefined includes every path. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsResolveCheckpointCommitInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface VcsDiffCheckpointEntriesInput {
  readonly cwd: string;
  /** Resolved commit oid for the "from" side (e.g. the revert target snapshot). */
  readonly fromCommit: string;
  /** Resolved commit oid for the "to" side (e.g. the thread's latest snapshot). */
  readonly toCommit: string;
}

export interface VcsCheckpointEntry {
  /** Repository-root-relative path. */
  readonly path: string;
  /** Blob oid on the "from" side, or null when the path does not exist there. */
  readonly fromOid: string | null;
  /** Blob oid on the "to" side, or null when the path does not exist there. */
  readonly toOid: string | null;
  /** True when either side is not a regular file blob (symlink, submodule, ...). */
  readonly hasUnsupportedMode: boolean;
}

export interface VcsHashWorktreePathsInput {
  readonly cwd: string;
  /** Repository-root-relative paths. */
  readonly paths: ReadonlyArray<string>;
}

export type VcsWorktreePathKind = "file" | "missing" | "other";

export interface VcsWorktreePathState {
  readonly path: string;
  readonly kind: VcsWorktreePathKind;
  /** Blob oid of the current worktree content; null unless kind is "file". */
  readonly oid: string | null;
}

export interface VcsRestoreCheckpointPathsInput {
  readonly cwd: string;
  /** Resolved commit oid of the snapshot to restore path contents from. */
  readonly checkpointCommit: string;
  /** Repository-root-relative paths that exist in the snapshot. */
  readonly restorePaths: ReadonlyArray<string>;
  /** Repository-root-relative paths absent from the snapshot (deleted on restore). */
  readonly deletePaths: ReadonlyArray<string>;
}

/** One snapshot transition to undo: the file's change from fromCommit to toCommit. */
export interface VcsCheckpointFileEditStep {
  /** Resolved commit oid of the later snapshot (e.g. a turn's post-state). */
  readonly fromCommit: string;
  /** Resolved commit oid of the earlier snapshot (e.g. that turn's pre-state). */
  readonly toCommit: string;
}

export interface VcsRestoreCheckpointFileEditsInput {
  readonly cwd: string;
  /** Repository-root-relative path to patch. */
  readonly path: string;
  /**
   * Transitions to undo in order (newest first for turn-by-turn rollback).
   * All steps are composed in memory and written atomically, or not at all.
   */
  readonly steps: ReadonlyArray<VcsCheckpointFileEditStep>;
  /** When true, verify the merge without writing anything to the worktree. */
  readonly dryRun?: boolean;
}

export interface VcsCheckpointRangeInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface VcsCheckpointRefInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface VcsCheckpointCheckoutsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/**
 * Where a snapshot was taken, seen from the checkout that asks: this one,
 * another checkout of the repository, or not recorded (a snapshot from before
 * snapshots recorded it, or a ref that is gone).
 */
export type VcsCheckpointCheckout = "here" | "elsewhere" | "unknown";

/** Line counts for one repository-root-relative path. */
export interface VcsCheckpointFileStat {
  readonly path: string;
  /** The path's name before a rename, when git detected one. */
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface VcsReadRevisionFileInput {
  readonly cwd: string;
  /** A checkpoint ref, or `HEAD` for the last commit. */
  readonly revision: CheckpointRef | "HEAD";
  /** Repository-root-relative path. */
  readonly path: string;
  /** A larger file comes back as `too-large`, without its bytes. */
  readonly maxBytes: number;
}

/** A file's bytes as one revision holds them. */
export type VcsRevisionFile =
  | { readonly kind: "file"; readonly base64: string; readonly size: number }
  | { readonly kind: "too-large"; readonly size: number }
  /** The revision has no file at that path (or no such revision). */
  | { readonly kind: "missing" };

export interface VcsCheckpointOps {
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<void, VcsError>;
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly resolveCheckpointCommit: (
    input: VcsResolveCheckpointCommitInput,
  ) => Effect.Effect<string | null, VcsError>;
  /** One answer per ref, in order: see VcsCheckpointCheckout. */
  readonly checkpointCheckouts: (
    input: VcsCheckpointCheckoutsInput,
  ) => Effect.Effect<ReadonlyArray<VcsCheckpointCheckout>, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly listHeadMovementPaths: (
    input: VcsCheckpointRangeInput,
  ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly diffCheckpointAgainstHead: (
    input: VcsCheckpointRefInput,
  ) => Effect.Effect<ReadonlyArray<VcsCheckpointFileStat> | null, VcsError>;
  readonly diffCheckpointEntries: (
    input: VcsDiffCheckpointEntriesInput,
  ) => Effect.Effect<ReadonlyArray<VcsCheckpointEntry>, VcsError>;
  readonly hashWorktreePaths: (
    input: VcsHashWorktreePathsInput,
  ) => Effect.Effect<ReadonlyArray<VcsWorktreePathState>, VcsError>;
  readonly restoreCheckpointPaths: (
    input: VcsRestoreCheckpointPathsInput,
  ) => Effect.Effect<void, VcsError>;
  readonly restoreCheckpointFileEdits: (
    input: VcsRestoreCheckpointFileEditsInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
  /** One file's bytes at a snapshot or HEAD, for showing an earlier picture. */
  readonly readRevisionFile: (
    input: VcsReadRevisionFileInput,
  ) => Effect.Effect<VcsRevisionFile, VcsError>;
}

export interface VcsDriverShape {
  readonly capabilities: VcsDriverCapabilities;
  readonly execute: (
    input: Omit<VcsProcess.VcsProcessInput, "command">,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
  readonly checkpoints?: VcsCheckpointOps;
  readonly detectRepository: (cwd: string) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
  readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
  readonly listWorkspaceFiles: (
    cwd: string,
  ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
  readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
  readonly filterIgnoredPaths: (
    cwd: string,
    relativePaths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<VcsDriver, VcsDriverShape>()(
  "threadlines/vcs/VcsDriver",
) {}
