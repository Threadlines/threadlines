import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An index for reading one turn's activities. The chat fetches an older
 * turn's steps by thread and turn (`ProjectionSnapshotQuery.getTurnActivities`)
 * when the reader scrolls back past the live feed's newest 500. With only the
 * thread-ordered indexes, each fetch walked every activity row of the thread
 * to find the turn's: on an install with 1.1M activities, a thread with 63k of
 * them took up to 7.7 s when its pages were not in the page cache. The SQLite
 * driver is synchronous, so the whole backend froze for that long: the server
 * logged "server froze", chats opened to an empty loading state, and the
 * desktop's socket dropped and reconnected.
 *
 * Its columns after the turn are the query's ORDER BY, so a turn reads in
 * order without a sort. `ANALYZE` gives the planner its statistics; without
 * them the shutdown `PRAGMA optimize` analyzes it itself (see migration 070).
 *
 * Building it reads the activity table once. Timed on a copy of a 5.5 GB
 * install with 1.1M activities: 5.7 s to 19.8 s, the slow end on a Mac under
 * heavy load. No existing row is rewritten. On that copy the planner picks it
 * for the by-turn read, and the thread-ordered reads keep their own indexes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_turn
    ON projection_thread_activities(thread_id, turn_id, event_sequence, sequence, created_at, activity_id)
  `;

  yield* sql`ANALYZE idx_projection_thread_activities_turn`;
});
