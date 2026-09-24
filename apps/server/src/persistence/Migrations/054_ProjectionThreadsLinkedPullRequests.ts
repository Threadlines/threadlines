import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The pull requests a thread's agent opened on other branches, as a JSON
 * array. Every existing thread has none, and SQLite answers a column added
 * with a constant default from the table definition, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "linked_pull_requests")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linked_pull_requests TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
