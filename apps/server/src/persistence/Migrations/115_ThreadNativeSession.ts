import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A moved thread's carried agent session (`OrchestrationThread.nativeSession`,
 * docs/design/fleet.md, Part 3d): `native_session` on `projection_threads` is
 * `carried`, `resumed`, `fell_back`, or null for every thread that moved
 * without one and every thread before.
 *
 * A new nullable column; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN native_session TEXT`;
});
