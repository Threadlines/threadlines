import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A failure's usage limit and the wait to continue after it (see
 * OrchestrationSession.lastErrorUsageLimit and continueAtReset), and why
 * Threadlines wrote a message the user didn't type (OrchestrationMessage
 * .trigger). Nullable with no default, so no row is rewritten; the partial
 * index keeps the server's sweep for waiting threads to the few that wait.
 * `not_sent`: OrchestrationMessage.notSent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "last_error_usage_limit")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_usage_limit TEXT
    `;
  }
  if (!sessionColumns.some((column) => column.name === "continue_at_reset")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN continue_at_reset TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_continue_at_reset
    ON projection_thread_sessions(thread_id)
    WHERE continue_at_reset IS NOT NULL
  `;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "message_trigger")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN message_trigger TEXT
    `;
  }
  if (!messageColumns.some((column) => column.name === "not_sent")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN not_sent INTEGER
    `;
  }
});
