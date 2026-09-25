import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The thread's measured share of its checkout's uncommitted change, recorded
 * on a turn's final capture as JSON. Existing turns have no measurement, and a
 * nullable column added without a default rewrites no rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!columns.some((column) => column.name === "checkpoint_thread_diff_stat_json")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN checkpoint_thread_diff_stat_json TEXT
    `;
  }
});
