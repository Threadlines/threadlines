import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  // Existing rows default to 0, which means "count every turn" -- the rollup
  // behaves exactly as it did before the baseline existed until a clean
  // checkout is observed and `thread.diffstat-rebased` moves it forward.
  if (!columns.some((column) => column.name === "diff_stat_baseline_turn_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN diff_stat_baseline_turn_count INTEGER NOT NULL DEFAULT 0
    `;
  }
});
