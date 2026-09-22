import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How the server merges this thread's pull request once its checks pass, or
 * null while it has not been asked. Null for every existing thread, so the
 * column's default is the whole migration: no rows are rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "pull_request_auto_merge")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pull_request_auto_merge TEXT
    `;
  }
});
