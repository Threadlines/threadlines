import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A move waiting for its thread to be free (ThreadPendingMove,
 * docs/design/fleet.md, Part 3b): `pending_move_json` on
 * `projection_threads`, null for every thread without one.
 *
 * A new column only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN pending_move_json TEXT`;
});
