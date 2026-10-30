import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Event tasks (docs/design/event-tasks.md): scheduled tasks that start when
 * an outside service sends a webhook.
 *
 * - `scheduled_task_webhooks`: an event task's address. `hook_id` and
 *   `relay_url` are its current relay hook (null while it waits for the
 *   relay), `minted_host_id` the relay identity it was minted under,
 *   `local_token` the secret half of its address on this computer's own port,
 *   `kept_headers_json` the headers its hook keeps beyond the usual ones.
 *   `github_*` is the webhook Threadlines set up on GitHub for it, as GitHub
 *   has it now (the address, events and secret generation it was given), so a
 *   change since is sent to GitHub until GitHub takes it. `address_changed`:
 *   the computer got a new relay identity and the task a new address.
 * - `webhook_hooks`: every relay hook a task had. A rotated or retired hook
 *   keeps its row (and so its task) for 25 hours after `retired_at`, so a
 *   delivery it accepted before retiring still finds its task.
 * - `webhook_secrets`: a task's signing secret generations; the secrets
 *   themselves live in the server's secret store. An event verifies against
 *   every generation not retired more than 24 hours before it arrived.
 * - `webhook_events`: the queue and the log in one table, by `status`
 *   (received and waiting are the queue). `body` is the raw body, so a
 *   signature can be checked over the exact bytes; `verified` is whether its
 *   signature passed (or the task checks none), null until checked;
 *   `signature_checked` whether that check was a signature (1) or the task
 *   checked none then (0): a replay keeps its original's, and is refused once
 *   the task checks a signature the original never had.
 * - `webhook_github_removals`: webhooks Threadlines added on GitHub and has
 *   to remove (the task moved to another repository, stopped being a GitHub
 *   task, or was deleted) but couldn't yet, with why. Removal is tried again
 *   until it works; the row outlives its task.
 * - `webhook_seen`: the duplicate check's record of events that ran, kept 7
 *   days whatever happens to the log.
 * - `scheduled_webhook_subjects`: "the same issue continues its thread": the
 *   thread an issue or pull request runs in, null while its first run, the
 *   one in `reserved_by_run`, starts it; `project_id` is the task's project
 *   when it was claimed, so a moved task starts fresh threads.
 * - `scheduled_runs.event_id`: the event an event task's run is for, at most
 *   one run each.
 *
 * New tables and a nullable column only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_webhooks (
      task_id TEXT PRIMARY KEY,
      hook_id TEXT,
      relay_url TEXT,
      minted_host_id TEXT,
      local_token TEXT NOT NULL,
      kept_headers_json TEXT NOT NULL,
      github_hook_id TEXT,
      github_repository TEXT,
      github_hook_url TEXT,
      github_events_json TEXT,
      github_secret_generation INTEGER,
      address_changed INTEGER NOT NULL DEFAULT 0,
      last_event_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_hooks (
      hook_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_webhook_hooks_task ON webhook_hooks(task_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_secrets (
      task_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (task_id, generation)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      source TEXT NOT NULL,
      replay_of TEXT,
      method TEXT NOT NULL,
      query TEXT NOT NULL,
      headers_json TEXT NOT NULL,
      body BLOB NOT NULL,
      body_truncated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      reason TEXT,
      verified INTEGER,
      signature_checked INTEGER,
      event_name TEXT,
      subject TEXT,
      sender TEXT,
      summary TEXT,
      dedupe_hash TEXT,
      missing_fields_json TEXT,
      run_slot_utc TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_task
    ON webhook_events(task_id, status, received_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_log
    ON webhook_events(task_id, received_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_queued
    ON webhook_events(task_id)
    WHERE status IN ('received', 'waiting')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_seen (
      task_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (task_id, key_hash)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_webhook_subjects (
      task_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      reserved_by_run TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, subject)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_github_removals (
      repository TEXT NOT NULL,
      hook_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository, hook_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_webhook_github_removals_task
    ON webhook_github_removals(task_id)
  `;

  const runColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('scheduled_runs')`;
  if (!runColumns.some((entry) => entry.name === "event_id")) {
    yield* sql`ALTER TABLE scheduled_runs ADD COLUMN event_id TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_runs_event
    ON scheduled_runs(task_id, event_id)
    WHERE event_id IS NOT NULL
  `;
});
