// @effect-diagnostics globalDate:off
import {
  type RelayAssistantSignIn,
  RelayAssistantRevokeRequest,
  RelayAssistantRouteTagRequest,
} from "@threadlines/contracts/relayAssistants";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type SqlLike, sqlRows } from "../sql.ts";

/** A connection id a credential can carry (the same pattern `parseAssistantCredential` reads). */
const CONNECTION_ID = /^[A-Za-z0-9-]{1,64}$/u;

const decodeRouteTagRequest = Schema.decodeUnknownOption(RelayAssistantRouteTagRequest);
const decodeRevokeRequest = Schema.decodeUnknownOption(RelayAssistantRevokeRequest);

/** `POST .../assistants/route-tags`: the connection id, or null when no credential could carry it. */
export function parseRouteTagRequest(body: unknown): string | null {
  const decoded = decodeRouteTagRequest(body);
  return Option.isSome(decoded) && CONNECTION_ID.test(decoded.value.connectionId)
    ? decoded.value.connectionId
    : null;
}

/** `POST .../assistants/revocations`: the removed connections' ids, or null for anything malformed. */
export function parseRevokeRequest(body: unknown): string[] | null {
  const decoded = decodeRevokeRequest(body);
  if (Option.isNone(decoded)) return null;
  const ids = decoded.value.connectionIds.map(String);
  return ids.every((id) => CONNECTION_ID.test(id)) ? ids : null;
}

/**
 * A computer's side of the assistants door, kept in its `RelayHost` object
 * next to the device state:
 *
 * - its one live sign-in code (the code shard maps it back here);
 * - sign-ins whose page typed that code, until the computer decides or they
 *   expire (sent again on every reconnect of the assistant socket);
 * - removed connections, refused at once even while the computer is offline,
 *   kept for as long as the host is registered;
 * - requests forwarded per UTC day, for the daily allowance.
 *
 * Synchronous over SQLite, like HostCore; the object shell does the sockets.
 */
export class AssistantHostCore {
  private readonly sql: SqlLike;

  constructor(sql: SqlLike) {
    this.sql = sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  // ----- the sign-in code ------------------------------------------------------

  code(now: number): { readonly code: string; readonly expiresAt: number } | null {
    const row = sqlRows<{ readonly code: string; readonly expires_at: number }>(
      this.sql,
      "SELECT code, expires_at FROM assistant_code WHERE id = 1",
    )[0];
    return row && row.expires_at > now ? { code: row.code, expiresAt: row.expires_at } : null;
  }

  /** Makes `code` the live one; the code it replaced, for its shard to forget. */
  setCode(code: string, expiresAt: number): string | null {
    const previous = this.storedCode();
    this.sql.exec(
      `INSERT INTO assistant_code (id, code, expires_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`,
      code,
      expiresAt,
    );
    return previous !== null && previous !== code ? previous : null;
  }

  /**
   * Uses up `code` for a sign-in its page typed: true only while it is this
   * host's live, unexpired code. A code cancelled or replaced is refused here,
   * even if its shard didn't hear yet.
   */
  claimCode(code: string, now: number): boolean {
    const live = this.code(now);
    if (live === null || live.code !== code) return false;
    this.sql.exec("DELETE FROM assistant_code WHERE id = 1");
    return true;
  }

  /** Forgets the live code (or only `code`, when given); the code forgotten. */
  clearCode(code?: string): string | null {
    const previous = this.storedCode();
    if (previous === null || (code !== undefined && previous !== code)) return null;
    this.sql.exec("DELETE FROM assistant_code WHERE id = 1");
    return previous;
  }

  private storedCode(): string | null {
    return (
      sqlRows<{ readonly code: string }>(
        this.sql,
        "SELECT code FROM assistant_code WHERE id = 1",
      )[0]?.code ?? null
    );
  }

  // ----- sign-ins waiting for the computer --------------------------------------

  addSignIn(signIn: RelayAssistantSignIn): void {
    this.sql.exec(
      `INSERT INTO assistant_sign_ins (sign_in_id, sign_in, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sign_in_id) DO UPDATE SET sign_in = excluded.sign_in, expires_at = excluded.expires_at`,
      signIn.signInId,
      JSON.stringify(signIn),
      Date.parse(signIn.expiresAt),
    );
  }

  signIn(signInId: string, now: number): RelayAssistantSignIn | null {
    const row = sqlRows<{ readonly sign_in: string; readonly expires_at: number }>(
      this.sql,
      "SELECT sign_in, expires_at FROM assistant_sign_ins WHERE sign_in_id = ?",
      signInId,
    )[0];
    return row && row.expires_at > now ? (JSON.parse(row.sign_in) as RelayAssistantSignIn) : null;
  }

  /** Live sign-ins, oldest first: what a reconnecting assistant socket is sent again. */
  signIns(now: number): RelayAssistantSignIn[] {
    return sqlRows<{ readonly sign_in: string }>(
      this.sql,
      "SELECT sign_in FROM assistant_sign_ins WHERE expires_at > ? ORDER BY expires_at, sign_in_id",
      now,
    ).map((row) => JSON.parse(row.sign_in) as RelayAssistantSignIn);
  }

  removeSignIn(signInId: string): void {
    this.sql.exec("DELETE FROM assistant_sign_ins WHERE sign_in_id = ?", signInId);
  }

  /** Ends what is due: the ids of sign-ins that timed out (the computer gets `signin.gone`). */
  expireDue(now: number): string[] {
    const expired = sqlRows<{ readonly sign_in_id: string }>(
      this.sql,
      "SELECT sign_in_id FROM assistant_sign_ins WHERE expires_at <= ? ORDER BY expires_at",
      now,
    ).map((row) => row.sign_in_id);
    this.sql.exec("DELETE FROM assistant_sign_ins WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM assistant_code WHERE expires_at <= ?", now);
    return expired;
  }

  nextDeadline(): number | null {
    return (
      sqlRows<{ readonly next: number | null }>(
        this.sql,
        `SELECT MIN(deadline) AS next FROM (
           SELECT expires_at AS deadline FROM assistant_code
           UNION ALL
           SELECT expires_at AS deadline FROM assistant_sign_ins
         )`,
      )[0]?.next ?? null
    );
  }

  // ----- removed connections ---------------------------------------------------

  /**
   * Adds removed connections. Ones already stored don't count again, so a
   * retried batch always lands. The cap can't strand a removal: route tags
   * stop (`canTagConnections`) before it's reached, so every connection that
   * can exist has room here.
   */
  revoke(connectionIds: ReadonlyArray<string>, now: number): boolean {
    const fresh = [...new Set(connectionIds)].filter((id) => !this.isRevoked(id));
    if (this.revokedCount() + fresh.length > MAX_REVOKED_CONNECTIONS) return false;
    for (const connectionId of fresh) {
      this.sql.exec(
        "INSERT OR IGNORE INTO assistant_revoked (connection_id, revoked_at) VALUES (?, ?)",
        connectionId,
        now,
      );
    }
    return true;
  }

  /**
   * Whether a new connection may get a route tag: only while every connection
   * that could still be removed has room on the list. Each tag is one
   * connection; tags already handed out are counted by `tagged`.
   */
  canTagConnections(): boolean {
    return this.revokedCount() + this.taggedLive() < MAX_REVOKED_CONNECTIONS;
  }

  /** A route tag was handed out: one more connection that may need room on the list. */
  noteTagged(connectionId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO assistant_tagged (connection_id) VALUES (?)",
      connectionId,
    );
  }

  private revokedCount(): number {
    return (
      sqlRows<{ readonly count: number }>(
        this.sql,
        "SELECT COUNT(*) AS count FROM assistant_revoked",
      )[0]?.count ?? 0
    );
  }

  /** Tagged connections not removed yet. */
  private taggedLive(): number {
    return (
      sqlRows<{ readonly count: number }>(
        this.sql,
        `SELECT COUNT(*) AS count FROM assistant_tagged
         WHERE connection_id NOT IN (SELECT connection_id FROM assistant_revoked)`,
      )[0]?.count ?? 0
    );
  }

  isRevoked(connectionId: string): boolean {
    return (
      sqlRows(
        this.sql,
        "SELECT connection_id FROM assistant_revoked WHERE connection_id = ?",
        connectionId,
      ).length > 0
    );
  }

  // ----- the daily allowance ---------------------------------------------------

  /** Requests committed today (forwarded ones not yet committed ride on the socket). */
  requestsToday(now: number): number {
    return (
      sqlRows<{ readonly requests: number }>(
        this.sql,
        "SELECT requests FROM assistant_usage WHERE day = ?",
        utcDay(now),
      )[0]?.requests ?? 0
    );
  }

  commitRequests(now: number, requests: number): void {
    if (requests <= 0) return;
    const day = utcDay(now);
    this.sql.exec("DELETE FROM assistant_usage WHERE day < ?", day);
    this.sql.exec(
      `INSERT INTO assistant_usage (day, requests) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests`,
      day,
      requests,
    );
  }
}

/** A computer can't make its object keep an endless list. */
export const MAX_REVOKED_CONNECTIONS = 10_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS assistant_code (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     code TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS assistant_sign_ins (
     sign_in_id TEXT PRIMARY KEY,
     sign_in TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS assistant_revoked (
     connection_id TEXT PRIMARY KEY,
     revoked_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS assistant_tagged (
     connection_id TEXT PRIMARY KEY
   )`,
  `CREATE TABLE IF NOT EXISTS assistant_usage (
     day TEXT PRIMARY KEY,
     requests INTEGER NOT NULL
   )`,
] as const;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight, when the daily allowance starts over. */
export function secondsUntilUtcMidnight(now: number): number {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}
