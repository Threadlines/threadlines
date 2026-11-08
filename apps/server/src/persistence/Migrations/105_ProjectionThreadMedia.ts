import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The pictures and files a chat showed, for the Media tab's "Shared in chat"
 * (apps/server/src/persistence/threadMedia.ts).
 *
 * - `projection_thread_media`: one row per picture or attached file, written
 *   with the message or tool step that shows it and replaced when that row is.
 *   `ref_json` says how to find it (an attachment, a path, inline bytes, a
 *   URL); paths are resolved when listed, against the thread's folder then.
 * - `projection_thread_media_backfill`: how far the background pass over
 *   chats written before this table has got, per source table. The pass walks
 *   rowids up to `end_rowid`, the last row this migration saw; rows written
 *   after it are indexed as they are written.
 *
 * New tables only; no row is rewritten, and `MAX(rowid)` reads one page.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_media (
      media_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      media_kind TEXT NOT NULL,
      name TEXT NOT NULL,
      ref_json TEXT NOT NULL,
      turn_id TEXT,
      message_id TEXT,
      shared_at TEXT NOT NULL,
      version TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_media_thread_shared
    ON projection_thread_media(thread_id, shared_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_media_source
    ON projection_thread_media(source_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_media_backfill (
      source_kind TEXT PRIMARY KEY,
      next_rowid INTEGER NOT NULL,
      end_rowid INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_media_backfill (source_kind, next_rowid, end_rowid)
    SELECT 'message', 1, COALESCE(MAX(rowid), 0) FROM projection_thread_messages
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_media_backfill (source_kind, next_rowid, end_rowid)
    SELECT 'activity', 1, COALESCE(MAX(rowid), 0) FROM projection_thread_activities
  `;
});
