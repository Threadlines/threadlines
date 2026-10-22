import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Moving a thread to a linked computer (docs/design/fleet.md, Part 3).
 *
 * - `projection_threads.move_json`: on the computer it leaves, the move under
 *   way or done (OrchestrationThreadMove).
 * - `projection_threads.moved_from_json` and `history_seed_owed`: on the
 *   computer it arrives at, where it came from (ThreadMovedFrom) and whether
 *   its agent still has to be given the conversation.
 * - `projection_thread_messages.imported`: a message the move brought; every
 *   revert keeps it.
 * - `link_moves`: on the receiving computer, each move a linked computer
 *   offered, keyed by its link and transfer id, with how far its import got
 *   and what it owns (branch, worktree) until it commits or is cleaned up.
 *
 * New columns default to "none"; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`;
  const threadColumns = yield* columns("projection_threads");
  if (!threadColumns.some((entry) => entry.name === "move_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN move_json TEXT`;
  }
  if (!threadColumns.some((entry) => entry.name === "moved_from_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN moved_from_json TEXT`;
  }
  if (!threadColumns.some((entry) => entry.name === "history_seed_owed")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN history_seed_owed INTEGER NOT NULL DEFAULT 0`;
  }
  const messageColumns = yield* columns("projection_thread_messages");
  if (!messageColumns.some((entry) => entry.name === "imported")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN imported INTEGER NOT NULL DEFAULT 0`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS link_moves (
      link_device_id TEXT NOT NULL,
      transfer_id TEXT NOT NULL,
      transfer_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      stage TEXT,
      manifest_json TEXT NOT NULL,
      bytes_received INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      reason TEXT,
      cleaned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (link_device_id, transfer_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_link_moves_status ON link_moves(status)`;
});
