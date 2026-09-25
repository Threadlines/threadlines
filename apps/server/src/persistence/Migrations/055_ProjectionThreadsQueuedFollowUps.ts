import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Messages waiting for a thread's running turn to finish, as a JSON array.
 * Every existing thread has none, and SQLite answers a column added with a
 * constant default from the table definition, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "queued_follow_ups")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN queued_follow_ups TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
