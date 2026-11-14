import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whose worktree a thread works in when it is not its own
 * (ThreadWorktreeOrigin, docs/design/child-threads.md, "Workspaces"):
 * `worktree_origin_json` on `projection_threads`, null for every thread that
 * works in a worktree made for it or in the project folder.
 *
 * A new column only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN worktree_origin_json TEXT`;
});
