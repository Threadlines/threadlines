import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Outside agents (docs/design/outside-agents.md): coding agents running
 * outside Threadlines that sign in to `/mcp/connect`.
 *
 * - `outside_agent_connections`: one approved sign-in.
 *   - The grant: `access` (see | start), `max_runtime_mode`, and
 *     `project_ids_json` (null: all projects). It is read on every call, so a
 *     Change applies to the next one.
 *   - The sign-in it came from: `client_id_hash`, `redirect_uri`, `resource`.
 *     A new approval for the same client id replaces the connection.
 *   - `token_generation`: the access token is `tlc1.<cid>.<gen>.<mac>`, with
 *     the mac recomputed from the server signing key. Nothing about the token
 *     is stored. Bumping the generation kills every token issued before.
 *   - `removed_at` / `removed_reason`: removed by the user, replaced, or
 *     unused for 90 days. A removed row refuses every token.
 * - `outside_agent_requests`: idempotency for `thread_start` and
 *   `thread_send`, keyed by the caller's `requestId` (or one the server made).
 *   `input_hash` tells a retry from a different call under the same id.
 *   `command_id` and `thread_id` are the derived ids the call dispatched;
 *   `state` is `starting` until it answers, then `done` with `result_json`.
 *   A row still `starting` after a restart was cut off: a retry answers
 *   `failed` naming the thread, never runs it again. Rows go 24 hours after
 *   `created_at`.
 * - `projection_threads.outside_origin_json`: see OutsideAgentRef
 *   (`outsideOrigin`).
 * - `projection_thread_messages.from_outside`: see OutsideAgentRef
 *   (`fromOutside`).
 *
 * New tables and nullable columns only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS outside_agent_connections (
      connection_id TEXT PRIMARY KEY,
      client_id_hash TEXT NOT NULL,
      client_name TEXT NOT NULL,
      software_id TEXT,
      redirect_uri TEXT NOT NULL,
      resource TEXT NOT NULL,
      access TEXT NOT NULL,
      max_runtime_mode TEXT NOT NULL,
      project_ids_json TEXT,
      token_generation INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      removed_at TEXT,
      removed_reason TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_outside_agent_connections_client
    ON outside_agent_connections(client_id_hash)
    WHERE removed_at IS NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS outside_agent_requests (
      connection_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      thread_id TEXT,
      command_id TEXT,
      state TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, request_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_outside_agent_requests_created
    ON outside_agent_requests(created_at)
  `;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!threadColumns.some((entry) => entry.name === "outside_origin_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN outside_origin_json TEXT`;
  }
  const messageColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_messages')`;
  if (!messageColumns.some((entry) => entry.name === "from_outside")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN from_outside TEXT`;
  }
});
