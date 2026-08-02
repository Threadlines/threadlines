import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "effective_cwd_source")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN effective_cwd_source TEXT
    `;
    // Every effective_cwd written before this column existed came from a
    // session.cwd.changed event, so backfill rather than leaving rows that
    // subagent inference would think it owns.
    yield* sql`
      UPDATE projection_threads
      SET effective_cwd_source = 'session'
      WHERE effective_cwd IS NOT NULL
    `;
  }
});
