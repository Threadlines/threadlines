import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rooms: the user's name for the thread's own agent
 * (`projection_threads.agent_role`, null for none). Added agents keep theirs
 * in the `participants` JSON. A nullable column with no default, so no row is
 * rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!columns.some((entry) => entry.name === "agent_role")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN agent_role TEXT`;
  }
});
