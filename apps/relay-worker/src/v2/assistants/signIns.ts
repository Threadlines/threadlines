// @effect-diagnostics globalDate:off
import {
  ASSISTANT_SIGN_IN_CODE_TRIES,
  ASSISTANT_SIGN_IN_TTL_MS,
  type AssistantScope,
  type RelayAssistantClientIdentity,
  type RelayAssistantPlace,
  type RelayAssistantSignIn,
} from "@threadlines/contracts/relayAssistants";
import { normalizeAssistantSignInCode } from "@threadlines/shared/assistantCredentials";
import { randomBytes, sha256, toBase64Url, utf8 } from "@threadlines/shared/relaySecure";

import { timingSafeEqualString } from "../../crypto.ts";
import { type SqlLike, sqlRows } from "../sql.ts";

/**
 * Pending assistant sign-ins (docs/design/assistants.md, "Authorize"), kept
 * before any computer is known, in `RelayAssistantSignIn` shards.
 *
 * A sign-in id is `<shard>.<22 random characters>`. The shard comes from a
 * hash of the IP that opened the page, so one shard can hold every sign-in
 * waiting from one network and count them (at most 10); every later call
 * finds the shard from the id alone, whatever network the page is on by then.
 *
 * Its life: waiting for a code (3 tries) → waiting for the computer's
 * decision (once a code matched; the shard records the host) → done (the
 * page gets the redirect), or over (out of tries), expired (10 minutes) or
 * failed (the relay couldn't hand it to the computer). Rows stay a while
 * after they end so the page can still read how.
 */

export const SIGN_IN_SHARDS = 32;
export const MAX_PENDING_SIGN_INS_PER_IP = 10;
/** How long an ended sign-in stays readable by its page. */
const ENDED_KEEP_MS = 10 * 60_000;
const SIGN_IN_ID = /^([0-9]{1,2})\.[A-Za-z0-9_-]{22}$/u;
/** 32 random bytes, base64url: the secret only the sign-in page holds. */
const PAGE_SECRET = /^[A-Za-z0-9_-]{43}$/u;

export function isSignInId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SIGN_IN_ID.exec(value);
  return match !== null && Number(match[1]) < SIGN_IN_SHARDS;
}

export function isPageSecret(value: unknown): value is string {
  return typeof value === "string" && PAGE_SECRET.test(value);
}

/** An IP as the shards keep it (a hash, never the IP), and the shard its sign-ins go to. */
export async function signInNetwork(
  ip: string,
): Promise<{ readonly ipHash: string; readonly shard: number }> {
  const digest = await sha256(utf8(`threadlines-assistant-ip-v1|${ip}`));
  return { ipHash: toBase64Url(digest), shard: digest[0]! % SIGN_IN_SHARDS };
}

export async function hashPageSecret(secret: string): Promise<string> {
  return toBase64Url(await sha256(utf8(`threadlines-assistant-page-v1|${secret}`)));
}

export function newSignInId(shard: number): string {
  return `${shard}.${toBase64Url(randomBytes(16))}`;
}

export function newPageSecret(): string {
  return toBase64Url(randomBytes(32));
}

/** The `RelayAssistantSignIn` object that keeps a sign-in. */
export function signInShardName(signInId: string): string {
  return `assistant-sign-ins:${signInId.split(".")[0]}`;
}

/**
 * `redirectUri` with the parameters appended, the registered URI kept byte
 * for byte (its own query stays as it was; registered URIs carry no fragment).
 */
export function redirectWithParams(
  redirectUri: string,
  params: ReadonlyArray<readonly [string, string]>,
): string {
  const query = params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  if (!redirectUri.includes("?")) return `${redirectUri}?${query}`;
  return redirectUri.endsWith("?") || redirectUri.endsWith("&")
    ? `${redirectUri}${query}`
    : `${redirectUri}&${query}`;
}

export type SignInStatus =
  | { readonly state: "waiting-for-code"; readonly triesLeft: number }
  | { readonly state: "waiting-for-approval" }
  | { readonly state: "done"; readonly redirectUrl: string }
  | { readonly state: "over" | "expired" | "failed" | "unknown" };

export type CodeTypingOutcome =
  | { readonly status: SignInStatus; readonly mismatch?: true }
  /** Another check of this sign-in's code is still running. */
  | { readonly status: SignInStatus; readonly busy: true }
  /** The relay couldn't check the code just now; the try wasn't used. */
  | { readonly status: SignInStatus; readonly unavailable: true };

export interface NewSignIn {
  readonly signInId: string;
  readonly ipHash: string;
  readonly pageSecretHash: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly identity: RelayAssistantClientIdentity;
  readonly redirectUri: string;
  readonly oauthState: string;
  readonly codeChallenge: string;
  readonly scopes: ReadonlyArray<AssistantScope>;
  readonly resource: string;
  readonly issuer: string;
  readonly place: RelayAssistantPlace | null;
}

interface SignInRow extends Record<string, unknown> {
  readonly sign_in_id: string;
  readonly ip_hash: string;
  readonly page_secret_hash: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly identity: string;
  readonly redirect_uri: string;
  readonly oauth_state: string;
  readonly code_challenge: string;
  readonly scopes: string;
  readonly resource: string;
  readonly issuer: string;
  readonly place: string | null;
  readonly status: string;
  readonly tries_left: number;
  readonly host_id: string | null;
  readonly redirect_url: string | null;
  readonly created_at: number;
  readonly expires_at: number;
}

const WAITING = "('waiting-for-code', 'waiting-for-approval')";

/** One shard's sign-ins, synchronous over SQLite; the Durable Object shell does the waiting. */
export class SignInCore {
  private readonly sql: SqlLike;
  /** Sign-ins whose typed code is being looked up right now. Memory only: lost with the object, as it should be. */
  private readonly checking = new Set<string>();

  constructor(sql: SqlLike) {
    this.sql = sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sign_ins (
         sign_in_id TEXT PRIMARY KEY,
         ip_hash TEXT NOT NULL,
         page_secret_hash TEXT NOT NULL,
         client_id TEXT NOT NULL,
         client_name TEXT NOT NULL,
         identity TEXT NOT NULL,
         redirect_uri TEXT NOT NULL,
         oauth_state TEXT NOT NULL,
         code_challenge TEXT NOT NULL,
         scopes TEXT NOT NULL,
         resource TEXT NOT NULL,
         issuer TEXT NOT NULL,
         place TEXT,
         status TEXT NOT NULL,
         tries_left INTEGER NOT NULL,
         host_id TEXT,
         redirect_url TEXT,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS sign_ins_by_ip ON sign_ins (ip_hash, status)");
  }

  /** Keeps a new sign-in, unless its network already has 10 waiting. */
  create(
    input: NewSignIn,
    now: number,
  ): { readonly ok: true; readonly expiresAt: number } | { readonly ok: false } {
    const waiting =
      sqlRows<{ readonly count: number }>(
        this.sql,
        `SELECT COUNT(*) AS count FROM sign_ins
         WHERE ip_hash = ? AND status IN ${WAITING} AND expires_at > ?`,
        input.ipHash,
        now,
      )[0]?.count ?? 0;
    if (waiting >= MAX_PENDING_SIGN_INS_PER_IP) return { ok: false };
    const expiresAt = now + ASSISTANT_SIGN_IN_TTL_MS;
    this.sql.exec(
      `INSERT INTO sign_ins (sign_in_id, ip_hash, page_secret_hash, client_id, client_name,
         identity, redirect_uri, oauth_state, code_challenge, scopes, resource, issuer, place,
         status, tries_left, host_id, redirect_url, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting-for-code', ?, NULL, NULL, ?, ?)`,
      input.signInId,
      input.ipHash,
      input.pageSecretHash,
      input.clientId,
      input.clientName,
      JSON.stringify(input.identity),
      input.redirectUri,
      input.oauthState,
      input.codeChallenge,
      JSON.stringify(input.scopes),
      input.resource,
      input.issuer,
      input.place ? JSON.stringify(input.place) : null,
      ASSISTANT_SIGN_IN_CODE_TRIES,
      now,
      expiresAt,
    );
    return { ok: true, expiresAt };
  }

  /** What the page sees. A wrong page secret looks like no sign-in at all. */
  status(signInId: string, pageSecretHash: string, now: number): SignInStatus {
    const row = this.pageRow(signInId, pageSecretHash);
    return row ? statusOf(row, now) : { state: "unknown" };
  }

  /**
   * Starts checking a typed code: uses up a try before anything waits, so
   * racing requests can't get more than three. `check` hands back the code to
   * look up; anything else is already the answer.
   */
  beginCodeCheck(
    signInId: string,
    pageSecretHash: string,
    typed: string,
    now: number,
  ): { readonly check: string } | CodeTypingOutcome {
    const row = this.pageRow(signInId, pageSecretHash);
    if (!row) return { status: { state: "unknown" } };
    const current = statusOf(row, now);
    if (current.state !== "waiting-for-code") return { status: current };
    if (this.checking.has(signInId)) return { status: current, busy: true };
    const triesLeft = row.tries_left - 1;
    const code = normalizeAssistantSignInCode(typed);
    this.sql.exec(
      "UPDATE sign_ins SET tries_left = ?, status = ? WHERE sign_in_id = ?",
      triesLeft,
      code === null && triesLeft <= 0 ? "over" : "waiting-for-code",
      signInId,
    );
    if (code === null) {
      return { status: this.statusById(signInId, now), mismatch: true };
    }
    this.checking.add(signInId);
    return { check: code };
  }

  /** The lookup failed for the relay's own reasons: the try comes back. */
  abortCodeCheck(signInId: string, now: number): CodeTypingOutcome {
    this.checking.delete(signInId);
    this.sql.exec(
      "UPDATE sign_ins SET tries_left = tries_left + 1 WHERE sign_in_id = ? AND status = 'waiting-for-code'",
      signInId,
    );
    return { status: this.statusById(signInId, now), unavailable: true };
  }

  /**
   * Ends a code check. No host: a wrong code (and the last try ends the
   * sign-in). A host: this sign-in is now that computer's to decide.
   */
  finishCodeCheck(
    signInId: string,
    hostId: string | null,
    now: number,
  ):
    | { readonly matched: false; readonly outcome: CodeTypingOutcome }
    | { readonly matched: true; readonly signIn: RelayAssistantSignIn } {
    this.checking.delete(signInId);
    const row = this.row(signInId);
    if (!row || row.status !== "waiting-for-code" || row.expires_at <= now) {
      return {
        matched: false,
        outcome: { status: row ? statusOf(row, now) : { state: "unknown" } },
      };
    }
    if (hostId === null) {
      if (row.tries_left <= 0) {
        this.sql.exec("UPDATE sign_ins SET status = 'over' WHERE sign_in_id = ?", signInId);
      }
      return {
        matched: false,
        outcome: { status: this.statusById(signInId, now), mismatch: true },
      };
    }
    this.sql.exec(
      "UPDATE sign_ins SET status = 'waiting-for-approval', host_id = ? WHERE sign_in_id = ?",
      hostId,
      signInId,
    );
    return { matched: true, signIn: toSignIn(row) };
  }

  /** The relay couldn't pass a matched sign-in to its computer; the page says to start again. */
  failHandOff(signInId: string): void {
    this.sql.exec(
      "UPDATE sign_ins SET status = 'failed' WHERE sign_in_id = ? AND status = 'waiting-for-approval'",
      signInId,
    );
  }

  /**
   * The computer's decision, from the host it was handed to. Allow sends the
   * authorization code back to the assistant; deny says `access_denied`.
   * Both carry `state` and `iss` (RFC 9207).
   */
  decide(
    input: {
      readonly signInId: string;
      readonly hostId: string;
      readonly decision: "allow" | "deny";
      readonly authorizationCode?: string;
    },
    now: number,
  ): "applied" | "expired" | "gone" {
    const row = this.row(input.signInId);
    if (!row || row.host_id !== input.hostId) return "gone";
    const params: Array<[string, string]> =
      input.decision === "allow" && input.authorizationCode
        ? [["code", input.authorizationCode]]
        : [["error", "access_denied"]];
    params.push(["state", row.oauth_state], ["iss", row.issuer]);
    const redirectUrl = redirectWithParams(row.redirect_uri, params);
    // The same decision again (its first reply was lost): already applied.
    if (row.status === "done") return row.redirect_url === redirectUrl ? "applied" : "gone";
    if (row.status !== "waiting-for-approval") return row.status === "expired" ? "expired" : "gone";
    if (row.expires_at <= now) return "expired";
    this.sql.exec(
      "UPDATE sign_ins SET status = 'done', redirect_url = ? WHERE sign_in_id = ?",
      redirectUrl,
      input.signInId,
    );
    return "applied";
  }

  /** Ends sign-ins whose 10 minutes are up, and drops ended ones the page no longer needs. */
  expireDue(now: number): void {
    this.sql.exec(
      `UPDATE sign_ins SET status = 'expired' WHERE status IN ${WAITING} AND expires_at <= ?`,
      now,
    );
    this.sql.exec("DELETE FROM sign_ins WHERE expires_at <= ?", now - ENDED_KEEP_MS);
  }

  nextDeadline(): number | null {
    return (
      sqlRows<{ readonly next: number | null }>(
        this.sql,
        `SELECT MIN(CASE WHEN status IN ${WAITING} THEN expires_at ELSE expires_at + ? END) AS next
         FROM sign_ins`,
        ENDED_KEEP_MS,
      )[0]?.next ?? null
    );
  }

  private row(signInId: string): SignInRow | null {
    return (
      sqlRows<SignInRow>(this.sql, "SELECT * FROM sign_ins WHERE sign_in_id = ?", signInId)[0] ??
      null
    );
  }

  private pageRow(signInId: string, pageSecretHash: string): SignInRow | null {
    const row = this.row(signInId);
    return row && timingSafeEqualString(row.page_secret_hash, pageSecretHash) ? row : null;
  }

  private statusById(signInId: string, now: number): SignInStatus {
    const row = this.row(signInId);
    return row ? statusOf(row, now) : { state: "unknown" };
  }
}

function statusOf(row: SignInRow, now: number): SignInStatus {
  const waiting = row.status === "waiting-for-code" || row.status === "waiting-for-approval";
  if (waiting && row.expires_at <= now) return { state: "expired" };
  switch (row.status) {
    case "waiting-for-code":
      return { state: "waiting-for-code", triesLeft: row.tries_left };
    case "waiting-for-approval":
      return { state: "waiting-for-approval" };
    case "done":
      return row.redirect_url
        ? { state: "done", redirectUrl: row.redirect_url }
        : { state: "failed" };
    case "over":
    case "expired":
    case "failed":
      return { state: row.status };
    default:
      return { state: "unknown" };
  }
}

function toSignIn(row: SignInRow): RelayAssistantSignIn {
  return {
    signInId: row.sign_in_id,
    clientId: row.client_id,
    clientName: row.client_name,
    identity: JSON.parse(row.identity) as RelayAssistantClientIdentity,
    redirectUri: row.redirect_uri,
    scopes: JSON.parse(row.scopes) as AssistantScope[],
    codeChallenge: row.code_challenge,
    resource: row.resource,
    issuer: row.issuer,
    place: row.place ? (JSON.parse(row.place) as RelayAssistantPlace) : null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** What typing a code needs from outside its shard. */
export interface CodeTypingDeps {
  /** Uses the code up in its code shard: the host it belonged to, or null. */
  readonly takeCode: (code: string) => Promise<string | null>;
  /** Gives the matched sign-in to its computer's object, which shows it to the computer. */
  readonly handToHost: (
    hostId: string,
    signIn: RelayAssistantSignIn,
    code: string,
  ) => Promise<void>;
  readonly now: () => number;
}

/**
 * `POST /authorize/code` inside a sign-in's shard. The typed code goes only
 * to the sign-in whose page secret came with it, so a code binds the page
 * that typed it and no other.
 */
export async function typeAssistantCode(
  core: SignInCore,
  deps: CodeTypingDeps,
  input: { readonly signInId: string; readonly pageSecretHash: string; readonly code: string },
): Promise<CodeTypingOutcome> {
  const begun = core.beginCodeCheck(input.signInId, input.pageSecretHash, input.code, deps.now());
  if (!("check" in begun)) return begun;
  let hostId: string | null;
  try {
    hostId = await deps.takeCode(begun.check);
  } catch {
    return core.abortCodeCheck(input.signInId, deps.now());
  }
  const finished = core.finishCodeCheck(input.signInId, hostId, deps.now());
  if (!finished.matched) return finished.outcome;
  try {
    await deps.handToHost(hostId!, finished.signIn, begun.check);
  } catch {
    core.failHandOff(input.signInId);
    return { status: { state: "failed" } };
  }
  return { status: { state: "waiting-for-approval" } };
}
