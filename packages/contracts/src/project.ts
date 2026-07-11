import * as Effect from "effect/Effect";
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
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  /**
   * Optimistic-concurrency guard: sha256 (hex) of the content the writer
   * last read. When set and the file's current on-disk hash differs, the
   * write is refused with a `conflict` result instead of clobbering changes
   * made by another writer (typically an agent editing the same tree).
   * Omit to write unconditionally.
   */
  expectedContentHash: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectFileWritten = Schema.Struct({
  // Both fields tolerate absence so responses from servers that predate the
  // written/conflict union (hosted-app version skew) still decode: a bare
  // `{relativePath}` reads as an unguarded successful write.
  kind: Schema.Literal("written").pipe(Schema.withDecodingDefault(Effect.succeed("written"))),
  relativePath: TrimmedNonEmptyString,
  /**
   * sha256 (hex) of the bytes just written — the writer's next baseline.
   * Empty on responses from servers that predate the field.
   */
  contentHash: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ProjectFileWritten = typeof ProjectFileWritten.Type;

/**
 * The file changed on disk since the writer's baseline. Modeled as a result
 * rather than an error because concurrent edits are an expected state; the
 * current disk text is included so clients can offer "reload" inline
 * without a follow-up read.
 */
export const ProjectWriteFileConflict = Schema.Struct({
  kind: Schema.Literal("conflict"),
  relativePath: TrimmedNonEmptyString,
  content: Schema.String,
  contentHash: TrimmedNonEmptyString,
  size: NonNegativeInt,
});
export type ProjectWriteFileConflict = typeof ProjectWriteFileConflict.Type;

export const ProjectWriteFileResult = Schema.Union([ProjectFileWritten, ProjectWriteFileConflict]);
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
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
    cause: Schema.optional(Schema.Defect()),
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
  /**
   * sha256 (hex) of the served content bytes. Editors send it back as
   * `expectedContentHash` so stale buffers cannot clobber newer writes.
   * Empty when the response came from a server that predates the field
   * (hosted-app version skew) — writers then skip the conflict guard.
   */
  contentHash: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
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
    cause: Schema.optional(Schema.Defect()),
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
    cause: Schema.optional(Schema.Defect()),
  },
) {}
