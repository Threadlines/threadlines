import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Workflow runs and who typed a message.
 *
 * - `projection_thread_workflow_runs`: one row per workflow run a thread's
 *   agent started (OrchestrationWorkflowRun), the run as JSON. A new table,
 *   nothing backfilled: older runs keep showing the way they did.
 * - `projection_thread_messages.composer`: see OrchestrationMessage.composer.
 *   Nullable with no default, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_workflow_runs (
      thread_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      run_json TEXT NOT NULL,
      event_sequence INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, task_id)
    )
  `;

  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_messages')`;
  if (!columns.some((entry) => entry.name === "composer")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN composer TEXT`;
  }
});
