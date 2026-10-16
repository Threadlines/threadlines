import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Threads no longer follow an isolated subagent's checkout: only the thread's
 * own agent moves it. Rows a subagent guess left behind would otherwise keep
 * pointing every surface (room tools, source control, the PR watch) at the
 * helper's worktree until the session next started.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_threads
    SET effective_cwd = NULL, effective_cwd_source = NULL
    WHERE effective_cwd_source = 'subagent'
  `;
});
