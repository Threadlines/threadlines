import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Child-thread access ceilings and loose-thread stop tracking
 * (docs/design/agent-autonomy-no-limits.md, "Access" and "Stop"):
 * - `projection_thread_messages.request_ceiling` (JSON `LeadPassCeiling`) and
 *   `pass_blocked` (1 or null): kept on the message so a continue or retry
 *   after a restart holds the same access ceiling.
 * - `projection_threads.stops_with_parent` (1 or null): a thread started
 *   without report back stays in its starter's Stop reach until a person
 *   writes in it or puts it back.
 *
 * Nullable columns with no defaults; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const messageColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_messages')
  `;
  if (!messageColumns.some((column) => column.name === "request_ceiling")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN request_ceiling TEXT`;
  }
  if (!messageColumns.some((column) => column.name === "pass_blocked")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN pass_blocked INTEGER`;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  if (!threadColumns.some((column) => column.name === "stops_with_parent")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN stops_with_parent INTEGER`;
  }
});
