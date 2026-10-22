import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProjectSetupId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectScript } from "./orchestration.ts";

/**
 * Setting up a project on another computer (docs/design/fleet.md, Part 8).
 * The app reads what to clone and the ticked ignored files from the source
 * computer, then starts one job on the target computer, which clones, writes
 * the files and adds the project on its own.
 */

/** Per file and in all, after decoding. */
export const PROJECT_SETUP_MAX_FILE_BYTES = 1024 * 1024;
export const PROJECT_SETUP_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const PROJECT_SETUP_MAX_FILES = 500;

export const ProjectSetupProtocol = Schema.Literals(["ssh", "https", "other"]);
export type ProjectSetupProtocol = typeof ProjectSetupProtocol.Type;

/** One git remote, as the source computer has it, with any credentials removed. */
export const ProjectSetupRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  protocol: ProjectSetupProtocol,
});
export type ProjectSetupRemote = typeof ProjectSetupRemote.Type;

/** An ignored file the user can choose to send along. */
export const ProjectSetupFileCandidate = Schema.Struct({
  /** From the repository root, `/`-separated. */
  path: TrimmedNonEmptyString,
  size: NonNegativeInt,
  /** `.env`, `.env.*`, `.envrc`, `.dev.vars`: ticked to start with. */
  suggested: Schema.Boolean,
  /** Over the per-file limit: listed, never sent. */
  tooLarge: Schema.Boolean,
});
export type ProjectSetupFileCandidate = typeof ProjectSetupFileCandidate.Type;

/** What another computer needs to make its own copy of a project. */
export const ProjectSetupSource = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** The project's RepositoryIdentity.canonicalKey. */
  repositoryKey: TrimmedNonEmptyString,
  /** The project's folder from the repository root, `/`-separated; "" at the root. */
  subdirectory: Schema.String,
  remotes: Schema.Array(ProjectSetupRemote),
  /** The remote this computer's identity comes from: cloned as `origin` there. */
  primaryRemoteName: TrimmedNonEmptyString,
  scripts: Schema.Array(ProjectScript),
  /** The repository root from this computer's home folder (`code/app`); null outside it. */
  homeRelativePath: Schema.NullOr(Schema.String),
  /** The repository root's folder name, for a default folder there. */
  folderName: TrimmedNonEmptyString,
  files: Schema.Array(ProjectSetupFileCandidate),
  /** More ignored files than the list holds. */
  filesTruncated: Schema.Boolean,
  /**
   * About how much a clone downloads: this computer's own packed copy of the
   * repository. Git counts its progress in objects, which says little when a
   * few large files make up most of the bytes. Absent from older servers.
   */
  sizeBytes: Schema.optional(NonNegativeInt),
});
export type ProjectSetupSource = typeof ProjectSetupSource.Type;

export const ProjectSetupSourceInput = Schema.Struct({ projectId: ProjectId });
export type ProjectSetupSourceInput = typeof ProjectSetupSourceInput.Type;

/** File mode bits a sent file keeps. */
export const ProjectSetupFileMode = Schema.Literals([0o600, 0o644, 0o755]);
export type ProjectSetupFileMode = typeof ProjectSetupFileMode.Type;

export const ProjectSetupFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  contentBase64: Schema.String,
  mode: ProjectSetupFileMode,
});
export type ProjectSetupFile = typeof ProjectSetupFile.Type;

export const ProjectSetupReadFilesInput = Schema.Struct({
  projectId: ProjectId,
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectSetupReadFilesInput = typeof ProjectSetupReadFilesInput.Type;

export const ProjectSetupReadFilesResult = Schema.Struct({
  files: Schema.Array(ProjectSetupFile),
});
export type ProjectSetupReadFilesResult = typeof ProjectSetupReadFilesResult.Type;

/** The computer and project a setup copies. */
export const ProjectSetupSourceRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  label: TrimmedNonEmptyString,
});
export type ProjectSetupSourceRef = typeof ProjectSetupSourceRef.Type;

export const ProjectSetupStartInput = Schema.Struct({
  /** Made by the app: the same id again is the same job. */
  setupId: ProjectSetupId,
  source: ProjectSetupSourceRef,
  title: TrimmedNonEmptyString,
  repositoryKey: TrimmedNonEmptyString,
  subdirectory: Schema.String,
  remotes: Schema.Array(ProjectSetupRemote),
  primaryRemoteName: TrimmedNonEmptyString,
  /** How to reach the primary remote; its own protocol unless the user switched. */
  protocol: ProjectSetupProtocol,
  scripts: Schema.Array(ProjectScript),
  /** A folder on the target computer; `~` is its own home. */
  destinationPath: TrimmedNonEmptyString,
  files: Schema.Array(ProjectSetupFile),
  /** The source's `sizeBytes`: the download's progress is measured against it. */
  expectedBytes: Schema.optional(NonNegativeInt),
});
export type ProjectSetupStartInput = typeof ProjectSetupStartInput.Type;

/**
 * What a folder on the target computer would mean for a setup:
 * `same-repository` is a copy of this project's repository, added as it is.
 */
export const ProjectSetupDestinationState = Schema.Literals([
  "missing",
  "empty",
  "same-repository",
  "other-repository",
  "not-empty",
  "not-a-folder",
]);
export type ProjectSetupDestinationState = typeof ProjectSetupDestinationState.Type;

export const ProjectSetupInspectDestinationInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  repositoryKey: TrimmedNonEmptyString,
  remotes: Schema.Array(ProjectSetupRemote),
});
export type ProjectSetupInspectDestinationInput = typeof ProjectSetupInspectDestinationInput.Type;

export const ProjectSetupDestination = Schema.Struct({
  /** The folder as this computer spells it (`~` expanded). */
  resolvedPath: TrimmedNonEmptyString,
  state: ProjectSetupDestinationState,
});
export type ProjectSetupDestination = typeof ProjectSetupDestination.Type;

/**
 * Where a setup stands. `publishing`: the finished copy moves into its
 * folder; from there on nothing is deleted. `done` may carry warnings
 * (a file it couldn't write, submodules that failed).
 */
export const ProjectSetupStage = Schema.Literals([
  "cloning",
  "submodules",
  "copying",
  "publishing",
  "adding",
  "done",
  "failed",
  "cancelled",
]);
export type ProjectSetupStage = typeof ProjectSetupStage.Type;

export const ProjectSetupProgress = Schema.Struct({
  /** Git's own words for the step ("Receiving objects"); null before it says any. */
  phase: Schema.NullOr(Schema.String),
  percent: Schema.NullOr(NonNegativeInt),
  /** The rest of git's line ("168.80 MiB | 20.69 MiB/s"). */
  detail: Schema.NullOr(Schema.String),
  /** Nothing heard from git for a while. */
  stalled: Schema.Boolean,
});
export type ProjectSetupProgress = typeof ProjectSetupProgress.Type;

export const ProjectSetupJob = Schema.Struct({
  setupId: ProjectSetupId,
  source: ProjectSetupSourceRef,
  title: TrimmedNonEmptyString,
  repositoryKey: TrimmedNonEmptyString,
  subdirectory: Schema.String,
  protocol: ProjectSetupProtocol,
  destinationPath: TrimmedNonEmptyString,
  /** The ticked files' paths, so Retry can read them again. */
  filePaths: Schema.Array(TrimmedNonEmptyString),
  stage: ProjectSetupStage,
  progress: ProjectSetupProgress,
  /** The project it became here, once added. */
  projectId: Schema.NullOr(ProjectId),
  error: Schema.NullOr(Schema.String),
  /** What didn't go to plan in a job that still finished, one plain sentence each. */
  warnings: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectSetupJob = typeof ProjectSetupJob.Type;

export const ProjectSetupsSnapshot = Schema.Struct({
  jobs: Schema.Array(ProjectSetupJob),
});
export type ProjectSetupsSnapshot = typeof ProjectSetupsSnapshot.Type;

export const ProjectSetupJobInput = Schema.Struct({ setupId: ProjectSetupId });
export type ProjectSetupJobInput = typeof ProjectSetupJobInput.Type;

export class ProjectSetupError extends Schema.TaggedError<ProjectSetupError>()(
  "ProjectSetupError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
