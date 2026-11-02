import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Which known assistant an assistant connection is (contracts'
 * KnownAssistant), as the user picked it. A new nullable column; no row is
 * rewritten.
 *
 * - `outside_agent_connections.assistant_pick`: the known assistant's id, or
 *   `none` for "none of these". Null: not picked, so Threadlines' guess from
 *   the sign-in stands (knownAssistants.ts).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('outside_agent_connections')`;
  if (!columns.some((entry) => entry.name === "assistant_pick")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN assistant_pick TEXT`;
  }
});
