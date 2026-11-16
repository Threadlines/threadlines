import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Why a move held for this computer's user was dropped, as a code the asking
 * computer reads (`PeerMoveState.abortCode`, docs/design/fleet.md, Part 3c):
 * `abort_code` on `link_moves` is `denied` (Don't allow), `expired` (nobody
 * allowed it in time), or null for any other drop and every move before.
 *
 * A new nullable column; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE link_moves ADD COLUMN abort_code TEXT`;
});
