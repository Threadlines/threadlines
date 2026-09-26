import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rooms: side answers, and what each agent's conversation has been told.
 *
 * - `projection_threads.side_turn`: the side answer in progress, as JSON, or
 *   null.
 * - `projection_threads.room_context`: per agent, the delivered-context
 *   cursor its next catch-up note starts from, as a JSON object.
 * - `projection_thread_messages.side_turn_id` and
 *   `projection_thread_activities.side_turn_id`: the side answer a question,
 *   answer, or step belongs to.
 * - `projection_thread_activities.participant_id`: the room agent that took
 *   the step.
 *
 * Every existing row belongs to no side answer, and SQLite answers a column
 * added with a constant default from the table definition, so no row is
 * rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((columns) => columns.some((entry) => entry.name === column)),
    );

  if (!(yield* hasColumn("projection_threads", "side_turn"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN side_turn TEXT`;
  }
  if (!(yield* hasColumn("projection_threads", "room_context"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN room_context TEXT NOT NULL DEFAULT '{}'
    `;
  }
  if (!(yield* hasColumn("projection_thread_messages", "side_turn_id"))) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN side_turn_id TEXT`;
  }
  if (!(yield* hasColumn("projection_thread_activities", "side_turn_id"))) {
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN side_turn_id TEXT`;
  }
  if (!(yield* hasColumn("projection_thread_activities", "participant_id"))) {
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN participant_id TEXT`;
  }
});
