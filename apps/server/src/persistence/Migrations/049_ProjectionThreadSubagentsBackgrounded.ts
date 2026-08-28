import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Whether the provider runs a spawned agent in the background (its spawn
 *  returned without blocking the turn). NULL when the provider never said;
 *  0/1 otherwise. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_subagents ADD COLUMN is_backgrounded INTEGER`;
});
