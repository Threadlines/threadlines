/**
 * chatMediaListing - the Media tab's "Shared in chat": the pictures the chat
 * showed and the pictures and PDFs you attached, read from
 * `projection_thread_media` (persistence/threadMedia.ts), plus the bytes of a
 * picture that lives only inside the chat.
 *
 * Paths are resolved here, against the thread's folder as it is now, the way
 * the chat resolves them; a file that is gone is left out, and a file the
 * project listing already shows is not listed twice. A picture is listed
 * once, at the newest place it showed.
 *
 * @module chatMediaListing
 */
import {
  type OrchestrationChatMediaEntry,
  OrchestrationChatMediaEntry as OrchestrationChatMediaEntrySchema,
  type OrchestrationReadChatMediaInput,
  type OrchestrationReadChatMediaResult,
} from "@threadlines/contracts";
import {
  FILE_REFERENCE_SEARCH_LIMIT,
  parseChatFileReference,
  placeReferenceInSearch,
  resolvePathLinkTarget,
  splitPathAndPosition,
} from "@threadlines/shared/chatLinks";
import { readToolImages, resolveMessagePicturePath } from "@threadlines/shared/chatMedia";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ThreadMediaRef } from "../persistence/threadMedia.ts";
import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries.ts";
import { fileVersionOf } from "../workspace/fileVersion.ts";
import { threadMediaBackfillPending } from "./ThreadMediaBackfill.ts";

/** Chat entries past this many (oldest first) are left off. */
export const CHAT_MEDIA_MAX_ENTRIES = 2_000;
// Rows read per listing: a picture usually has a few (a tool call's updates,
// a screenshot cited again), and the newest are what is shown.
const CHAT_MEDIA_MAX_ROWS = CHAT_MEDIA_MAX_ENTRIES * 4;
// Files a listing looks up by name, newest first; past this the listing is
// marked truncated.
const CHAT_MEDIA_MAX_CITATIONS = 500;

interface ChatMediaListRow {
  readonly mediaId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly cwd: string | null;
  readonly projectRoot: string | null;
  readonly origin: string;
  readonly mediaKind: string;
  readonly name: string;
  readonly refJson: string;
  readonly sharedAt: string;
  readonly version: string;
  readonly messageId: string | null;
}

const decodeEntry = Schema.decodeUnknownExit(OrchestrationChatMediaEntrySchema);

function parseRef(json: string): ThreadMediaRef | null {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && "kind" in value ? (value as ThreadMediaRef) : null;
  } catch {
    return null;
  }
}

export interface ListChatMediaInput {
  readonly projectId: string;
  readonly threadId: string | null;
  /** Absolute paths the project listing shows already. */
  readonly projectFiles: ReadonlySet<string>;
}

export const makeChatMediaListing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceEntries = yield* WorkspaceEntries;

  const listRows = (input: { readonly projectId: string; readonly threadId: string | null }) =>
    sql.unsafe<ChatMediaListRow>(
      `SELECT
        media.media_id AS "mediaId",
        media.thread_id AS "threadId",
        threads.title AS "threadTitle",
        COALESCE(threads.effective_cwd, threads.worktree_path, projects.workspace_root) AS "cwd",
        -- The chat looks in the project folder too, except in General Chats,
        -- whose folder holds every chat's files.
        CASE WHEN projects.kind = 'general-chat' THEN NULL ELSE projects.workspace_root END
          AS "projectRoot",
        media.origin,
        media.media_kind AS "mediaKind",
        media.name,
        media.ref_json AS "refJson",
        media.shared_at AS "sharedAt",
        media.version,
        COALESCE(media.message_id, turns.assistant_message_id) AS "messageId"
      FROM projection_thread_media AS media
      INNER JOIN projection_threads AS threads ON threads.thread_id = media.thread_id
      INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = media.thread_id AND turns.turn_id = media.turn_id
      WHERE threads.project_id = ?
        AND threads.deleted_at IS NULL
        ${input.threadId === null ? "" : "AND media.thread_id = ?"}
      ORDER BY media.shared_at DESC, media.media_id ASC
      LIMIT ?`,
      [input.projectId, ...(input.threadId === null ? [] : [input.threadId]), CHAT_MEDIA_MAX_ROWS],
    );

  const fileInfo = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) =>
        info.type === "File" ? { size: Number(info.size), version: fileVersionOf(info) } : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Where the chat finds a file cited by name (`home.png`, `shots/home.png`),
   * the way the chat looks (fileViewerStore's placeChatFileReference): a
   * path-ending search of the thread's folder, then of the project folder
   * behind a worktree. Null when neither has it, or it could be more than one.
   */
  const placeCitation = Effect.fn("ProjectMedia.placeCitation")(function* (citation: {
    readonly reference: string;
    readonly cwd: string;
    readonly projectRoot: string | null;
  }) {
    const parsed = parseChatFileReference(citation.reference);
    if (parsed === null) return null;
    const { cwd, projectRoot } = citation;
    const relative = parsed.path.replace(/^(?:\.\/)+/u, "");
    if (relative.split("/").some((segment) => segment === "." || segment === "..")) {
      // A path that steps through folders says exactly where the file is.
      return path.resolve(cwd, relative);
    }
    const folders =
      projectRoot !== null && path.resolve(projectRoot) !== path.resolve(cwd)
        ? [cwd, projectRoot]
        : [cwd];
    for (const folder of folders) {
      const result = yield* workspaceEntries
        .search({
          cwd: folder,
          query: relative,
          limit: FILE_REFERENCE_SEARCH_LIMIT,
          match: "path-ending",
        })
        .pipe(Effect.option);
      if (result._tag === "None") {
        // With no search to ask, the chat takes a path as written; a bare
        // name can't be placed at all.
        return relative.includes("/") ? path.resolve(cwd, relative) : null;
      }
      const match = placeReferenceInSearch(result.value, relative);
      if (match.status === "found") return path.resolve(folder, match.path);
      if (match.status === "ambiguous") return null;
    }
    return null;
  });

  const listChatMedia = Effect.fn("ProjectMedia.listChatMedia")(function* (
    input: ListChatMediaInput,
  ) {
    const rows = yield* listRows(input);
    const items = rows.flatMap((row) => {
      const ref = parseRef(row.refJson);
      return ref === null || row.cwd === null ? [] : [{ row, ref, cwd: row.cwd }];
    });

    // Files cited by name, newest first, each looked up once.
    const citations = new Map<
      string,
      { readonly reference: string; readonly cwd: string; readonly projectRoot: string | null }
    >();
    let citationsLeftOut = false;
    for (const { row, ref, cwd } of items) {
      if (ref.kind !== "citation") continue;
      const key = `${cwd}\u0000${ref.reference}`;
      if (citations.has(key)) continue;
      if (citations.size >= CHAT_MEDIA_MAX_CITATIONS) {
        citationsLeftOut = true;
        continue;
      }
      citations.set(key, { reference: ref.reference, cwd, projectRoot: row.projectRoot });
    }
    const placed = new Map<string, string | null>();
    yield* Effect.forEach(
      citations,
      ([key, citation]) =>
        placeCitation(citation).pipe(
          Effect.tap((file) => Effect.sync(() => placed.set(key, file))),
        ),
      { concurrency: 4, discard: true },
    );

    // The file each row names, resolved as the chat resolves it.
    const fileOf = (item: (typeof items)[number]): string | null => {
      const { ref, cwd } = item;
      const file =
        ref.kind === "path"
          ? ref.from === "reply"
            ? resolveMessagePicturePath(ref.path, cwd)
            : splitPathAndPosition(resolvePathLinkTarget(ref.path, cwd)).path
          : ref.kind === "citation"
            ? (placed.get(`${cwd}\u0000${ref.reference}`) ?? null)
            : ref.kind === "inline" && ref.path
              ? splitPathAndPosition(resolvePathLinkTarget(ref.path, cwd)).path
              : null;
      return file === null ? null : path.resolve(file);
    };
    const files = new Map<string, { size: number; version: string } | null>();
    for (const item of items) {
      const file = fileOf(item);
      if (file !== null) files.set(file, null);
    }
    yield* Effect.forEach(
      [...files.keys()],
      (file) => fileInfo(file).pipe(Effect.tap((info) => Effect.sync(() => files.set(file, info)))),
      { concurrency: 16, discard: true },
    );

    const seen = new Set<string>();
    const entries: OrchestrationChatMediaEntry[] = [];
    let truncated = rows.length >= CHAT_MEDIA_MAX_ROWS || citationsLeftOut;
    for (const item of items) {
      const { row, ref } = item;
      const file = fileOf(item);
      const info = file === null ? null : (files.get(file) ?? null);
      let listed: {
        readonly key: string;
        readonly source: OrchestrationChatMediaEntry["source"];
        readonly size: number;
        readonly version: string;
      } | null = null;
      if (file !== null && info !== null) {
        // A file the project listing shows already is listed there.
        if (input.projectFiles.has(file)) continue;
        listed = { key: `file:${file}`, source: { kind: "file", path: file }, ...info };
      } else if (ref.kind === "attachment") {
        listed = {
          key: `attachment:${ref.attachment.id}`,
          source: ref,
          size: ref.attachment.sizeBytes,
          version: row.version,
        };
      } else if (ref.kind === "remote") {
        listed = { key: `remote:${ref.url}`, source: ref, size: 0, version: row.version };
      } else if (ref.kind === "inline") {
        // Still in the chat when the file the tool read is gone.
        listed = {
          key: `inline:${row.threadId}:${ref.call}#${ref.index}`,
          source: { kind: "inline", mimeType: ref.mimeType },
          size: ref.size,
          version: row.version,
        };
      }
      if (listed === null || seen.has(listed.key)) continue;
      seen.add(listed.key);
      if (entries.length >= CHAT_MEDIA_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const decoded = decodeEntry({
        id: row.mediaId,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        cwd: item.cwd,
        name: row.name,
        mediaKind: row.mediaKind,
        origin: row.origin,
        source: listed.source,
        sharedAt: row.sharedAt,
        messageId: row.messageId,
        size: listed.size,
        version: listed.version,
      });
      // A row this build cannot describe is left out, not the listing.
      if (decoded._tag === "Success") entries.push(decoded.value);
    }
    return {
      chat: entries,
      chatTruncated: truncated,
      chatIndexing: yield* threadMediaBackfillPending(sql),
    };
  });

  /** The bytes of a picture that lives only in the chat (a tool's screenshot). */
  const readChatMedia = Effect.fn("ProjectMedia.readChatMedia")(function* (
    input: OrchestrationReadChatMediaInput,
  ) {
    const missing: OrchestrationReadChatMediaResult = { kind: "missing" };
    const rows = yield* sql<{ readonly sourceId: string; readonly refJson: string }>`
      SELECT source_id AS "sourceId", ref_json AS "refJson"
      FROM projection_thread_media
      WHERE media_id = ${input.mediaId} AND thread_id = ${input.threadId}
    `;
    const row = rows[0];
    const ref = row ? parseRef(row.refJson) : null;
    if (row === undefined || ref === null || ref.kind !== "inline") return missing;
    const activities = yield* sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM projection_thread_activities
      WHERE activity_id = ${row.sourceId} AND thread_id = ${input.threadId}
    `;
    const payloadJson = activities[0]?.payloadJson;
    if (payloadJson === undefined) return missing;
    let payload: unknown = null;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      return missing;
    }
    const image = readToolImages(
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null,
    )[ref.index];
    const url = image?.previewUrl;
    const head = url ? /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(url) : null;
    if (!url || !head) return missing;
    const base64 = url.slice(head[0].length);
    return {
      kind: "image",
      mimeType: head[1]!.toLowerCase(),
      base64,
      size: ref.size,
    } satisfies OrchestrationReadChatMediaResult;
  });

  return { listChatMedia, readChatMedia };
});
