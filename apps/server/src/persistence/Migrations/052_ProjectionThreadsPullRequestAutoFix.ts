import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Whether the server watches this thread's pull request and starts a turn when
 * a check fails or a review comment arrives. Off for every existing thread, so
 * the column's default is the whole migration: no rows are rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "pull_request_auto_fix")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pull_request_auto_fix INTEGER NOT NULL DEFAULT 0
    `;
  }
});
