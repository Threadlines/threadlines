import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repair legacy projections where the provider session stopped without a
 * matching turn completion event. ProjectionPipeline applies the same rule to
 * new session events; this migration brings already-materialized rows in line
 * with that event-sourced behavior.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_turns
    SET
      state = 'interrupted',
      requested_at = COALESCE(
        requested_at,
        (
          SELECT sessions.updated_at
          FROM projection_thread_sessions AS sessions
          WHERE sessions.thread_id = projection_turns.thread_id
        )
      ),
      started_at = COALESCE(
        started_at,
        (
          SELECT sessions.updated_at
          FROM projection_thread_sessions AS sessions
          WHERE sessions.thread_id = projection_turns.thread_id
        )
      ),
      completed_at = COALESCE(
        completed_at,
        (
          SELECT sessions.updated_at
          FROM projection_thread_sessions AS sessions
          WHERE sessions.thread_id = projection_turns.thread_id
        )
      )
    WHERE state = 'running'
      AND EXISTS (
        SELECT 1
        FROM projection_threads AS threads
        JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.thread_id = projection_turns.thread_id
          AND threads.latest_turn_id = projection_turns.turn_id
          AND sessions.status = 'stopped'
      )
  `;
});
