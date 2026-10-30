import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Partial indexes for the two activity kinds a thread keeps past its newest
 * 500 activities: prompts (approvals and user-input questions) and plan
 * updates. The thread snapshot (`ProjectionSnapshotQuery`) and the shell
 * summary refresh (`ProjectionPipeline`) look these up by kind, and with no
 * index on `kind` each lookup read every activity row of the thread, payload
 * pages included: about 1 s for a thread with 42k activities when the file was
 * not in the page cache, all of it on the event loop. Server startup paid it
 * once per room thread, and every chat open paid it again.
 *
 * Partial, so they hold only those rows: about 1.7k entries on a 3.1 GB install
 * with 647k activities. The prompt index's WHERE must stay the exact `IN` list,
 * in the same order, that the queries use: SQLite only picks a partial index
 * whose WHERE matches a query term exactly.
 *
 * `ANALYZE` gives the planner statistics for the new indexes. Without them the
 * shutdown `PRAGMA optimize` analyzed them itself and took about 6 s.
 *
 * Building them reads the activity table once. Timed on a 3.1 GB install with
 * 647k activities: 2.3 s with the file in the page cache, 10.7 s when it was
 * not. No existing row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_prompt_kinds
    ON projection_thread_activities(thread_id, event_sequence, sequence, created_at, activity_id)
    WHERE kind IN (
      'approval.requested', 'approval.resolved', 'provider.approval.respond.failed',
      'user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed'
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_plan_updates
    ON projection_thread_activities(thread_id, event_sequence, sequence, created_at, activity_id)
    WHERE kind = 'turn.plan.updated'
  `;

  yield* sql`ANALYZE idx_projection_thread_activities_prompt_kinds`;
  yield* sql`ANALYZE idx_projection_thread_activities_plan_updates`;
});
