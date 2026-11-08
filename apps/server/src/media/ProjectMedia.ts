/**
 * ProjectMedia - what the Media tab lists, and the uncommitted side of a
 * picture's Before/After in the Diff tab.
 *
 * The listing reads the turn summaries the projection already keeps
 * (`projection_turns.checkpoint_files_json`): no table of its own, so nothing
 * to backfill or keep in step. Summaries name files repository-root-relative,
 * while the client reads files inside the thread's folder, so every entry is
 * translated here and files outside the folder (or gone from disk) are left
 * out. Timed on a real history (527 threads, ~4,800 turns): ~150 ms cold.
 *
 * With `includeChat` it also lists what was shared in chat (chatMediaListing),
 * and it starts the one background pass that indexes older chats for that.
 *
 * @module ProjectMedia
 */
import {
  type OrchestrationListProjectMediaInput,
  type OrchestrationListProjectMediaResult,
  OrchestrationProjectMediaEntry,
  type OrchestrationReadChatMediaInput,
  type OrchestrationReadChatMediaResult,
  type ProjectRevisionFileResult,
  type VcsReadRepositoryFileInput,
} from "@threadlines/contracts";
import { ALL_MEDIA_EXTENSIONS } from "@threadlines/shared/media";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import {
  foldProjectMediaRows,
  pathInsideFolder,
  type ProjectMediaTurnFileRow,
} from "./projectMediaFold.ts";
import { fileVersionOf } from "../workspace/fileVersion.ts";
import { readRevisionFileResult } from "./revisionFile.ts";
import { makeChatMediaListing } from "./chatMediaListing.ts";
import { runThreadMediaBackfill } from "./ThreadMediaBackfill.ts";

/** Entries past this many (oldest first) are left off and `truncated` set. */
export const PROJECT_MEDIA_MAX_ENTRIES = 2_000;

export class ProjectMediaError extends Schema.TaggedError<ProjectMediaError>()(
  "ProjectMediaError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectMediaShape {
  readonly listProjectMedia: (
    input: OrchestrationListProjectMediaInput,
  ) => Effect.Effect<OrchestrationListProjectMediaResult, ProjectMediaError>;
  /**
   * One file of a checkout's uncommitted change as the last commit or the
   * disk holds it. The path is repository-root-relative and never leaves the
   * repository.
   */
  readonly readRepositoryFile: (
    input: VcsReadRepositoryFileInput,
  ) => Effect.Effect<ProjectRevisionFileResult, ProjectMediaError>;
  /** The bytes of a picture shown inline in a chat (a tool's screenshot). */
  readonly readChatMedia: (
    input: OrchestrationReadChatMediaInput,
  ) => Effect.Effect<OrchestrationReadChatMediaResult, ProjectMediaError>;
  /** Index older chats' pictures in the background, once; see ThreadMediaBackfill. */
  readonly startChatBackfill: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProjectMedia extends Context.Service<ProjectMedia, ProjectMediaShape>()(
  "threadlines/media/ProjectMedia",
) {}

const ProjectMediaRowSchema = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  turnId: Schema.String,
  checkpointTurnCount: Schema.Number,
  changedAt: Schema.String,
  assistantMessageId: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  previousPath: Schema.NullOr(Schema.String),
});

const ListRequest = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
});

// A turn whose summary names no media file at all is skipped before its JSON
// is unpacked; `LIKE` is case-blind for ASCII, so `.PNG` matches too. The
// precise test (path or old name) is the fold's, on what is left.
const MEDIA_SUMMARY_FILTER = ALL_MEDIA_EXTENSIONS.map(
  () => "turns.checkpoint_files_json LIKE ?",
).join(" OR ");
const MEDIA_SUMMARY_PATTERNS = ALL_MEDIA_EXTENSIONS.map((extension) => `%.${extension}"%`);

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(OrchestrationProjectMediaEntry));

function isSafeRepositoryPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !normalized.split("/").some((segment) => segment === "..")
  );
}

/** Whether `candidate` is `root` or inside it, both already real paths. */
function isInside(pathApi: Path.Path, root: string, candidate: string): boolean {
  const relative = pathApi.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry;
  const checkpointStore = yield* CheckpointStore;
  const workspaceFileSystem = yield* WorkspaceFileSystem;
  const chatMedia = yield* makeChatMediaListing;

  const listRows = SqlSchema.findAll({
    Request: ListRequest,
    Result: ProjectMediaRowSchema,
    execute: ({ projectId, threadId }) =>
      sql.unsafe(
        `SELECT
          threads.thread_id AS "threadId",
          threads.title AS "threadTitle",
          COALESCE(threads.worktree_path, projects.workspace_root) AS "cwd",
          turns.turn_id AS "turnId",
          turns.checkpoint_turn_count AS "checkpointTurnCount",
          COALESCE(turns.checkpoint_completed_at, turns.completed_at, turns.requested_at)
            AS "changedAt",
          turns.assistant_message_id AS "assistantMessageId",
          json_extract(file.value, '$.path') AS "path",
          json_extract(file.value, '$.kind') AS "kind",
          json_extract(file.value, '$.previousPath') AS "previousPath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        INNER JOIN projection_turns AS turns
          ON turns.thread_id = threads.thread_id
          AND turns.checkpoint_turn_count IS NOT NULL
        CROSS JOIN json_each(turns.checkpoint_files_json) AS file
        WHERE threads.project_id = ?
          AND threads.deleted_at IS NULL
          ${threadId === null ? "" : "AND threads.thread_id = ?"}
          AND (${MEDIA_SUMMARY_FILTER})
        ORDER BY threads.thread_id ASC, turns.checkpoint_turn_count ASC`,
        [projectId, ...(threadId === null ? [] : [threadId]), ...MEDIA_SUMMARY_PATTERNS],
      ),
  });

  /**
   * Where a folder sits in its repository ("" at its root), so summary paths
   * can be read from inside it; null when the folder is gone. A folder that is
   * not a repository reads its summary paths as they are.
   */
  const folderPrefix = Effect.fn("ProjectMedia.folderPrefix")(function* (cwd: string) {
    const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.option);
    if (realCwd._tag === "None") {
      return null;
    }
    const handle = yield* vcsRegistry.detect({ cwd }).pipe(Effect.orElseSucceed(() => null));
    if (handle === null) {
      return "";
    }
    const realRoot = yield* fileSystem
      .realPath(handle.repository.rootPath)
      .pipe(Effect.orElseSucceed(() => handle.repository.rootPath));
    const relative = path.relative(realRoot, realCwd.value).replaceAll("\\", "/");
    return relative.startsWith("..") ? "" : relative;
  });

  const listProjectMedia: ProjectMediaShape["listProjectMedia"] = Effect.fn(
    "ProjectMedia.listProjectMedia",
  )(
    function* (input) {
      const rows = yield* listRows({
        projectId: input.projectId,
        threadId: input.threadId ?? null,
      });
      const foldable: ProjectMediaTurnFileRow[] = [];
      for (const row of rows) {
        if (row.cwd === null || row.path === null || row.kind === null) {
          continue;
        }
        foldable.push({ ...row, cwd: row.cwd, path: row.path, kind: row.kind });
      }
      const folded = foldProjectMediaRows(foldable);

      const prefixByCwd = new Map<string, string | null>();
      const realCwdByCwd = new Map<string, string | null>();
      for (const cwd of new Set(folded.map((entry) => entry.cwd))) {
        prefixByCwd.set(cwd, yield* folderPrefix(cwd));
        realCwdByCwd.set(
          cwd,
          yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null)),
        );
      }

      const located = yield* Effect.forEach(
        folded,
        (entry) =>
          Effect.gen(function* () {
            const prefix = prefixByCwd.get(entry.cwd) ?? null;
            const realCwd = realCwdByCwd.get(entry.cwd) ?? null;
            if (prefix === null || realCwd === null || !isSafeRepositoryPath(entry.path)) {
              return null;
            }
            const relativePath = pathInsideFolder(entry.path, prefix);
            if (relativePath === null) {
              return null;
            }
            const absolutePath = path.join(entry.cwd, relativePath);
            // Only files really inside the folder: a link out of it is not
            // something the thread made here.
            const realPath = yield* fileSystem.realPath(absolutePath).pipe(Effect.option);
            if (realPath._tag === "None" || !isInside(path, realCwd, realPath.value)) {
              return null;
            }
            const stat = yield* fileSystem.stat(realPath.value).pipe(Effect.option);
            // Gone from disk, or replaced by a folder: nothing to show.
            if (stat._tag === "None" || stat.value.type !== "File") {
              return null;
            }
            return {
              threadId: entry.threadId,
              threadTitle: entry.threadTitle,
              cwd: entry.cwd,
              relativePath,
              repositoryPath: entry.path,
              mediaKind: entry.mediaKind,
              change: entry.added ? "added" : "modified",
              turnId: entry.turnId,
              checkpointTurnCount: entry.checkpointTurnCount,
              changedAt: entry.changedAt,
              assistantMessageId: entry.assistantMessageId,
              size: Number(stat.value.size),
              version: fileVersionOf(stat.value),
            } as const;
          }),
        { concurrency: 16 },
      );

      // Two threads sharing a checkout can both have changed one file; it is
      // listed once, under the latest change.
      const newestFirst = located
        .filter((entry) => entry !== null)
        .toSorted((left, right) => right.changedAt.localeCompare(left.changedAt));
      const seen = new Set<string>();
      const entries: unknown[] = [];
      for (const entry of newestFirst) {
        const key = path.resolve(entry.cwd, entry.relativePath);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push(entry);
      }
      // The rows carry plain strings; decoding brands them, and a row the
      // projection holds in some unexpected shape fails here, loudly.
      const decoded = yield* decodeEntries(entries.slice(0, PROJECT_MEDIA_MAX_ENTRIES));
      const files = {
        entries: decoded,
        truncated: entries.length > PROJECT_MEDIA_MAX_ENTRIES,
      } satisfies OrchestrationListProjectMediaResult;
      if (input.includeChat !== true) {
        return files;
      }
      const shared = yield* chatMedia.listChatMedia({
        projectId: input.projectId,
        threadId: input.threadId ?? null,
        // Only what this listing shows: a file past its cap still shows in chat.
        projectFiles: new Set(decoded.map((entry) => path.resolve(entry.cwd, entry.relativePath))),
      });
      return { ...files, ...shared } satisfies OrchestrationListProjectMediaResult;
    },
    Effect.mapError(
      (cause) =>
        new ProjectMediaError({
          operation: "ProjectMedia.listProjectMedia",
          detail: "Could not list this project's media.",
          cause,
        }),
    ),
  );

  const readRepositoryFile: ProjectMediaShape["readRepositoryFile"] = Effect.fn(
    "ProjectMedia.readRepositoryFile",
  )(
    function* (input) {
      const missing = { kind: "missing" as const, relativePath: input.path };
      if (!isSafeRepositoryPath(input.path)) {
        return missing;
      }
      const handle = yield* vcsRegistry.detect({ cwd: input.cwd });
      if (handle === null) {
        return missing;
      }
      if (input.source === "head") {
        return yield* readRevisionFileResult({
          checkpointStore,
          cwd: input.cwd,
          revision: "HEAD",
          path: input.path,
        });
      }
      // The disk side never leaves the repository, links included.
      const realRoot = yield* fileSystem
        .realPath(handle.repository.rootPath)
        .pipe(Effect.orElseSucceed(() => handle.repository.rootPath));
      const realFile = yield* fileSystem
        .realPath(path.join(handle.repository.rootPath, input.path))
        .pipe(Effect.option);
      if (realFile._tag === "None" || !isInside(path, realRoot, realFile.value)) {
        return missing;
      }
      const result = yield* workspaceFileSystem.readFile({
        cwd: handle.repository.rootPath,
        relativePath: input.path,
      });
      switch (result.kind) {
        case "image":
        case "binary":
        case "missing":
          return result;
        case "text":
        case "document":
          return { kind: "binary" as const, relativePath: result.relativePath, size: result.size };
      }
    },
    Effect.mapError(
      (cause) =>
        new ProjectMediaError({
          operation: "ProjectMedia.readRepositoryFile",
          detail: "Could not read this file.",
          cause,
        }),
    ),
  );

  const readChatMedia: ProjectMediaShape["readChatMedia"] = (input) =>
    chatMedia.readChatMedia(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectMediaError({
            operation: "ProjectMedia.readChatMedia",
            detail: "Could not read this picture.",
            cause,
          }),
      ),
    );

  const startChatBackfill: ProjectMediaShape["startChatBackfill"] = () =>
    runThreadMediaBackfill(sql).pipe(
      Effect.catchCause((cause) => Effect.logWarning("media.chat-backfill.failed", { cause })),
      Effect.forkScoped,
      Effect.asVoid,
    );

  return {
    listProjectMedia,
    readRepositoryFile,
    readChatMedia,
    startChatBackfill,
  } satisfies ProjectMediaShape;
});

export const ProjectMediaLive = Layer.effect(ProjectMedia, make);
