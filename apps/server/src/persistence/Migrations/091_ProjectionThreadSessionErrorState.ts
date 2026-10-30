import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * When the session's failure happened and when the user closed its notice
 * (see OrchestrationSession.lastErrorAt and lastErrorDismissedAt). Nullable
 * with no default, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "last_error_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_at TEXT
    `;
  }
  if (!columns.some((column) => column.name === "last_error_dismissed_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_dismissed_at TEXT
    `;
  }
});
