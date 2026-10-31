import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The assistants' event record (docs/design/assistants.md, "The event
 * record"). New tables only; the phone alert tables don't change.
 *
 * - `assistant_events`: one row per thing an assistant may hear about (a
 *   request, a turn, a side answer, a plan), keyed by `subject_key` (the
 *   push-alert keys: `approval:<id>`, `turn:<id>`, ...), so the same thing is
 *   never recorded twice. `state` is `settling` until `settle_until`, then
 *   `recorded` (with the next `seq`) or `dropped`. `resolved_at` and
 *   `resolved_reason` say when and why a recorded event stopped standing.
 *   `project_id` is set once the event is recorded; `added_at` is when the
 *   row came in (a row deferred again and again is looked at less often).
 * - `assistant_event_state`: the record's one row. `event_sequence` is how far
 *   through the orchestration event log it read (null while the record is
 *   off), saved with the rows that reading produced; `last_seq` the last
 *   `seq` given out, never reused; `pruned_through_seq` the highest `seq`
 *   pruned, so a cursor from before it reads as truncated; `record_id` names
 *   this record in cursors; `started_at` when it last turned on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_events (
      event_id TEXT PRIMARY KEY,
      subject_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      settle_until TEXT NOT NULL,
      seq INTEGER UNIQUE,
      name TEXT NOT NULL,
      reason TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT,
      occurred_at TEXT NOT NULL,
      added_at TEXT NOT NULL,
      recorded_at TEXT,
      resolved_at TEXT,
      resolved_reason TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS assistant_events_settling
    ON assistant_events (settle_until)
    WHERE state = 'settling'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS assistant_events_by_thread
    ON assistant_events (thread_id, state)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_event_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      event_sequence INTEGER,
      last_seq INTEGER NOT NULL,
      pruned_through_seq INTEGER NOT NULL,
      record_id TEXT NOT NULL,
      started_at TEXT
    )
  `;
});
