import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Agents' settings changes (docs/design/agent-settings-changes.md):
 * `projection_threads.settings_requests` (JSON) holds a thread's requests,
 * folded by the shared reducer (`@threadlines/shared/settingsChangeState`).
 * Nullable with no default, so no row is rewritten; null reads as none.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  if (!columns.some((column) => column.name === "settings_requests")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settings_requests TEXT`;
  }
});
