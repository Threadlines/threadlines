import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Receive before allow (docs/design/fleet.md, Part 3c): `staged_approval` on
 * `link_moves` is 1 when the asking computer sends a move's bytes before this
 * computer's user allows it, 0 for every move made before (and for asking
 * computers that don't).
 *
 * A new column with a constant default; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE link_moves ADD COLUMN staged_approval INTEGER NOT NULL DEFAULT 0`;
});
