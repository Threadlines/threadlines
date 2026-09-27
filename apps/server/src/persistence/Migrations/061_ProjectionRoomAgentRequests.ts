import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Room tools: requests one room agent makes of another.
 *
 * - `projection_threads.agent_requests`: open requests, the Stop hold and the
 *   limit's count, as JSON, or null for none.
 * - `projection_thread_messages.from_agent` (JSON), `request_id`,
 *   `request_kind`, `request_outcome`, `request_error` and `review_input`
 *   (JSON): a message an agent wrote, the request it belongs to, how and why
 *   that request ended, and what an independent review was given.
 *
 * Every column is nullable with no default, so no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((columns) => columns.some((entry) => entry.name === column)),
    );

  if (!(yield* hasColumn("projection_threads", "agent_requests"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN agent_requests TEXT`;
  }
  for (const column of [
    "from_agent",
    "request_id",
    "request_kind",
    "request_outcome",
    "request_error",
    "review_input",
  ]) {
    if (!(yield* hasColumn("projection_thread_messages", column))) {
      yield* sql.unsafe(`ALTER TABLE projection_thread_messages ADD COLUMN ${column} TEXT`);
    }
  }
});
