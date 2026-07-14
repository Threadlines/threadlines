import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep the full-text index external to the canonical projection table so
  // projection rebuilds and deletes continue to have a single source of
  // truth. Trigrams preserve the command palette's substring-search feel.
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_messages_fts
    USING fts5(
      thread_id UNINDEXED,
      text,
      content = 'projection_thread_messages',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    )
  `;

  // Streaming messages can update many times per second. Index them once at
  // completion instead of re-tokenizing a growing response for every delta.
  yield* sql`
    INSERT INTO projection_thread_messages_fts (rowid, thread_id, text)
    SELECT rowid, thread_id, text
    FROM projection_thread_messages
    WHERE is_streaming = 0
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_insert
    AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_fts (rowid, thread_id, text)
      VALUES (new.rowid, new.thread_id, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_delete
    AFTER DELETE ON projection_thread_messages
    WHEN old.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_fts (
        projection_thread_messages_fts,
        rowid,
        thread_id,
        text
      )
      VALUES ('delete', old.rowid, old.thread_id, old.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_completed_update
    AFTER UPDATE ON projection_thread_messages
    WHEN old.is_streaming = 0 AND new.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_fts (
        projection_thread_messages_fts,
        rowid,
        thread_id,
        text
      )
      VALUES ('delete', old.rowid, old.thread_id, old.text);

      INSERT INTO projection_thread_messages_fts (rowid, thread_id, text)
      VALUES (new.rowid, new.thread_id, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_stream_completed
    AFTER UPDATE ON projection_thread_messages
    WHEN old.is_streaming != 0 AND new.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_fts (rowid, thread_id, text)
      VALUES (new.rowid, new.thread_id, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_stream_reopened
    AFTER UPDATE ON projection_thread_messages
    WHEN old.is_streaming = 0 AND new.is_streaming != 0
    BEGIN
      INSERT INTO projection_thread_messages_fts (
        projection_thread_messages_fts,
        rowid,
        thread_id,
        text
      )
      VALUES ('delete', old.rowid, old.thread_id, old.text);
    END
  `;
});
