import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Event tasks' hooks as this computer wants them at the relay
 * (docs/design/event-tasks.md, "Server side"). One row: the active hooks,
 * the last revision this computer used for a hook call, and the revision at
 * which the relay was last known to hold exactly that state. A state the
 * relay hasn't confirmed is sent again on every reconnect, so a retire made
 * while offline still reaches the relay. `minted_host_id` is the relay
 * identity the hooks belong to; `public_key` the hook key the relay seals
 * deliveries to.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS relay_hook_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      synced_revision INTEGER NOT NULL,
      active_json TEXT NOT NULL,
      minted_host_id TEXT,
      public_key TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
