import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How many of a session's background tasks the agent is waiting on, as
 * opposed to ones meant to keep running. A constant default is stored in the
 * schema, so adding the column rewrites no rows. Zero rather than a copy of the
 * pending count: this runs on a server restart, which ends every Claude process
 * and the background tasks inside it, so any pending count on disk is stale.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "awaited_background_task_count")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN awaited_background_task_count INTEGER NOT NULL DEFAULT 0
    `;
  }
});
