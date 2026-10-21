import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Unlinks that still owe stops (docs/design/fleet.md, Rev 4 "Unlink").
 *
 * - `link_stops_owed`: an inbound link being unlinked, whose threads must all
 *   stop. Written once its access is turned off, and deleted once a pass
 *   after its session ended found nothing it started still at work, so a
 *   failure or a restart in between is tried again until that holds.
 *   Every new obligation (a retry that fell short, too) bumps `generation`;
 *   a pass clears only the generation it read before it ran, so an
 *   obligation recorded meanwhile is never lost.
 *
 * A new table only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS link_stops_owed (
      link_device_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_error TEXT
    )
  `;
});
