import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A session's startup phase, as JSON (see OrchestrationSession.startup), so
 * the chat can say the agent's program is starting. Nullable with no default,
 * so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "startup")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN startup TEXT
    `;
  }
});
