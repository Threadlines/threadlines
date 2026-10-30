import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The pull requests whose row the user closed above a thread's composer, as a
 * JSON array of numbers; NULL means none. A nullable column added without a
 * default rewrites no row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "dismissed_pull_requests")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN dismissed_pull_requests TEXT
    `;
  }
});
