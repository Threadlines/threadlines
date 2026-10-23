import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Event tasks (docs/design/event-tasks.md), after review:
 *
 * - `webhook_events.signature_checked`: whether the event's last check
 *   passed a signature (1) or the task checked none then (0). A replay keeps
 *   its original's, and is refused once the task checks a signature the
 *   original never had.
 * - `webhook_github_removals`: webhooks Threadlines added on GitHub and has
 *   to remove (the task moved to another repository, stopped being a GitHub
 *   task, or was deleted) but couldn't yet, with why. Removal is tried again
 *   until it works; the row outlives its task.
 *
 * A nullable column and a new table; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const eventColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('webhook_events')`;
  if (!eventColumns.some((entry) => entry.name === "signature_checked")) {
    yield* sql`ALTER TABLE webhook_events ADD COLUMN signature_checked INTEGER`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_github_removals (
      repository TEXT NOT NULL,
      hook_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository, hook_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_webhook_github_removals_task
    ON webhook_github_removals(task_id)
  `;
});
