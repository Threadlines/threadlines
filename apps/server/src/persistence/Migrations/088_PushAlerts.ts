import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Phone alerts (docs/design/push-alerts.md). New tables only.
 *
 * - `push_registrations`: per paired phone (relay device), the keys this
 *   computer seals its alerts with. The endpoint itself lives at the relay.
 * - `push_alert_cursor`: how far through the orchestration event log alerts
 *   were looked for, saved with the alerts that reading produced.
 * - `push_alerts`: one row per thing worth an alert (an approval, a finished
 *   turn, ...), keyed so the same thing never alerts twice; a row born
 *   `dropped` stands for "never alert this one".
 * - `push_alert_deliveries`: one per alert and phone, with its retries.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS push_registrations (
      device_id TEXT PRIMARY KEY,
      registration_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      key_id TEXT NOT NULL,
      app_origin TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS push_alert_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS push_alerts (
      alert_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      detail TEXT,
      state TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS push_alerts_pending ON push_alerts (state, due_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS push_alerts_by_thread ON push_alerts (thread_id, state)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS push_alert_deliveries (
      alert_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      registration_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      PRIMARY KEY (alert_id, device_id)
    )
  `;
});
