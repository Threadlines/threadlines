import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Assistants (docs/design/assistants.md): always-on assistants in someone
 * else's cloud reach this computer through the relay, as connections in the
 * same `outside_agent_connections` table as local agents.
 *
 * - `kind`: `local` (`/mcp/connect`) or `assistant` (the relay's door).
 * - `sign_in`: `oauth` (the approval dialog) or `key` (made in Settings).
 * - `identity_host`, `identity_verified`, `identity_known`: who an OAuth
 *   assistant signed in as, as far as the relay could tell.
 * - `host_id`, `route_tag`: the relay host and the route tag every
 *   credential of the connection carries.
 * - `refresh_generation`, `refresh_rotated_at`, `refresh_seen_generation`:
 *   the rotating refresh token's state (the newest generation issued, when,
 *   and the newest generation seen in use; -1 before any).
 * - `key_hash`: a key's secret, hashed under its own label.
 * - `relay_revoke_pending`: the relay still has to be told the connection
 *   was removed; retried until it is, across restarts.
 * - `outside_agent_requests(connection_id, thread_id)`: an assistant's
 *   `thread_read` of a thread still being set up finds its start.
 *
 * Columns with constant defaults or nullable, so no row is rewritten: local
 * rows read as `kind = 'local'`, `sign_in = 'oauth'`, nothing pending.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('outside_agent_connections')`;
  const has = (name: string) => columns.some((entry) => entry.name === name);

  if (!has("kind")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'`;
  }
  if (!has("sign_in")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN sign_in TEXT NOT NULL DEFAULT 'oauth'`;
  }
  if (!has("identity_host")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN identity_host TEXT`;
  }
  if (!has("identity_verified")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN identity_verified INTEGER`;
  }
  if (!has("identity_known")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN identity_known INTEGER`;
  }
  if (!has("host_id")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN host_id TEXT`;
  }
  if (!has("route_tag")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN route_tag TEXT`;
  }
  if (!has("refresh_generation")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN refresh_generation INTEGER`;
  }
  if (!has("refresh_rotated_at")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN refresh_rotated_at TEXT`;
  }
  if (!has("refresh_seen_generation")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN refresh_seen_generation INTEGER`;
  }
  if (!has("key_hash")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN key_hash TEXT`;
  }
  if (!has("relay_revoke_pending")) {
    yield* sql`
      ALTER TABLE outside_agent_connections
      ADD COLUMN relay_revoke_pending INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_outside_agent_connections_revoke_pending
    ON outside_agent_connections(connection_id)
    WHERE relay_revoke_pending = 1
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_outside_agent_requests_thread
    ON outside_agent_requests(connection_id, thread_id)
  `;
});
