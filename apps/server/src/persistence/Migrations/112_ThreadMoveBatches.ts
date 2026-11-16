import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Moving several threads at once (docs/design/fleet.md, Part 3c):
 *
 * - `thread_move_batches`: one row per `moves.queueMany`, with every thread
 *   asked for (and the queued move each got) and the refusals given at queue
 *   time, so `moves.batchStatus` can answer for all of them later.
 * - `last_move_outcome_json` on `projection_threads`: how the thread's last
 *   move went (ThreadMoveOutcome), null for every thread until it tries.
 *
 * A new table and a new column only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_move_batches (
      batch_id TEXT PRIMARY KEY,
      target_environment_id TEXT NOT NULL,
      target_label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      members_json TEXT NOT NULL,
      refused_json TEXT NOT NULL
    )
  `;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN last_move_outcome_json TEXT`;
});
