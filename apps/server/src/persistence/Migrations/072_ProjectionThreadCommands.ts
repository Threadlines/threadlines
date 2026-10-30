import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Suggested commands (docs/terminal-command-runs.md): the requests agents made
 * with `ask_user_to_run`, and the runs the user started from a request card or
 * a code block. Each row keeps its read model as JSON; a run's output, which
 * only the server reads, sits in a column of its own. New tables, nothing
 * backfilled.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_command_requests (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      event_sequence INTEGER,
      request_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, request_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_command_runs (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_sequence INTEGER,
      run_json TEXT NOT NULL,
      output TEXT,
      PRIMARY KEY (thread_id, run_id)
    )
  `;
});
