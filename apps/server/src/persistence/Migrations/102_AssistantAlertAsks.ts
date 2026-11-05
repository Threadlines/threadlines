import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * "Finished: only when I ask" for alert addresses (docs/design/assistants.md,
 * "Alerts when asked"). New defaulted column and a new table; no row is
 * rewritten.
 *
 * - `assistant_targets.finished_when_asked`: 1 sends a finished turn only if
 *   the user asked an agent to alert about it.
 * - `assistant_alert_asks`: the turns an agent was asked to alert about
 *   (`alert_assistants`), one row per thread and turn, kept 7 days like the
 *   record.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const targetColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('assistant_targets')`;
  if (!targetColumns.some((entry) => entry.name === "finished_when_asked")) {
    yield* sql`ALTER TABLE assistant_targets ADD COLUMN finished_when_asked INTEGER NOT NULL DEFAULT 0`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_alert_asks (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS assistant_alert_asks_asked_at
    ON assistant_alert_asks (asked_at)
  `;
});
