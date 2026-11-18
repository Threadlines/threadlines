import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Families that move together (docs/design/fleet.md, Part 3f, (g)): on the
 * receiving computer, `link_moves.family_id` is the family's key here (from
 * the link and the family's id) and `source_thread_id` the thread's id on the
 * computer it left, so a child's import can find its parent's and wait for it
 * to commit, and a member in another's folder can find that folder's owner.
 * Null for every move made before, and for a thread that moves on its own.
 *
 * New nullable columns and an index; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('link_moves')
  `;
  if (!columns.some((entry) => entry.name === "family_id")) {
    yield* sql`ALTER TABLE link_moves ADD COLUMN family_id TEXT`;
  }
  if (!columns.some((entry) => entry.name === "source_thread_id")) {
    yield* sql`ALTER TABLE link_moves ADD COLUMN source_thread_id TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_link_moves_family
    ON link_moves(family_id, source_thread_id)
  `;
});
