import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Covering index for the only queries that look up thread events by type:
 * storage maintenance's deleted-thread and activity-cap scans (see
 * `StorageMaintenance.ts`, which names it with `INDEXED BY`). Without it
 * each scan read every thread event's row, about 900 MB on a 3 GB install,
 * in one synchronous statement: 7 s right after a restart there, long enough
 * for clients to drop the socket as dead.
 *
 * Partial, so it only holds those two event types: about 12 MB for 160k
 * activity events. `aggregate_kind` is a column as well as in the WHERE so
 * the scans stay index-only on SQLite builds older than 3.44, which do not
 * read a partial index's constant columns from its WHERE (Bun can run on the
 * system SQLite). Building it reads the event table once. Timed on a 2.9 GB
 * install with 610k events: 0.3-0.7 s with the file in the page cache, about
 * 5 s when it was not. No existing row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_thread_maintenance
    ON orchestration_events(aggregate_kind, event_type, stream_id, sequence)
    WHERE aggregate_kind = 'thread'
      AND (event_type = 'thread.deleted' OR event_type = 'thread.activity-appended')
  `;
});
