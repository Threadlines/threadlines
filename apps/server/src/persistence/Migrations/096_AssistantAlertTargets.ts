import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Alerts to a web address (docs/design/assistants.md, "Build plan: step 4").
 * New tables only.
 *
 * - `assistant_targets`: one row per address. `kind` is `webhook` (step 5
 *   adds `subscription`, with its `connection_id` and `expires_at`).
 *   `names_json` the event names it takes; `project_ids_json` null for every
 *   project. `state`: `on`, `off` (the user), `gone` (the receiver answered
 *   410), `deleting` (Remove is under way; a start finishes it).
 *   `scanned_seq` is how far through the record it looked for events to
 *   send; `watermark` the highest `seq` at or below which every event is
 *   final for it, which a retrying event holds back. `refused_streak` counts
 *   401 and 403 answers in a row; the third sets `refused_since`. Its signing
 *   secret and Authorization value are in the secret store, never here;
 *   `authorization_secret` names the one entry holding its Authorization
 *   value (null: none). A new value goes in a new entry, and only this
 *   column moves the target to it, so the address and the credential sent
 *   to it always change together.
 * - `assistant_deliveries`: one row per event that matched, keyed by
 *   (`target_id`, `seq`). `state` is `pending`, `in_flight` (written before
 *   the call, so a crash mid-call is never sent again), `sent`, `dropped` or
 *   `failed`. `queued_at` starts its 24 hours.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_targets (
      target_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      connection_id TEXT,
      url TEXT NOT NULL,
      names_json TEXT NOT NULL,
      project_ids_json TEXT,
      skip_viewed INTEGER NOT NULL,
      authorization_secret TEXT,
      state TEXT NOT NULL,
      scanned_seq INTEGER NOT NULL,
      watermark INTEGER NOT NULL,
      refused_streak INTEGER NOT NULL DEFAULT 0,
      refused_since TEXT,
      last_sent_at TEXT,
      last_error TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_deliveries (
      target_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL,
      first_attempt_at TEXT,
      next_attempt_at TEXT NOT NULL,
      PRIMARY KEY (target_id, seq)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS assistant_deliveries_open
    ON assistant_deliveries (target_id, next_attempt_at)
    WHERE state IN ('pending', 'in_flight')
  `;
});
