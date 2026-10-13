import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent pages (OrchestrationAgentPage): one row per page per turn that showed
 * it. A new table, nothing backfilled.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_pages (
      thread_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      participant_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      height INTEGER NOT NULL,
      heights_json TEXT,
      icon TEXT,
      share_url TEXT,
      placement_sequence INTEGER,
      event_sequence INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, page_id, turn_id)
    )
  `;
});
