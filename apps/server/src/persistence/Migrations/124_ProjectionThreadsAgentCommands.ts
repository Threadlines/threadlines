import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Adds `agent_commands`: per agent, the slash commands its session last listed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "agent_commands")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN agent_commands TEXT
    `;
  }
});
