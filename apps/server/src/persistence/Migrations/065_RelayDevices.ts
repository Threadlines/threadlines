import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * "Connect a device" (relay v2). `relay_host` is this server's registration
 * with the relay (the host secret lives in the server secret store).
 * `relay_devices` maps each relay device to the session it was issued, and
 * tracks the two-sided approve/revoke handshake with the relay:
 * approving -> active, and active -> revoking -> revoked, so a crash between
 * the server's write and the relay's acknowledgement is retried at startup.
 * Each device's end-to-end public key is pinned on its row at approval.
 * `relay_pairings` is the server's own copy of each pairing's transcript
 * (one per invite, written before the server's nonce leaves), so nothing the
 * relay reports later can change what the owner compares or allows.
 * New tables only; no existing row is rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS relay_host (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      host_id TEXT NOT NULL,
      relay_origin TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS relay_devices (
      device_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      relay_origin TEXT NOT NULL,
      session_id TEXT,
      state TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      platform TEXT,
      device_public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS relay_pairings (
      request_id TEXT PRIMARY KEY,
      invite_id TEXT NOT NULL UNIQUE,
      join_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_public_key TEXT NOT NULL,
      commitment TEXT NOT NULL,
      host_nonce TEXT NOT NULL,
      device_nonce TEXT,
      match_number TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_relay_devices_session_id
    ON relay_devices(session_id)
  `;
});
