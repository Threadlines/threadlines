/**
 * ProjectMedia - what the Media tab lists, and the uncommitted side of a
 * picture's Before/After in the Diff tab.
 *
 * Reads existing turn summaries, messages and tool results, with no new table
 * or backfill. Checkpoint files stay inside the thread's folder; explicit chat
 * references can also name files elsewhere, as the conversation renderer does.
 * Stored screenshots are listed as small references and read only on demand.
 *
 * @module ProjectMedia
 */
import {
  ChatAttachmentListLenient,
  EventId,
  MessageId,
  type OrchestrationGetProjectMediaPreviewInput,
  type OrchestrationGetProjectMediaPreviewResult,
  type OrchestrationMediaSource,
  type OrchestrationListProjectMediaInput,
  type OrchestrationListProjectMediaResult,
  OrchestrationProjectMediaEntry,
  type ProjectRevisionFileResult,
  type VcsReadRepositoryFileInput,
} from "@threadlines/contracts";
import { ALL_MEDIA_EXTENSIONS, classifyMediaPath } from "@threadlines/shared/media";
import { extractMessageMedia, extractWorkLogImages } from "@threadlines/shared/chatMedia";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
  readonly getProjectMediaPreview: (
    input: OrchestrationGetProjectMediaPreviewInput,
  ) => Effect.Effect<OrchestrationGetProjectMediaPreviewResult, ProjectMediaError>;
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

const ConversationMediaRow = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  cwd: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  checkpointTurnCount: Schema.NullOr(Schema.Number),
  assistantMessageId: Schema.NullOr(Schema.String),
  changedAt: Schema.String,
  id: Schema.String,
  kind: Schema.Literals(["message", "activity"]),
  content: Schema.String,
  attachments: Schema.NullOr(Schema.String),
});

// A turn whose summary names no media file at all is skipped before its JSON
// is unpacked; `LIKE` is case-blind for ASCII, so `.PNG` matches too. The
// precise test (path or old name) is the fold's, on what is left.
const MEDIA_SUMMARY_FILTER = ALL_MEDIA_EXTENSIONS.map(
  () => "turns.checkpoint_files_json LIKE ?",
).join(" OR ");
const MEDIA_SUMMARY_PATTERNS = ALL_MEDIA_EXTENSIONS.map((extension) => `%.${extension}"%`);

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(OrchestrationProjectMediaEntry));
const decodeAttachments = Schema.decodeUnknownEffect(ChatAttachmentListLenient);

function isSafeRepositoryPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !normalized.split("/").some((segment) => segment === "..")
  );
}

/** Inline images expose their size without copying or decoding their bytes. */
function previewSize(url: string | undefined): number {
  if (!url?.startsWith("data:image/")) return 0;
  const comma = url.indexOf(",");
  if (comma === -1) return 0;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(((url.length - comma - 1) * 3) / 4) - padding);
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

  const listConversationRows = SqlSchema.findAll({
    Request: ListRequest,
    Result: ConversationMediaRow,
    execute: ({ projectId, threadId }) =>
      sql.unsafe(
        `
      SELECT threads.thread_id AS "threadId", threads.title AS "threadTitle",
        COALESCE(threads.effective_cwd, threads.worktree_path, projects.workspace_root) AS cwd,
        media.turn_id AS "turnId", turns.checkpoint_turn_count AS "checkpointTurnCount",
        CASE WHEN media.kind = 'message' THEN media.id ELSE turns.assistant_message_id END AS "assistantMessageId",
        media.created_at AS "changedAt", media.id, media.kind, media.content, media.attachments
      FROM projection_threads AS threads
      INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      INNER JOIN (
        SELECT thread_id, turn_id, message_id AS id, 'message' AS kind,
          text AS content, attachments_json AS attachments, created_at
        FROM projection_thread_messages
        WHERE text LIKE '%.%' OR text LIKE '%![%' OR attachments_json IS NOT NULL
        UNION ALL
        SELECT thread_id, turn_id, activity_id AS id, 'activity' AS kind,
          payload_json AS content, NULL AS attachments, created_at
        FROM projection_thread_activities
        WHERE payload_json LIKE '%image%' OR payload_json LIKE '%savedPath%'
          OR payload_json LIKE '%saved_path%'
          ${ALL_MEDIA_EXTENSIONS.map((extension) => `OR payload_json LIKE '%.${extension}%'`).join(" ")}
      ) AS media ON media.thread_id = threads.thread_id
      LEFT JOIN projection_turns AS turns ON turns.thread_id = media.thread_id AND turns.turn_id = media.turn_id
      WHERE threads.project_id = ? AND threads.deleted_at IS NULL
        ${threadId === null ? "" : "AND threads.thread_id = ?"}
      ORDER BY media.created_at DESC
    `,
        [projectId, ...(threadId === null ? [] : [threadId])],
      ),
  });

  const listConversationMedia = Effect.fn("ProjectMedia.listConversationMedia")(function* (
    input: typeof ListRequest.Type,
  ) {
    const rows = yield* listConversationRows(input);
    const entries: unknown[] = [];
    for (const row of rows) {
      const contentVersion = createHash("sha256").update(row.content).digest("hex");
      const add = Effect.fn(function* (
        rawPath: string,
        source?: OrchestrationMediaSource,
        size = 0,
        image = false,
      ) {
        let cwd = row.cwd;
        let relativePath = rawPath;
        let version = contentVersion;
        if (!source) {
          // An explicit chat reference may point outside the checkout, just
          // like the image already shown by the conversation renderer.
          const parsed = yield* Effect.try(() =>
            rawPath.startsWith("file:") ? fileURLToPath(rawPath) : decodeURIComponent(rawPath),
          ).pipe(Effect.orElseSucceed(() => rawPath));
          let file = parsed;
          file = file.replace(/:\d+(?::\d+)?$/u, "").split(/[?#]/u)[0] ?? file;
          if (/^~[\\/]/u.test(file)) file = path.join(homedir(), file.slice(2));
          const absolute = path.resolve(row.cwd, file);
          const stat = yield* fileSystem.stat(absolute).pipe(Effect.option);
          if (stat._tag === "None" || stat.value.type !== "File") return;
          cwd = path.dirname(absolute);
          relativePath = path.basename(absolute);
          size = Number(stat.value.size);
          version = fileVersionOf(stat.value);
        }
        const mediaKind = image
          ? "picture"
          : source?.kind === "attachment"
            ? "document"
            : classifyMediaPath(relativePath);
        if (mediaKind === null) return;
        entries.push({
          threadId: row.threadId,
          threadTitle: row.threadTitle,
          cwd,
          relativePath,
          repositoryPath: relativePath,
          mediaKind,
          change: "referenced",
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          assistantMessageId: row.assistantMessageId,
          changedAt: row.changedAt,
          size,
          version,
          ...(source ? { source } : {}),
        });
      });
      if (row.kind === "message") {
        const attachments = yield* decodeAttachments(
          row.attachments ? JSON.parse(row.attachments) : [],
        );
        for (const attachment of attachments) {
          yield* add(
            attachment.name,
            { kind: "attachment", attachment },
            attachment.sizeBytes,
            attachment.type === "image",
          );
        }
        for (const [index, ref] of extractMessageMedia(row.content).entries()) {
          const remote = /^(?:https?:|data:image\/|blob:)/iu.test(ref.path);
          yield* add(
            remote ? `image-${index + 1}.png` : ref.path,
            remote ? { kind: "message", messageId: MessageId.make(row.id), index } : undefined,
            remote ? previewSize(ref.path) : 0,
            ref.image,
          );
        }
      } else {
        const payload: unknown = JSON.parse(row.content);
        const images = extractWorkLogImages(
          payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null,
        );
        for (const image of images) {
          yield* add(
            image.path ?? image.name,
            image.previewUrl
              ? { kind: "activity", activityId: EventId.make(row.id), imageId: image.id }
              : undefined,
            previewSize(image.previewUrl),
            true,
          );
        }
      }
    }
    return entries;
  });

  // Inline bytes stay in their original message/activity until a tile needs
  // them. The listing carries only a small reference, even for screenshots.
  const getProjectMediaPreview: ProjectMediaShape["getProjectMediaPreview"] = Effect.fn(
    "ProjectMedia.getProjectMediaPreview",
  )(
    function* (input) {
      const source = input.source;
      if (source.kind === "attachment") return { url: null };
      const rows =
        source.kind === "activity"
          ? yield* sql<{
              content: string;
            }>`SELECT payload_json AS content FROM projection_thread_activities
          WHERE thread_id = ${input.threadId} AND activity_id = ${source.activityId}`
          : yield* sql<{ content: string }>`SELECT text AS content FROM projection_thread_messages
          WHERE thread_id = ${input.threadId} AND message_id = ${source.messageId}`;
      const content = rows[0]?.content;
      if (!content) return { url: null };
      if (source.kind === "message") {
        const ref = extractMessageMedia(content)[source.index];
        return { url: ref && /^(?:https?:|data:image\/|blob:)/iu.test(ref.path) ? ref.path : null };
      }
      const payload: unknown = JSON.parse(content);
      const images = extractWorkLogImages(
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null,
      );
      return { url: images.find((image) => image.id === source.imageId)?.previewUrl ?? null };
    },
    Effect.mapError(
      (cause) =>
        new ProjectMediaError({
          operation: "ProjectMedia.getProjectMediaPreview",
          detail: "Could not load this media preview.",
          cause,
        }),
    ),
  );

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
      const conversation = yield* listConversationMedia({
        projectId: input.projectId,
        threadId: input.threadId ?? null,
      });
      // Prefer checkpoint metadata for a file that is also linked in chat,
      // so referencing a changed picture keeps its Before/After controls.
      const newestFirst = (yield* decodeEntries([
        ...located.filter((entry) => entry !== null),
        ...conversation,
      ])).toSorted(
        (left, right) =>
          Number(left.change === "referenced") - Number(right.change === "referenced") ||
          right.changedAt.localeCompare(left.changedAt),
      );
      const seen = new Set<string>();
      const entries: unknown[] = [];
      for (const entry of newestFirst) {
        const key = entry.source
          ? JSON.stringify(entry.source)
          : path.join(entry.cwd, entry.relativePath);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push(entry);
      }
      // The rows carry plain strings; decoding brands them, and a row the
      // projection holds in some unexpected shape fails here, loudly.
      const sorted = (yield* decodeEntries(entries)).toSorted((left, right) =>
        right.changedAt.localeCompare(left.changedAt),
      );
      const decoded = sorted.slice(0, PROJECT_MEDIA_MAX_ENTRIES);
      return {
        entries: decoded,
        truncated: entries.length > PROJECT_MEDIA_MAX_ENTRIES,
      } satisfies OrchestrationListProjectMediaResult;
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

  return {
    listProjectMedia,
    getProjectMediaPreview,
    readRepositoryFile,
  } satisfies ProjectMediaShape;
});

export const ProjectMediaLive = Layer.effect(ProjectMedia, make);
