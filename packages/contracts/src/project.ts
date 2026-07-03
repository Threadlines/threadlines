import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectTextFileContent = Schema.Struct({
  kind: Schema.Literal("text"),
  relativePath: TrimmedNonEmptyString,
  content: Schema.String,
  /** Total file size in bytes; `content` may cover only a truncated prefix. */
  size: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectTextFileContent = typeof ProjectTextFileContent.Type;

export const ProjectImageFileContent = Schema.Struct({
  kind: Schema.Literal("image"),
  relativePath: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  base64: Schema.String,
  size: NonNegativeInt,
});
export type ProjectImageFileContent = typeof ProjectImageFileContent.Type;

export const ProjectBinaryFileContent = Schema.Struct({
  kind: Schema.Literal("binary"),
  relativePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
});
export type ProjectBinaryFileContent = typeof ProjectBinaryFileContent.Type;

/**
 * The path has no filesystem entry. Modeled as a result rather than an error
 * because dangling references are an expected state (agents delete or rename
 * files while chat references keep pointing at the old path), and the error
 * channel reads as an IO fault clients retry.
 */
export const ProjectMissingFileContent = Schema.Struct({
  kind: Schema.Literal("missing"),
  relativePath: TrimmedNonEmptyString,
});
export type ProjectMissingFileContent = typeof ProjectMissingFileContent.Type;

export const ProjectReadFileResult = Schema.Union([
  ProjectTextFileContent,
  ProjectImageFileContent,
  ProjectBinaryFileContent,
  ProjectMissingFileContent,
]);
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * Reads the project's resolved favicon over the WebSocket RPC channel.
 * Relay-paired clients (phonelink) cannot reach the `/api/project-favicon`
 * HTTP route — the relay only carries the WebSocket — so this is their
 * favicon transport. `favicon` is null when the project has no icon; the
 * client renders its own fallback.
 */
export const ProjectFaviconInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectFaviconInput = typeof ProjectFaviconInput.Type;

export const ProjectFaviconResult = Schema.Struct({
  favicon: Schema.NullOr(
    Schema.Struct({
      mimeType: TrimmedNonEmptyString,
      base64: Schema.String,
    }),
  ),
});
export type ProjectFaviconResult = typeof ProjectFaviconResult.Type;

export class ProjectFaviconError extends Schema.TaggedErrorClass<ProjectFaviconError>()(
  "ProjectFaviconError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
