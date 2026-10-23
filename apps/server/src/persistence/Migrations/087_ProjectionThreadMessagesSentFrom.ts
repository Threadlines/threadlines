import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `projection_thread_messages.sent_from`: see OrchestrationMessage.sentFrom,
 * the device as JSON. Nullable with no default, so no row is rewritten:
 * messages recorded before it was kept show no device.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_messages')`;
  if (!columns.some((entry) => entry.name === "sent_from")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN sent_from TEXT`;
  }
});
