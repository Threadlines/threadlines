import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Messages keep the agents they name as those agents were when they were
 * written, so a later model or reasoning change does not rename them.
 *
 * - `projection_thread_messages.agent_models` (JSON): see
 *   OrchestrationMessage.agentModels. Null on every existing row: those keep
 *   being named the way they were before.
 * - `projection_threads.sent_models` (JSON): per agent, the model its last
 *   turn was sent with (OrchestrationThread.sentModels).
 *
 * One column is nullable with no default and the other takes a constant
 * default from the table definition, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((columns) => columns.some((entry) => entry.name === column)),
    );

  if (!(yield* hasColumn("projection_thread_messages", "agent_models"))) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN agent_models TEXT`;
  }
  if (!(yield* hasColumn("projection_threads", "sent_models"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sent_models TEXT NOT NULL DEFAULT '{}'
    `;
  }
});
