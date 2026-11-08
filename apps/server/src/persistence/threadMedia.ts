/**
 * threadMedia - the rows of `projection_thread_media` (migration 105): which
 * pictures and attached files one message or tool step shows in the chat.
 *
 * The message and activity repositories rewrite a row's media whenever they
 * write the row, so the table follows every way a chat changes (new rows,
 * edits, reverts, imports). The background pass (ThreadMediaBackfill) runs
 * the same functions over rows written before the table existed. What counts
 * as a picture is the chat's own rule (@threadlines/shared/chatMedia); paths
 * stay as written and are resolved when listed, as the chat resolves them.
 *
 * @module threadMedia
 */
import { type ChatAttachment, ChatAttachmentListLenient } from "@threadlines/contracts";
import {
  extractMessagePictures,
  readToolImages,
  toolCallIdentity,
  toolImagePath,
} from "@threadlines/shared/chatMedia";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/** How to find one picture or file again; stored as `ref_json`. */
export type ThreadMediaRef =
  | { readonly kind: "attachment"; readonly attachment: ChatAttachment }
  /** A path as the chat wrote it: in a reply (markdown rules) or on a tool row. */
  | { readonly kind: "path"; readonly path: string; readonly from: "reply" | "tool" }
  /** Inline code the chat places by searching the project. */
  | { readonly kind: "citation"; readonly reference: string }
  | { readonly kind: "remote"; readonly url: string }
  /**
   * Bytes a tool step carried, the `index`-th picture its row shows. `call`
   * names the tool call, whose started/updated/completed rows repeat them;
   * `path` is where the tool said the picture is, when it said.
   */
  | {
      readonly kind: "inline";
      readonly mimeType: string;
      readonly size: number;
      readonly index: number;
      readonly call: string;
      readonly path?: string;
    };

export type ThreadMediaOrigin = "attached" | "tool" | "reply";

export interface ThreadMediaRow {
  readonly mediaId: string;
  readonly threadId: string;
  readonly sourceKind: "message" | "activity";
  readonly sourceId: string;
  readonly origin: ThreadMediaOrigin;
  readonly mediaKind: "picture" | "document";
  readonly name: string;
  readonly ref: ThreadMediaRef;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly sharedAt: string;
  readonly version: string;
}

/** What {@link threadMediaForMessage} reads from a message row. */
export interface ThreadMediaMessageSource {
  readonly messageId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What {@link threadMediaForActivity} reads from an activity row. */
export interface ThreadMediaActivitySource {
  readonly activityId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly eventSequence: number | null;
}

/** Pads a place in its row so ids sort in the order the row shows them. */
function ordinalKey(ordinal: number): string {
  return String(ordinal).padStart(4, "0");
}

/** The last segment of a path or URL path, without any `:line` suffix. */
function baseName(value: string): string {
  const withoutPosition = value.replace(/:\d+(?::\d+)?$/u, "");
  return (
    withoutPosition.split(/[\\/]/u).findLast((segment) => segment.length > 0) ?? withoutPosition
  );
}

function remoteName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").findLast((segment) => segment.length > 0);
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** `mcp__threadlines_browser__browser_screenshot` reads as `browser_screenshot`. */
function toolLabel(payload: Record<string, unknown> | null): string {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : null;
  const record = data as Record<string, unknown> | null;
  const item =
    record?.item && typeof record.item === "object"
      ? (record.item as Record<string, unknown>)
      : null;
  const tool = [record?.toolName, item?.tool, record?.tool].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const label = tool?.split("__").at(-1)?.trim();
  return label && /^[\w.-]+$/u.test(label) ? label : "screenshot";
}

/** The bytes behind `length` base64 characters ending the string `value`. */
function base64Size(value: string, length: number): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

// Only the head: a screenshot's data URL runs to megabytes.
const INLINE_IMAGE_PREFIX = /^data:(image\/[a-z0-9.+-]+);base64,/iu;

/** The pictures and files one message shows: your attachments (pictures and
 *  PDFs), then the pictures an agent's reply draws. */
export function threadMediaForMessage(message: ThreadMediaMessageSource): ThreadMediaRow[] {
  const rows: ThreadMediaRow[] = [];
  const push = (
    origin: ThreadMediaOrigin,
    mediaKind: ThreadMediaRow["mediaKind"],
    name: string,
    ref: ThreadMediaRef,
    version: string,
  ) => {
    rows.push({
      mediaId: `message:${message.messageId}#${ordinalKey(rows.length)}`,
      threadId: message.threadId,
      sourceKind: "message",
      sourceId: message.messageId,
      origin,
      mediaKind,
      name: name.trim() || "Untitled",
      ref,
      turnId: message.turnId,
      messageId: message.messageId,
      sharedAt: message.createdAt,
      version,
    });
  };
  for (const attachment of message.attachments) {
    if (attachment.type === "image") {
      push(
        "attached",
        "picture",
        attachment.name,
        { kind: "attachment", attachment },
        attachment.id,
      );
    } else if (attachment.kind === "pdf") {
      push(
        "attached",
        "document",
        attachment.name,
        { kind: "attachment", attachment },
        attachment.id,
      );
    }
  }
  // Your own messages are plain text in the chat; only replies draw pictures.
  if (message.role === "assistant") {
    for (const picture of extractMessagePictures(message.text)) {
      switch (picture.kind) {
        case "path":
          push("reply", "picture", baseName(picture.path), { ...picture, from: "reply" }, "file");
          break;
        case "citation":
          push("reply", "picture", baseName(picture.reference), picture, "file");
          break;
        case "remote":
          push("reply", "picture", remoteName(picture.url), picture, picture.url);
          break;
      }
    }
  }
  return rows;
}

/** The pictures one tool step's row shows. */
export function threadMediaForActivity(activity: ThreadMediaActivitySource): ThreadMediaRow[] {
  if (!activity.kind.startsWith("tool.")) return [];
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const images = readToolImages(payload);
  if (images.length === 0) return [];
  const call = toolCallIdentity(payload) ?? activity.activityId;
  // A step showing one picture from bytes may also say which file it is.
  const namedPath = images.length === 1 ? toolImagePath(payload) : null;
  const rows: ThreadMediaRow[] = [];
  images.forEach((image, index) => {
    const base = {
      mediaId: `activity:${activity.activityId}#${ordinalKey(index)}`,
      threadId: activity.threadId,
      sourceKind: "activity" as const,
      sourceId: activity.activityId,
      origin: "tool" as const,
      mediaKind: "picture" as const,
      turnId: activity.turnId,
      messageId: null,
      sharedAt: activity.createdAt,
    };
    const url = image.previewUrl;
    const path = image.path ?? namedPath ?? undefined;
    const inline = url ? INLINE_IMAGE_PREFIX.exec(url) : null;
    if (url && inline) {
      const mimeType = inline[1]!.toLowerCase();
      const label = path
        ? baseName(path)
        : `${toolLabel(payload)}${index > 0 ? `-${index + 1}` : ""}.${EXTENSION_BY_MIME[mimeType] ?? "png"}`;
      rows.push({
        ...base,
        name: label,
        ref: {
          kind: "inline",
          mimeType,
          size: base64Size(url, url.length - inline[0].length),
          index,
          call,
          ...(path ? { path } : {}),
        },
        version: `${activity.eventSequence ?? activity.createdAt}`,
      });
    } else if (url && /^https?:\/\//iu.test(url)) {
      rows.push({ ...base, name: remoteName(url), ref: { kind: "remote", url }, version: url });
    } else if (image.path) {
      rows.push({
        ...base,
        name: baseName(image.path),
        ref: { kind: "path", path: image.path, from: "tool" },
        version: "file",
      });
    }
  });
  return rows;
}

/** Replace one message's or tool step's media with `rows`. */
export const replaceThreadMedia = (
  sql: SqlClient.SqlClient,
  sourceId: string,
  rows: ReadonlyArray<ThreadMediaRow>,
) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM projection_thread_media WHERE source_id = ${sourceId}`;
    if (!Arr.isReadonlyArrayNonEmpty(rows)) return;
    yield* sql`
      INSERT OR REPLACE INTO projection_thread_media ${sql.insert(
        Arr.map(rows, (row) => ({
          media_id: row.mediaId,
          thread_id: row.threadId,
          source_kind: row.sourceKind,
          source_id: row.sourceId,
          origin: row.origin,
          media_kind: row.mediaKind,
          name: row.name,
          ref_json: JSON.stringify(row.ref),
          turn_id: row.turnId,
          message_id: row.messageId,
          shared_at: row.sharedAt,
          version: row.version,
        })),
      )}
    `;
  });

/** Drop a thread's media from one source table, as that table drops its rows. */
export const deleteThreadMediaForThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
  sourceKind: ThreadMediaRow["sourceKind"],
) =>
  sql`
    DELETE FROM projection_thread_media
    WHERE thread_id = ${threadId} AND source_kind = ${sourceKind}
  `;

const decodeAttachmentsExit = Schema.decodeUnknownExit(ChatAttachmentListLenient);

/** A stored `attachments_json`, keeping what this build can read. */
export function attachmentsFromJson(json: string | null): ReadonlyArray<ChatAttachment> {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const decoded = decodeAttachmentsExit(parsed);
  return Exit.isSuccess(decoded) ? decoded.value : [];
}

/** A message row as stored, the columns {@link threadMediaForMessage} needs. */
export interface StoredMessageMediaRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly attachmentsJson: string | null;
  readonly isStreaming: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Selected as {@link StoredMessageMediaRow}. */
export const STORED_MESSAGE_MEDIA_COLUMNS = `
  message_id AS "messageId",
  thread_id AS "threadId",
  turn_id AS "turnId",
  role,
  text,
  attachments_json AS "attachmentsJson",
  is_streaming AS "isStreaming",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/** Rewrite a stored message's media; a message still streaming keeps what it had. */
export const replaceStoredMessageMedia = (sql: SqlClient.SqlClient, row: StoredMessageMediaRow) =>
  row.isStreaming === 1
    ? Effect.void
    : replaceThreadMedia(
        sql,
        row.messageId,
        threadMediaForMessage({ ...row, attachments: attachmentsFromJson(row.attachmentsJson) }),
      );

/**
 * Rewrite one message's media from the row as now stored. Read back rather
 * than taken from the write, which may leave attachments out and keep the
 * stored ones.
 */
export const reindexMessageMedia = (sql: SqlClient.SqlClient, messageId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<StoredMessageMediaRow>(
      `SELECT ${STORED_MESSAGE_MEDIA_COLUMNS} FROM projection_thread_messages WHERE message_id = ?`,
      [messageId],
    );
    const row = rows[0];
    if (row === undefined) {
      yield* replaceThreadMedia(sql, messageId, []);
      return;
    }
    yield* replaceStoredMessageMedia(sql, row);
  });
