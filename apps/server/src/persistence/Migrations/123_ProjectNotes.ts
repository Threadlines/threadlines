import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Project notes (docs/design/project-brief-notes.md): notes agents and the
 * user keep for later threads, and agents' notes waiting for the user. A
 * suggestion is never updated, only deleted, so Keep keeps exactly the text
 * the user read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      text TEXT NOT NULL,
      approved INTEGER NOT NULL,
      writer_ceiling_json TEXT,
      author_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS project_notes_title
    ON project_notes (project_id, title)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_note_suggestions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      text TEXT NOT NULL,
      author_json TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS project_note_suggestions_thread
    ON project_note_suggestions (thread_id)
  `;
});
