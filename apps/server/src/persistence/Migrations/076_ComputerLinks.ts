import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Computer links (docs/design/fleet.md, Parts 1 and 2).
 *
 * - `relay_invites`: invites this server made, with the purpose it set
 *   (`device` or `computer-link`). The claim key stays in memory.
 * - `relay_devices.access_grant`: the role the device's session gets
 *   (`client` or `peer`), copied from its verified invite when the row is
 *   inserted, before any session exists. Approval and restart recovery read
 *   the role from here only, never from what the joiner said it was.
 *   `link_access`, `link_max_runtime_mode`, `link_environment_id` and
 *   `link_last_used_at` are an inbound link's settings and bookkeeping.
 * - `computer_links`: this server's own links to other computers (it is a
 *   device there; its keys live in the server secret store).
 * - `link_requests`: on the child's computer, every start and send another
 *   computer's agent asked for, with its whole payload and the ids reserved
 *   for it, so each stage resumes after a crash. Inserting the row is the
 *   dedupe; a cancel that arrives first leaves a `cancelled` tombstone.
 *   `cleanup` is what a cancel still owes the thread (take its message back,
 *   or that and stop the thread), written with the cancel and cleared once
 *   done, so a restart in between finishes it.
 * - `projection_threads.remote_origin_json`: see ThreadRemoteOrigin.
 *
 * New tables and nullable or defaulted columns only; no row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS relay_invites (
      invite_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_by TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  const deviceColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('relay_devices')`;
  const hasDeviceColumn = (name: string) => deviceColumns.some((entry) => entry.name === name);
  if (!hasDeviceColumn("access_grant")) {
    yield* sql`ALTER TABLE relay_devices ADD COLUMN access_grant TEXT NOT NULL DEFAULT 'client'`;
  }
  if (!hasDeviceColumn("link_access")) {
    yield* sql`ALTER TABLE relay_devices ADD COLUMN link_access TEXT`;
  }
  if (!hasDeviceColumn("link_max_runtime_mode")) {
    yield* sql`ALTER TABLE relay_devices ADD COLUMN link_max_runtime_mode TEXT`;
  }
  if (!hasDeviceColumn("link_environment_id")) {
    yield* sql`ALTER TABLE relay_devices ADD COLUMN link_environment_id TEXT`;
  }
  if (!hasDeviceColumn("link_last_used_at")) {
    yield* sql`ALTER TABLE relay_devices ADD COLUMN link_last_used_at TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS computer_links (
      link_id TEXT PRIMARY KEY,
      remote_environment_id TEXT NOT NULL,
      remote_label TEXT NOT NULL,
      remote_platform TEXT,
      relay_origin TEXT NOT NULL,
      host_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      host_public_key TEXT NOT NULL,
      direct_routes_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_connected_at TEXT,
      last_error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_computer_links_remote_environment
    ON computer_links(remote_environment_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS link_requests (
      link_device_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      candidate_turn_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT,
      report_id TEXT,
      report_outcome TEXT,
      report_text TEXT,
      report_turn_id TEXT,
      report_error TEXT,
      settled_at TEXT,
      delivered_at TEXT,
      cleanup TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (link_device_id, request_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_link_requests_thread
    ON link_requests(thread_id)
    WHERE thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_link_requests_undelivered
    ON link_requests(link_device_id, delivered_at)
  `;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!threadColumns.some((entry) => entry.name === "remote_origin_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN remote_origin_json TEXT`;
  }
});
