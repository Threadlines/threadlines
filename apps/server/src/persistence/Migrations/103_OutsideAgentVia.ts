import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Outside agents on other computers (docs/design/assistants.md, "Other
 * computers"): an agent connected on a linked computer, let in here by this
 * computer's user, is a row of `outside_agent_connections` with `sign_in =
 * 'linked'` and these columns set. It holds no credential here: the link's
 * calls bring it.
 *
 * - `via_link_device_id`: the inbound link (relay device) its calls come over;
 * - `via_environment_id`, `via_computer`: that computer, and its name;
 * - `via_connection_id`: its connection there.
 *
 * Nullable columns, so no row is rewritten. At most one live row per link
 * and connection there.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('outside_agent_connections')`;
  const has = (name: string) => columns.some((entry) => entry.name === name);
  if (!has("via_link_device_id")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN via_link_device_id TEXT`;
  }
  if (!has("via_environment_id")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN via_environment_id TEXT`;
  }
  if (!has("via_connection_id")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN via_connection_id TEXT`;
  }
  if (!has("via_computer")) {
    yield* sql`ALTER TABLE outside_agent_connections ADD COLUMN via_computer TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outside_agent_connections_via
    ON outside_agent_connections(via_link_device_id, via_connection_id)
    WHERE removed_at IS NULL AND via_link_device_id IS NOT NULL
  `;
});
