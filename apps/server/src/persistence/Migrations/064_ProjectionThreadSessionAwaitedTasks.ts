import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The background tasks a session's agent is waiting on, as JSON (see
 * OrchestrationSession.awaitedBackgroundTasks), so the sidebar can say what a
 * waiting thread waits on. A constant default from the table definition, so no
 * row is rewritten; an empty list leaves an existing wait described as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "awaited_background_tasks")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN awaited_background_tasks TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
