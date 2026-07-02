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

export interface VcsRestoreCheckpointFileHunksInput {
  readonly cwd: string;
  /** Resolved commit oid of the thread's latest snapshot (patch "from" side). */
  readonly fromCommit: string;
  /** Resolved commit oid of the revert target snapshot (patch "to" side). */
  readonly toCommit: string;
  /** Repository-root-relative path to patch. */
  readonly path: string;
}

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
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly diffCheckpointEntries: (
    input: VcsDiffCheckpointEntriesInput,
  ) => Effect.Effect<ReadonlyArray<VcsCheckpointEntry>, VcsError>;
  readonly hashWorktreePaths: (
    input: VcsHashWorktreePathsInput,
  ) => Effect.Effect<ReadonlyArray<VcsWorktreePathState>, VcsError>;
  readonly restoreCheckpointPaths: (
    input: VcsRestoreCheckpointPathsInput,
  ) => Effect.Effect<void, VcsError>;
  readonly restoreCheckpointFileHunks: (
    input: VcsRestoreCheckpointFileHunksInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
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
