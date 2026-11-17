import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The turn the user asked to stop (`OrchestrationSession.stopRequestedTurnId`,
 * docs/design/lead-chat.md, "Rulings after the third review"): a usage limit
 * failure that lands after Stop never arms "Continue at reset" for it.
 *
 * A new nullable column; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN stop_requested_turn_id TEXT`;
});
