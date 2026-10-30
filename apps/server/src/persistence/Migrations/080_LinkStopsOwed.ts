import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What an unlink still owes (docs/design/fleet.md, Rev 4 "Unlink"), so a
 * failure or a restart part way is finished later.
 *
 * - `link_drains_owed`: an inbound link being unlinked (its access already
 *   off) still owes a full pass over what it started: cancel its open
 *   requests and stop its threads at work. Deleted once a pass after its
 *   session ended got through. Every new obligation (a pass that fell short,
 *   too) bumps `generation`; a pass clears only the generation it read
 *   before it ran, so one recorded meanwhile is never lost.
 * - `link_thread_stops_owed`: a thread such a pass found at work, on the
 *   turn it was at (`turn_key`). The stop was asked for; the row goes once
 *   the thread is seen stopped (or on to a later turn, which the link
 *   couldn't have started), and until then the stop is asked for again.
 *
 * New tables only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS link_drains_owed (
      link_device_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_error TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS link_thread_stops_owed (
      link_device_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (link_device_id, thread_id)
    )
  `;
});
