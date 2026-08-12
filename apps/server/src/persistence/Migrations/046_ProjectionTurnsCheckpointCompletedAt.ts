import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Checkpoint capture time and turn completion time describe different
 * lifecycle boundaries. A provider can publish several checkpoint summaries
 * while its turn is still running, so they cannot share one nullable column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN checkpoint_completed_at TEXT
  `;

  yield* sql`
    UPDATE projection_turns
    SET checkpoint_completed_at = completed_at
    WHERE checkpoint_turn_count IS NOT NULL
  `;
});
