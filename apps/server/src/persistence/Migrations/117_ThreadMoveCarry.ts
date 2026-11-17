import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A thread moves with what it had going (docs/design/fleet.md, Part 3e):
 *
 * - `move_restore_owed_json` on `projection_threads`: what a move that didn't
 *   happen owes the thread back (`OrchestrationThread.moveRestoreOwed`), null
 *   once paid and for every thread before;
 * - `after_move` on `projection_thread_messages`: 1 on a message Threadlines
 *   wrote for the agent when the thread moved or its move didn't happen
 *   (`OrchestrationMessage.afterMove`), null on every other.
 *
 * New nullable columns; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN move_restore_owed_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN after_move INTEGER`;
});
