import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Rooms: an added agent promoted to be the room's main agent
 * (`projection_threads.main_participant_id`, null when the thread's own agent
 * is main). A nullable column with no default, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!columns.some((entry) => entry.name === "main_participant_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN main_participant_id TEXT`;
  }
});
