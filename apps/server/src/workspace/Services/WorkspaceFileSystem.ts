/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRestoreOriginalInput,
  ProjectRestoreOriginalResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@threadlines/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedError<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Write a file relative to the workspace root, or an existing file outside
   * it named by an absolute path.
   *
   * Saves take turns. Inside the project, parent directories are created as
   * needed. Outside it, the file must already exist, the save must carry the
   * hash it was edited from, and the bytes it replaces are kept first so
   * `restoreOriginal` can put them back. Either way a save never replaces a
   * file the editor could not have held whole as UTF-8 text.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Put back the original kept before the first save over a file outside the
   * project, if the file is still the version the caller last saw.
   */
  readonly restoreOriginal: (
    input: ProjectRestoreOriginalInput,
  ) => Effect.Effect<
    ProjectRestoreOriginalResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Read a file relative to the workspace root, or outside it by an absolute
   * path. A client authenticated to this server already drives agents and
   * terminals with this computer's user, so reading outside the project
   * grants nothing it lacked.
   *
   * Rejects directories, detects binary content, serves pictures and (when
   * asked) PDFs as base64, says why a text file can't be edited here, and
   * truncates oversized text files instead of reading them unbounded.
   */
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("threadlines/workspace/Services/WorkspaceFileSystem") {}
