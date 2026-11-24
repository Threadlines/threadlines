import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Drop six unused or redundant SQLite indexes to cut write amplification on
 * event append, message streaming, and activity projection:
 *
 * - `idx_orch_events_command_id` and `idx_orch_events_correlation_id`: no
 *   query filters `orchestration_events` by `command_id` or `correlation_id`
 *   (command idempotency reads `orchestration_command_receipts` by primary key).
 * - `idx_projection_thread_activities_thread_created`,
 *   `idx_projection_thread_activities_thread_sequence`, and
 *   `idx_projection_thread_activities_thread_sequence_created_id`: superseded
 *   by `idx_projection_thread_activities_event_order` (migration 050), the
 *   partial kind indexes (migration 070), and the turn index (migration 099).
 * - `idx_projection_thread_messages_thread_created`: strict left prefix of
 *   `idx_projection_thread_messages_thread_created_id` (migration 029).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_created`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence_created_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created`;
});
