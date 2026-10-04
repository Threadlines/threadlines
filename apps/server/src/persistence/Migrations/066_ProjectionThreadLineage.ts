import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Child threads (docs/design/child-threads.md): threads an agent starts.
 *
 * - `projection_threads.parent_thread_id`, `parent_turn_id`: the thread and
 *   turn whose agent started this one (lineage, set once).
 * - `attached_to_parent` (0/1) and `parent_attachment_epoch`: whether it is
 *   still in its parent's family, and how many times that changed.
 * - `handed_back_at`, `handed_back_turn_id`: its last answer that went back.
 * - `archived_with_parent_at`: archived by its parent's archive.
 * - `child_requests` (JSON): on a parent, its open requests, limits and notes.
 * - `projection_thread_messages.from_thread` (JSON): a message another
 *   thread's agent wrote (a request into a child, a report into a parent).
 *
 * Every column is nullable with no default, so no row is rewritten. The index
 * serves "this thread's children", read when a family is decided or shown.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((columns) => columns.some((entry) => entry.name === column)),
    );

  for (const [column, type] of [
    ["parent_thread_id", "TEXT"],
    ["parent_turn_id", "TEXT"],
    ["attached_to_parent", "INTEGER"],
    ["parent_attachment_epoch", "INTEGER"],
    ["handed_back_at", "TEXT"],
    ["handed_back_turn_id", "TEXT"],
    ["archived_with_parent_at", "TEXT"],
    ["child_requests", "TEXT"],
  ] as const) {
    if (!(yield* hasColumn("projection_threads", column))) {
      yield* sql.unsafe(`ALTER TABLE projection_threads ADD COLUMN ${column} ${type}`);
    }
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent
    ON projection_threads(parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
  if (!(yield* hasColumn("projection_thread_messages", "from_thread"))) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN from_thread TEXT`;
  }
});
