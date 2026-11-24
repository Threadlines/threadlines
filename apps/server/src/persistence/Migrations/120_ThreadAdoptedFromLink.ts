import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A thread another computer's agent started here becomes that agent's
 * thread's child when that thread moves here (docs/design/fleet.md, Part 3f,
 * (g)): `projection_threads.adopted_from_link_json` holds where it was
 * started from and whether it is still fenced
 * (`OrchestrationThread.adoptedFromLink`), null for every other thread.
 *
 * A new nullable column; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN adopted_from_link_json TEXT`;
});
