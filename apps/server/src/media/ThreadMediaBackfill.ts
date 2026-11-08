/**
 * ThreadMediaBackfill - one pass over chats written before
 * `projection_thread_media` existed (migration 105), so their pictures reach
 * the Media tab too. Rows written since are indexed as they are written
 * (persistence/threadMedia.ts); this walks the older ones once, in the
 * background, and remembers how far it got across restarts.
 *
 * The server's SQLite driver is synchronous, so every step is bounded: a
 * window of rowids is scanned for candidates without moving their text out of
 * SQLite, then each candidate is read, indexed and written in its own short
 * transaction, with a pause between windows. Re-running a window is harmless;
 * every write replaces that row's media whole.
 *
 * @module ThreadMediaBackfill
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  STORED_MESSAGE_MEDIA_COLUMNS,
  type StoredMessageMediaRow,
  replaceStoredMessageMedia,
  replaceThreadMedia,
  threadMediaForActivity,
} from "../persistence/threadMedia.ts";

export interface ThreadMediaBackfillOptions {
  /** Rowids scanned per window. */
  readonly windowSize?: number;
  /** Rest between windows, so live work keeps the connection. */
  readonly pause?: Duration.Input;
  /** Wait before the first window, while the server starts up. */
  readonly startDelay?: Duration.Input;
}

// Only tool steps whose text mentions a picture can show one; the test runs
// inside SQLite, so a screenshot's megabytes stay there unless it is one.
// `LIKE` is case-blind for ASCII, as the chat is about `.PNG` and `Image`.
const ACTIVITY_CANDIDATES = `
  kind LIKE 'tool.%' AND (
    payload_json LIKE '%image%' OR payload_json LIKE '%.png%'
    OR payload_json LIKE '%.jp%g%' OR payload_json LIKE '%.gif%'
    OR payload_json LIKE '%.webp%' OR payload_json LIKE '%.avif%'
    OR payload_json LIKE '%.svg%' OR payload_json LIKE '%.bmp%'
  )`;

// Attachments, or a reply that names anything with an extension.
const MESSAGE_CANDIDATES = `
  (attachments_json IS NOT NULL AND attachments_json != '[]')
  OR (role = 'assistant' AND instr(text, '.') > 0)`;

interface ActivityMediaRow {
  readonly activityId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly payloadJson: string;
  readonly createdAt: string;
  readonly eventSequence: number | null;
}

interface BackfillState {
  readonly nextRowid: number;
  readonly endRowid: number;
}

/** Whether older chats are still being looked through. */
export const threadMediaBackfillPending = (sql: SqlClient.SqlClient) =>
  sql<{ readonly pending: number }>`
    SELECT EXISTS (
      SELECT 1 FROM projection_thread_media_backfill WHERE next_rowid <= end_rowid
    ) AS pending
  `.pipe(Effect.map((rows) => rows[0]?.pending === 1));

const readState = (sql: SqlClient.SqlClient, sourceKind: "message" | "activity") =>
  sql<BackfillState>`
    SELECT next_rowid AS "nextRowid", end_rowid AS "endRowid"
    FROM projection_thread_media_backfill
    WHERE source_kind = ${sourceKind}
  `.pipe(Effect.map((rows) => rows[0] ?? null));

const indexMessage = (sql: SqlClient.SqlClient, rowid: number) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<StoredMessageMediaRow>(
        `SELECT ${STORED_MESSAGE_MEDIA_COLUMNS} FROM projection_thread_messages WHERE rowid = ?`,
        [rowid],
      );
      const row = rows[0];
      if (row !== undefined) yield* replaceStoredMessageMedia(sql, row);
    }),
  );

const indexActivity = (sql: SqlClient.SqlClient, rowid: number) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<ActivityMediaRow>`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          kind,
          payload_json AS "payloadJson",
          created_at AS "createdAt",
          event_sequence AS "eventSequence"
        FROM projection_thread_activities
        WHERE rowid = ${rowid}
      `;
      const row = rows[0];
      if (row === undefined) return;
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch {
        payload = null;
      }
      yield* replaceThreadMedia(sql, row.activityId, threadMediaForActivity({ ...row, payload }));
    }),
  );

/**
 * Walk one source table's older rows to the end, window by window. Returns
 * how many rows were indexed.
 */
const backfillSource = (
  sql: SqlClient.SqlClient,
  sourceKind: "message" | "activity",
  options: Required<Pick<ThreadMediaBackfillOptions, "windowSize" | "pause">>,
) =>
  Effect.gen(function* () {
    const table =
      sourceKind === "message" ? "projection_thread_messages" : "projection_thread_activities";
    const candidates = sourceKind === "message" ? MESSAGE_CANDIDATES : ACTIVITY_CANDIDATES;
    const index = sourceKind === "message" ? indexMessage : indexActivity;
    let indexed = 0;
    for (;;) {
      const state = yield* readState(sql, sourceKind);
      if (state === null || state.nextRowid > state.endRowid) return indexed;
      const windowEnd = Math.min(state.nextRowid + options.windowSize - 1, state.endRowid);
      const rowids = yield* sql.unsafe<{ readonly id: number }>(
        `SELECT rowid AS id FROM ${table}
         WHERE rowid BETWEEN ? AND ? AND (${candidates})
         ORDER BY rowid`,
        [state.nextRowid, windowEnd],
      );
      for (const { id } of rowids) {
        yield* index(sql, id);
        indexed += 1;
      }
      yield* sql`
        UPDATE projection_thread_media_backfill
        SET next_rowid = ${windowEnd + 1}
        WHERE source_kind = ${sourceKind}
      `;
      yield* Effect.sleep(options.pause);
    }
  });

/** The whole pass: messages (small), then tool steps. */
export const runThreadMediaBackfill = (
  sql: SqlClient.SqlClient,
  options?: ThreadMediaBackfillOptions,
) =>
  Effect.gen(function* () {
    if (!(yield* threadMediaBackfillPending(sql))) return;
    yield* Effect.sleep(options?.startDelay ?? Duration.seconds(10));
    const settings = {
      windowSize: Math.max(1, Math.floor(options?.windowSize ?? 200)),
      pause: options?.pause ?? Duration.millis(25),
    };
    const startedAt = Date.now();
    const messages = yield* backfillSource(sql, "message", settings);
    const activities = yield* backfillSource(sql, "activity", settings);
    yield* Effect.logInfo("media.chat-backfill.complete", {
      messages,
      activities,
      durationMs: Date.now() - startedAt,
    });
  });
