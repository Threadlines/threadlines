import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rooms: agents added to a thread next to its own agent.
 *
 * - `projection_threads.participants`: the added agents, as a JSON array.
 * - `projection_thread_sessions.participant_id`: which agent holds the
 *   thread's session slot. Null is the thread's own agent.
 * - `projection_thread_messages.participant_id`: the author of an assistant
 *   message, or the agent a user message was addressed to.
 *
 * Every existing thread is an ordinary thread, and SQLite answers a column
 * added with a constant default from the table definition, so no row is
 * rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((columns) => columns.some((entry) => entry.name === column)),
    );

  if (!(yield* hasColumn("projection_threads", "participants"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN participants TEXT NOT NULL DEFAULT '[]'
    `;
  }
  if (!(yield* hasColumn("projection_thread_sessions", "participant_id"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN participant_id TEXT
    `;
  }
  if (!(yield* hasColumn("projection_thread_messages", "participant_id"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN participant_id TEXT
    `;
  }
});
