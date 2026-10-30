import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Scheduled tasks (docs/design/fleet.md, Part 6).
 *
 * - `scheduled_tasks`: each task's settings, its status and the next slot it
 *   runs at (`next_slot_utc`, a UTC instant; null for manual, paused,
 *   errored and done tasks), and the thread whose agent set it up
 *   (`origin_thread_id`, null for one a person made). `revision` goes up
 *   with every write, so a write made from an older read of the task (an
 *   edit, a slot claim) is refused instead of undoing the other.
 * - `scheduled_runs`: one row per slot a task was due at, unique on
 *   `(task_id, slot_utc)` and inserted in the same transaction that advances
 *   the task's next slot, so a slot runs at most once. A run that launches
 *   keeps a full snapshot of what it launches with (`launch_json`), so a
 *   resumed launch never reads the task as edited since; `stage` is how far
 *   its launch got. `finish_json` is what its agent said with
 *   `scheduled_run_finish`, applied when its turn ends.
 * - `scheduled_task_requests`: a change an agent asked to make to the tasks
 *   (create or update, with its whole payload), while it waits for the user
 *   and once answered. `participant_id` is the room agent that asked (null:
 *   the thread's own); `noted_at` is when that agent was told the answer.
 * - `projection_threads.scheduled_run_json`: see ThreadScheduledRun.
 *
 * New tables and a nullable column only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      project_id TEXT NOT NULL,
      checkout TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      cadence_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      target_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      next_slot_utc TEXT,
      origin_thread_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_runs (
      task_id TEXT NOT NULL,
      slot_utc TEXT NOT NULL,
      run_trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      reason TEXT,
      launch_json TEXT,
      thread_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      finish_json TEXT,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, slot_utc)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_open
    ON scheduled_runs(status)
    WHERE status IN ('launching', 'queued', 'started')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_thread
    ON scheduled_runs(thread_id)
    WHERE thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_requests (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      participant_id TEXT,
      action TEXT NOT NULL,
      task_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      noted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_requests_waiting
    ON scheduled_task_requests(created_at)
    WHERE status = 'waiting'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_requests_unnoted
    ON scheduled_task_requests(thread_id)
    WHERE status != 'waiting' AND noted_at IS NULL
  `;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!threadColumns.some((entry) => entry.name === "scheduled_run_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN scheduled_run_json TEXT`;
  }
});
