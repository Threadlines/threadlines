import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Setting up a project copied from another computer (docs/design/fleet.md,
 * Part 8). `project_setups` keeps each job's non-secret request (to retry
 * it), the ids it will use, its staging folder and how far it got, so a
 * restart either finishes a published copy or deletes an unpublished one.
 * The files' bytes are never stored.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_setups (
      setup_id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      staging_path TEXT,
      adopted INTEGER NOT NULL DEFAULT 0,
      clone_url TEXT,
      stage TEXT NOT NULL,
      project_id TEXT NOT NULL,
      create_command_id TEXT NOT NULL,
      scripts_command_id TEXT NOT NULL,
      error TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
