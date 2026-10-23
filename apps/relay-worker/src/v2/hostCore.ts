import type {
  PushAlertKinds,
  RelayAlertKind,
  RelayControlEvent,
  RelayDecisionResult,
  RelayDeviceAlertOutcome,
  RelayDeviceId,
  RelayHookDelivery,
  RelayHookDeliveryId,
  RelayHookId,
  RelayHookStateResult,
  RelayDeviceKind,
  RelayDeviceRecord,
  RelayHostId,
  RelayInviteId,
  RelayJoinErrorCode,
  RelayJoinerDescription,
  RelayJoinRequest,
  RelayJoinResult,
  RelayRequestId,
  RelayRequestState,
  RelayRequestStatusResult,
  RelayUsageToday,
  RelayWatchEvent,
} from "@threadlines/contracts/relay";
import {
  RELAY_CLOSE_CODE_ACCESS_REMOVED,
  RELAY_HOOK_HOLD_MS,
  RELAY_HOOK_INLINE_SEALED_BYTES,
} from "@threadlines/contracts/relay";

import { timingSafeEqualString } from "../crypto.ts";
import { type SqlLike, sqlRows } from "./sql.ts";

/**
 * The state machine behind one relay host: invites (codes and QR secrets),
 * join requests, devices, and today's usage. It is synchronous over SQLite and
 * knows nothing about sockets or other Durable Objects; every method returns
 * the side effects (watcher pushes, control events, code releases, socket
 * closes) for the Durable Object shell to carry out. That keeps the rules that
 * decide who gets access testable against real SQLite in Node.
 */

export interface HostCoreLimits {
  readonly inviteTtlMs: number;
  readonly requestTtlMs: number;
  readonly maxDevices: number;
  readonly tombstoneTtlMs: number;
  readonly dailyMessages: number;
  readonly dailyAwakeSeconds: number;
  /** Event task deliveries accepted per UTC day. */
  readonly dailyHooks: number;
  /** Deliveries waiting for the host, by count and by sealed size. */
  readonly maxPendingHookDeliveries: number;
  readonly maxPendingHookBytes: number;
  /** Hook rows per host, retired ones still kept included. */
  readonly maxHooks: number;
  /** Push alerts sent per UTC day: to all of the host's phones, and to any one of them. */
  readonly dailyAlerts: number;
  readonly dailyAlertsPerDevice: number;
}

export const DEFAULT_HOST_CORE_LIMITS: HostCoreLimits = {
  inviteTtlMs: 10 * 60_000,
  requestTtlMs: 5 * 60_000,
  maxDevices: 50,
  tombstoneTtlMs: 30 * 24 * 60 * 60_000,
  dailyMessages: 200_000,
  // Billed duration is only event-handling time with hibernatable sockets, so
  // the message count is the real limit; awake time is tracked for insight
  // and can be capped per deployment.
  dailyAwakeSeconds: 24 * 60 * 60,
  dailyHooks: 1_000,
  maxPendingHookDeliveries: 500,
  maxPendingHookBytes: 50 * 1024 * 1024,
  maxHooks: 500,
  dailyAlerts: 2_000,
  dailyAlertsPerDevice: 300,
};

/** A retired hook's row stays this long, so deliveries it accepted still find it. */
export const RETIRED_HOOK_KEEP_MS = 25 * 60 * 60_000;
/** How long a sender is told to wait when the host's queue of deliveries is full. */
const HOOK_QUEUE_FULL_RETRY_SECONDS = 300;

/** Width of one "awake window" in the daily allowance. */
export const AWAKE_WINDOW_MS = 10_000;

/** Usage not yet committed to storage (held on live sockets by the Durable Object). */
export interface PendingUsage {
  readonly messages: number;
  readonly awakeSeconds: number;
}

export const NO_PENDING_USAGE: PendingUsage = { messages: 0, awakeSeconds: 0 };

export type HostEffect =
  | { readonly type: "watch"; readonly requestId: string; readonly event: RelayWatchEvent }
  | { readonly type: "control"; readonly event: RelayControlEvent }
  | { readonly type: "release-code"; readonly code: string; readonly inviteId: string }
  | {
      readonly type: "close-device";
      readonly deviceId: string;
      readonly code: number;
      readonly reason: string;
    };

export type HostCoreErrorCode = RelayJoinErrorCode | "not-found" | "forbidden" | "too-many-hooks";

export class HostCoreError extends Error {
  readonly code: HostCoreErrorCode;

  constructor(code: HostCoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Outcome<T> {
  readonly result: T;
  readonly effects: ReadonlyArray<HostEffect>;
}

interface HostRow extends Record<string, unknown> {
  readonly host_id: string;
  readonly secret_hash: string;
  readonly label: string;
  readonly environment_id: string;
  readonly created_at: number;
}

interface InviteRow extends Record<string, unknown> {
  readonly invite_id: string;
  readonly code: string;
  readonly claim_token_hash: string;
  readonly state: "open" | "used" | "cancelled" | "expired" | "burned";
  readonly created_at: number;
  readonly expires_at: number;
}

interface RequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly invite_id: string;
  readonly join_id: string;
  readonly request_secret_hash: string;
  readonly device_id: string;
  readonly device_secret_hash: string;
  readonly label: string;
  readonly platform: string | null;
  readonly kind: string;
  readonly device_public_key: string;
  readonly commitment: string | null;
  readonly claim_proof: string | null;
  readonly host_nonce: string | null;
  readonly host_public_key: string | null;
  readonly device_nonce: string | null;
  readonly auto_approve: number;
  readonly state: RelayRequestState;
  readonly created_at: number;
  readonly expires_at: number;
}

interface DevicePushRow extends Record<string, unknown> {
  readonly device_id: string;
  readonly registration_id: string;
  readonly endpoint: string;
  readonly key_id: string;
  readonly kinds: string;
  readonly updated_at: number;
}

/** Stored kinds; anything unreadable counts as off. */
function parseKinds(text: string): PushAlertKinds {
  try {
    const value = JSON.parse(text) as Partial<Record<keyof PushAlertKinds, unknown>>;
    return {
      needs_you: value.needs_you === true,
      finished: value.finished === true,
      failed: value.failed === true,
    };
  } catch {
    return { needs_you: false, finished: false, failed: false };
  }
}

interface DeviceRow extends Record<string, unknown> {
  readonly device_id: string;
  readonly secret_hash: string;
  readonly label: string;
  readonly state: "active" | "revoked";
  readonly created_at: number;
  readonly revoked_at: number | null;
}

interface UsageRow extends Record<string, unknown> {
  readonly day: string;
  readonly messages: number;
  readonly awake_seconds: number;
}

interface HookRow extends Record<string, unknown> {
  readonly hook_id: string;
  readonly kept_headers: string;
  readonly active: number;
  readonly created_at: number;
  readonly retired_at: number | null;
}

interface HookDeliveryRow extends Record<string, unknown> {
  readonly delivery_id: string;
  readonly hook_id: string;
  readonly received_at: number;
  readonly size: number;
}

/** Whether a delivery may come in, and if so what the hook keeps and seals to. */
export type HookAdmission =
  | {
      readonly ok: true;
      readonly keptHeaders: ReadonlyArray<string>;
      readonly publicKey: string;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 429;
      readonly reason: "unknown-hook" | "daily-limit" | "queue-full";
      readonly retryAfterSeconds?: number;
    };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS host (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     host_id TEXT NOT NULL,
     secret_hash TEXT NOT NULL,
     label TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS invites (
     invite_id TEXT PRIMARY KEY,
     code TEXT NOT NULL,
     claim_token_hash TEXT NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS requests (
     request_id TEXT PRIMARY KEY,
     invite_id TEXT NOT NULL,
     join_id TEXT NOT NULL UNIQUE,
     request_secret_hash TEXT NOT NULL,
     device_id TEXT NOT NULL UNIQUE,
     device_secret_hash TEXT NOT NULL,
     label TEXT NOT NULL,
     platform TEXT,
     kind TEXT NOT NULL,
     device_public_key TEXT NOT NULL,
     commitment TEXT,
     claim_proof TEXT,
     host_nonce TEXT,
     host_public_key TEXT,
     device_nonce TEXT,
     auto_approve INTEGER NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     decided_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY,
     secret_hash TEXT NOT NULL,
     label TEXT NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS usage (
     day TEXT PRIMARY KEY,
     messages INTEGER NOT NULL,
     awake_seconds INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS hooks (
     hook_id TEXT PRIMARY KEY,
     kept_headers TEXT NOT NULL,
     active INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     retired_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS hook_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL,
     public_key TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS hook_deliveries (
     delivery_id TEXT PRIMARY KEY,
     hook_id TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     size INTEGER NOT NULL,
     sealed TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS hook_deliveries_by_time ON hook_deliveries (received_at)`,
  `CREATE TABLE IF NOT EXISTS hook_usage (
     day TEXT PRIMARY KEY,
     hooks INTEGER NOT NULL
   )`,
  // A phone's push subscription, as the phone itself registered it, and the
  // alerts it wants. The host never sees the endpoint.
  `CREATE TABLE IF NOT EXISTS device_push (
     device_id TEXT PRIMARY KEY,
     registration_id TEXT NOT NULL,
     endpoint TEXT NOT NULL,
     key_id TEXT NOT NULL,
     kinds TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Alerts sent per UTC day: per device, and the host's total under device ''.
  `CREATE TABLE IF NOT EXISTS push_usage (
     day TEXT NOT NULL,
     device_id TEXT NOT NULL,
     alerts INTEGER NOT NULL,
     PRIMARY KEY (day, device_id)
   )`,
] as const;

/** Request outcomes kept as history for this long, then pruned. */
const REQUEST_HISTORY_MS = 24 * 60 * 60_000;

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function nextUtcMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isTerminal(state: RelayRequestState): boolean {
  return state !== "pending";
}

export interface JoinInput {
  readonly inviteId: string;
  readonly joinId: string;
  readonly deviceSecretHash: string;
  readonly requestSecretHash: string;
  readonly devicePublicKey: string;
  readonly joiner: RelayJoinerDescription;
  /** Code joins: the joiner's commitment to its key and nonce. */
  readonly commitment?: string;
  /** QR claims: the hash of the claim token, checked against the invite. */
  readonly claimTokenHash?: string;
  /** QR claims: forwarded to the host, which checks it; the relay can't. */
  readonly claimProof?: string;
  readonly now: number;
  readonly fresh: {
    readonly requestId: string;
    readonly deviceId: string;
  };
}

export class HostCore {
  // Committed usage for `usageDay`, cached from storage. A hibernating
  // Durable Object loses memory between messages, so nothing uncommitted is
  // kept here; running tallies live on the sockets until committed.
  private usageDay: string;
  private usageMessages = 0;
  private usageAwakeSeconds = 0;
  private usageHooks = 0;
  private readonly sql: SqlLike;
  private readonly limits: HostCoreLimits;

  constructor(
    sql: SqlLike,
    limits: HostCoreLimits = DEFAULT_HOST_CORE_LIMITS,
    now: number = Date.now(),
  ) {
    this.sql = sql;
    this.limits = limits;
    for (const statement of SCHEMA) {
      this.sql.exec(statement);
    }
    this.usageDay = utcDay(now);
    const stored = sqlRows<UsageRow>(
      this.sql,
      "SELECT day, messages, awake_seconds FROM usage WHERE day = ?",
      this.usageDay,
    )[0];
    if (stored) {
      this.usageMessages = stored.messages;
      this.usageAwakeSeconds = stored.awake_seconds;
    }
    this.usageHooks = this.storedHookCount(this.usageDay);
  }

  // ----- host -----------------------------------------------------------------

  initialize(input: {
    readonly hostId: string;
    readonly secretHash: string;
    readonly label: string;
    readonly environmentId: string;
    readonly now: number;
  }): void {
    if (this.host()) {
      throw new HostCoreError("forbidden", "Relay host already exists.");
    }
    this.sql.exec(
      `INSERT INTO host (id, host_id, secret_hash, label, environment_id, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      input.hostId,
      input.secretHash,
      input.label,
      input.environmentId,
      input.now,
    );
  }

  host(): HostRow | null {
    return (
      sqlRows<HostRow>(
        this.sql,
        "SELECT host_id, secret_hash, label, environment_id, created_at FROM host WHERE id = 1",
      )[0] ?? null
    );
  }

  verifyHostSecretHash(secretHash: string): boolean {
    const host = this.host();
    return host !== null && timingSafeEqualString(host.secret_hash, secretHash);
  }

  setLabel(label: string): void {
    const host = this.host();
    if (!host || host.label === label) return;
    this.sql.exec("UPDATE host SET label = ? WHERE id = 1", label);
  }

  // ----- invites --------------------------------------------------------------

  openInvite(now: number): InviteRow | null {
    const invite =
      sqlRows<InviteRow>(
        this.sql,
        "SELECT * FROM invites WHERE state = 'open' ORDER BY created_at DESC LIMIT 1",
      )[0] ?? null;
    if (invite && invite.expires_at <= now) {
      return null;
    }
    return invite;
  }

  /** Opens a new invite, cancelling any open one (one open invite per host). */
  createInvite(input: {
    readonly inviteId: string;
    readonly code: string;
    readonly claimTokenHash: string;
    readonly now: number;
  }): Outcome<{ readonly inviteId: string; readonly code: string; readonly expiresAt: number }> {
    const effects: HostEffect[] = [];
    for (const open of sqlRows<InviteRow>(this.sql, "SELECT * FROM invites WHERE state = 'open'")) {
      effects.push(...this.closeInvite(open, "cancelled", input.now));
    }
    const expiresAt = input.now + this.limits.inviteTtlMs;
    this.sql.exec(
      `INSERT INTO invites (invite_id, code, claim_token_hash, state, created_at, expires_at)
       VALUES (?, ?, ?, 'open', ?, ?)`,
      input.inviteId,
      input.code,
      input.claimTokenHash,
      input.now,
      expiresAt,
    );
    return { result: { inviteId: input.inviteId, code: input.code, expiresAt }, effects };
  }

  cancelInvite(inviteId: string, now: number): Outcome<null> {
    const invite = this.invite(inviteId);
    if (!invite || invite.state !== "open") {
      return { result: null, effects: [] };
    }
    return { result: null, effects: this.closeInvite(invite, "cancelled", now) };
  }

  private invite(inviteId: string): InviteRow | null {
    return (
      sqlRows<InviteRow>(this.sql, "SELECT * FROM invites WHERE invite_id = ?", inviteId)[0] ?? null
    );
  }

  /** Closes an invite and any request still pending on it. */
  private closeInvite(
    invite: InviteRow,
    state: "used" | "cancelled" | "expired" | "burned",
    now: number,
  ): HostEffect[] {
    const effects: HostEffect[] = [];
    this.sql.exec("UPDATE invites SET state = ? WHERE invite_id = ?", state, invite.invite_id);
    // A used or denied code keeps its shard entry until it would have expired,
    // so a joiner whose first response was lost can still replay its joinId;
    // new joins on it reach this object and get "invalid-code" here.
    if (state === "cancelled" || state === "expired") {
      effects.push({ type: "release-code", code: invite.code, inviteId: invite.invite_id });
    }
    // Only a host cancelling the invite ends a pending request; an invite that
    // expires leaves an in-flight request its own deadline so Allow still works.
    if (state === "cancelled") {
      for (const pending of sqlRows<RequestRow>(
        this.sql,
        "SELECT * FROM requests WHERE invite_id = ? AND state = 'pending'",
        invite.invite_id,
      )) {
        effects.push(...this.setRequestState(pending, "cancelled", now));
      }
    }
    return effects;
  }

  // ----- joins ----------------------------------------------------------------

  /**
   * Creates (or, for a replayed `joinId`, returns) a pending request on an
   * open invite. One pending request per invite: a second joiner gets `busy`.
   */
  join(input: JoinInput): Outcome<RelayJoinResult> {
    const host = this.requireHost();
    const replay = sqlRows<RequestRow>(
      this.sql,
      "SELECT * FROM requests WHERE join_id = ?",
      input.joinId,
    )[0];
    if (replay) {
      if (
        replay.invite_id !== input.inviteId ||
        !timingSafeEqualString(replay.device_secret_hash, input.deviceSecretHash) ||
        !timingSafeEqualString(replay.request_secret_hash, input.requestSecretHash) ||
        replay.device_public_key !== input.devicePublicKey
      ) {
        throw new HostCoreError("invalid-invite", "That join was already used.");
      }
      return { result: this.toJoinResult(host, replay), effects: [] };
    }

    const invite = this.invite(input.inviteId);
    const isClaim = input.claimTokenHash !== undefined;
    if (!invite || invite.state !== "open") {
      throw new HostCoreError(
        isClaim ? "invalid-invite" : "invalid-code",
        "That code or link doesn't work anymore.",
      );
    }
    if (
      isClaim
        ? input.claimProof === undefined ||
          !timingSafeEqualString(invite.claim_token_hash, input.claimTokenHash)
        : input.commitment === undefined
    ) {
      throw new HostCoreError(
        isClaim ? "invalid-invite" : "invalid-code",
        "That link doesn't work.",
      );
    }

    const effects: HostEffect[] = [];
    if (invite.expires_at <= input.now) {
      effects.push(...this.closeInvite(invite, "expired", input.now));
      throw new HostCoreErrorWithEffects("expired", "That code expired.", effects);
    }

    for (const pending of sqlRows<RequestRow>(
      this.sql,
      "SELECT * FROM requests WHERE invite_id = ? AND state = 'pending'",
      invite.invite_id,
    )) {
      if (pending.expires_at <= input.now) {
        effects.push(...this.setRequestState(pending, "expired", input.now));
        continue;
      }
      throw new HostCoreErrorWithEffects(
        "busy",
        "Another device is already using this code. Try again in a moment.",
        effects,
      );
    }

    if (this.activeDeviceCount() >= this.limits.maxDevices) {
      throw new HostCoreErrorWithEffects(
        "too-many-devices",
        "This computer already has the most devices it can have. Remove one first.",
        effects,
      );
    }

    const autoApprove = isClaim;
    const expiresAt = Math.min(
      input.now + this.limits.requestTtlMs,
      Math.max(invite.expires_at, input.now + 60_000),
    );
    this.sql.exec(
      `INSERT INTO requests (
         request_id, invite_id, join_id, request_secret_hash, device_id, device_secret_hash,
         label, platform, kind, device_public_key, commitment, claim_proof, auto_approve, state,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.fresh.requestId,
      invite.invite_id,
      input.joinId,
      input.requestSecretHash,
      input.fresh.deviceId,
      input.deviceSecretHash,
      input.joiner.label,
      input.joiner.platform ?? null,
      input.joiner.kind,
      input.devicePublicKey,
      isClaim ? null : (input.commitment ?? null),
      isClaim ? (input.claimProof ?? null) : null,
      autoApprove ? 1 : 0,
      input.now,
      expiresAt,
    );
    const created = this.requireRequest(input.fresh.requestId);
    effects.push({
      type: "control",
      event: { type: "join.requested", request: this.toJoinRequest(created) },
    });
    return { result: this.toJoinResult(host, created), effects };
  }

  /** Host decision. Terminal outcomes are returned as recorded, before any expiry check. */
  decide(input: {
    readonly requestId: string;
    readonly decision: "approve" | "deny";
    readonly deviceLabel?: string;
    readonly now: number;
  }): Outcome<RelayDecisionResult> {
    const request = this.request(input.requestId);
    if (!request) {
      throw new HostCoreError("not-found", "That request was not found.");
    }
    if (isTerminal(request.state)) {
      return { result: this.toDecision(request), effects: [] };
    }

    const effects: HostEffect[] = [];
    if (request.expires_at <= input.now) {
      effects.push(...this.setRequestState(request, "expired", input.now));
      return { result: this.toDecision(this.requireRequest(request.request_id)), effects };
    }

    const invite = this.invite(request.invite_id);
    if (input.decision === "approve") {
      const existing = this.device(request.device_id);
      if (!existing) {
        this.sql.exec(
          `INSERT INTO devices (device_id, secret_hash, label, state, created_at, revoked_at)
           VALUES (?, ?, ?, 'active', ?, NULL)`,
          request.device_id,
          request.device_secret_hash,
          input.deviceLabel ?? request.label,
          input.now,
        );
      }
      effects.push(...this.setRequestState(request, "approved", input.now));
      if (invite && invite.state === "open") {
        effects.push(...this.closeInvite(invite, "used", input.now));
      }
    } else {
      effects.push(...this.setRequestState(request, "denied", input.now));
      if (invite && invite.state === "open") {
        effects.push(...this.closeInvite(invite, "burned", input.now));
      }
    }
    return { result: this.toDecision(this.requireRequest(request.request_id)), effects };
  }

  /**
   * The host's half of a code join's match number. Set once; the joiner has
   * already committed to its own half, so it can't be chosen to match.
   */
  setHostNonce(input: {
    readonly requestId: string;
    readonly hostNonce: string;
    readonly hostPublicKey: string;
    readonly now: number;
  }): Outcome<RelayRequestStatusResult> {
    const request = this.request(input.requestId);
    if (!request) throw new HostCoreError("not-found", "That request was not found.");
    if (request.auto_approve === 1) {
      throw new HostCoreError("forbidden", "Link joins have no number to match.");
    }
    if (request.host_nonce !== null) {
      if (
        request.host_nonce !== input.hostNonce ||
        request.host_public_key !== input.hostPublicKey
      ) {
        throw new HostCoreError("forbidden", "This request already has the computer's nonce.");
      }
      return { result: this.toStatus(request), effects: [] };
    }
    if (request.state !== "pending" || request.expires_at <= input.now) {
      throw new HostCoreError("expired", "That request isn't waiting anymore.");
    }
    this.sql.exec(
      "UPDATE requests SET host_nonce = ?, host_public_key = ? WHERE request_id = ? AND host_nonce IS NULL",
      input.hostNonce,
      input.hostPublicKey,
      request.request_id,
    );
    const updated = this.requireRequest(request.request_id);
    const hostNonce = this.hostNonceOf(updated)!;
    return {
      result: this.toStatus(updated),
      effects: [
        {
          type: "watch",
          requestId: updated.request_id,
          event: { type: "request.host-nonce", hostNonce },
        },
      ],
    };
  }

  /** The joiner's nonce, revealed only after it received the host's. Set once. */
  reveal(input: {
    readonly requestId: string;
    readonly requestSecretHash: string;
    readonly deviceNonce: string;
    readonly now: number;
  }): Outcome<RelayRequestStatusResult> {
    const request = this.authenticateRequest(input.requestId, input.requestSecretHash);
    if (request.host_nonce === null) {
      throw new HostCoreError("forbidden", "Wait for the computer's number first.");
    }
    if (request.device_nonce !== null) {
      if (request.device_nonce !== input.deviceNonce) {
        throw new HostCoreError("forbidden", "This request was already revealed.");
      }
      return { result: this.toStatus(request), effects: [] };
    }
    if (request.state !== "pending" || request.expires_at <= input.now) {
      return { result: this.toStatus(request), effects: [] };
    }
    this.sql.exec(
      "UPDATE requests SET device_nonce = ? WHERE request_id = ? AND device_nonce IS NULL",
      input.deviceNonce,
      request.request_id,
    );
    return {
      result: this.toStatus(this.requireRequest(request.request_id)),
      effects: [
        {
          type: "control",
          event: {
            type: "request.revealed",
            requestId: request.request_id as RelayRequestId,
            deviceNonce: input.deviceNonce,
          },
        },
      ],
    };
  }

  /** Joiner gave up. The invite stays usable for someone else. */
  cancelRequest(input: {
    readonly requestId: string;
    readonly requestSecretHash: string;
    readonly now: number;
  }): Outcome<RelayRequestStatusResult> {
    const request = this.authenticateRequest(input.requestId, input.requestSecretHash);
    if (isTerminal(request.state)) {
      return { result: this.toStatus(request), effects: [] };
    }
    const effects = this.setRequestState(request, "cancelled", input.now);
    return { result: this.toStatus(this.requireRequest(request.request_id)), effects };
  }

  requestStatus(input: {
    readonly requestId: string;
    readonly requestSecretHash: string;
    readonly now: number;
  }): Outcome<RelayRequestStatusResult> {
    const request = this.authenticateRequest(input.requestId, input.requestSecretHash);
    if (request.state === "pending" && request.expires_at <= input.now) {
      const effects = this.setRequestState(request, "expired", input.now);
      return { result: this.toStatus(this.requireRequest(request.request_id)), effects };
    }
    return { result: this.toStatus(request), effects: [] };
  }

  authenticateRequest(requestId: string, requestSecretHash: string): RequestRow {
    const request = this.request(requestId);
    if (!request || !timingSafeEqualString(request.request_secret_hash, requestSecretHash)) {
      throw new HostCoreError("forbidden", "That request doesn't exist or isn't yours.");
    }
    return request;
  }

  /** Pending requests, expiring overdue ones on the way. */
  pendingRequests(now: number): Outcome<ReadonlyArray<RelayJoinRequest>> {
    const effects: HostEffect[] = [];
    const pending: RelayJoinRequest[] = [];
    for (const request of sqlRows<RequestRow>(
      this.sql,
      "SELECT * FROM requests WHERE state = 'pending' ORDER BY created_at",
    )) {
      if (request.expires_at <= now) {
        effects.push(...this.setRequestState(request, "expired", now));
        continue;
      }
      pending.push(this.toJoinRequest(request));
    }
    return { result: pending, effects };
  }

  private setRequestState(
    request: RequestRow,
    state: RelayRequestState,
    now: number,
  ): HostEffect[] {
    this.sql.exec(
      "UPDATE requests SET state = ?, decided_at = ? WHERE request_id = ? AND state = 'pending'",
      state,
      now,
      request.request_id,
    );
    return [
      {
        type: "watch",
        requestId: request.request_id,
        event: {
          type: "request.state",
          state,
          deviceId: request.device_id as RelayDeviceId,
        },
      },
      {
        type: "control",
        event: {
          type: "request.updated",
          requestId: request.request_id as RelayRequestId,
          state,
        },
      },
    ];
  }

  private request(requestId: string): RequestRow | null {
    return (
      sqlRows<RequestRow>(this.sql, "SELECT * FROM requests WHERE request_id = ?", requestId)[0] ??
      null
    );
  }

  private requireRequest(requestId: string): RequestRow {
    const request = this.request(requestId);
    if (!request) throw new HostCoreError("not-found", "That request was not found.");
    return request;
  }

  private requireHost(): HostRow {
    const host = this.host();
    if (!host) throw new HostCoreError("not-found", "This computer is not registered.");
    return host;
  }

  // ----- devices --------------------------------------------------------------

  private device(deviceId: string): DeviceRow | null {
    return (
      sqlRows<DeviceRow>(this.sql, "SELECT * FROM devices WHERE device_id = ?", deviceId)[0] ?? null
    );
  }

  private activeDeviceCount(): number {
    return sqlRows<{ readonly count: number }>(
      this.sql,
      "SELECT COUNT(*) AS count FROM devices WHERE state = 'active'",
    )[0]!.count;
  }

  /** Resolves a device secret. Revoked devices still authenticate so they can learn they were removed. */
  authenticateDevice(deviceId: string, secretHash: string): "active" | "revoked" | null {
    const device = this.device(deviceId);
    if (!device || !timingSafeEqualString(device.secret_hash, secretHash)) {
      return null;
    }
    return device.state;
  }

  revokeDevice(deviceId: string, now: number): Outcome<{ readonly revoked: boolean }> {
    const device = this.device(deviceId);
    if (!device) {
      return { result: { revoked: false }, effects: [] };
    }
    if (device.state !== "revoked") {
      this.sql.exec(
        "UPDATE devices SET state = 'revoked', revoked_at = ? WHERE device_id = ?",
        now,
        deviceId,
      );
    }
    // A removed phone gets no more alerts from this host.
    this.sql.exec("DELETE FROM device_push WHERE device_id = ?", deviceId);
    return {
      result: { revoked: true },
      effects: [
        {
          type: "close-device",
          deviceId,
          code: RELAY_CLOSE_CODE_ACCESS_REMOVED,
          reason: "Access removed.",
        },
      ],
    };
  }

  /** Device list for reconciliation; prunes old tombstones and request history. */
  devices(now: number): ReadonlyArray<RelayDeviceRecord> {
    this.sql.exec(
      "DELETE FROM devices WHERE state = 'revoked' AND revoked_at < ?",
      now - this.limits.tombstoneTtlMs,
    );
    this.sql.exec(
      "DELETE FROM requests WHERE state != 'pending' AND decided_at < ?",
      now - REQUEST_HISTORY_MS,
    );
    this.sql.exec(
      "DELETE FROM invites WHERE state != 'open' AND expires_at < ?",
      now - REQUEST_HISTORY_MS,
    );
    return sqlRows<DeviceRow>(this.sql, "SELECT * FROM devices ORDER BY created_at").map(
      (device) => ({
        deviceId: device.device_id as RelayDeviceId,
        state: device.state,
      }),
    );
  }

  // ----- deadlines ------------------------------------------------------------

  expireDue(now: number): ReadonlyArray<HostEffect> {
    const effects: HostEffect[] = [];
    for (const invite of sqlRows<InviteRow>(
      this.sql,
      "SELECT * FROM invites WHERE state = 'open' AND expires_at <= ?",
      now,
    )) {
      effects.push(...this.closeInvite(invite, "expired", now));
    }
    for (const request of sqlRows<RequestRow>(
      this.sql,
      "SELECT * FROM requests WHERE state = 'pending' AND expires_at <= ?",
      now,
    )) {
      effects.push(...this.setRequestState(request, "expired", now));
    }
    this.pruneHooks(now);
    return effects;
  }

  nextDeadline(): number | null {
    const row = sqlRows<{ readonly deadline: number | null }>(
      this.sql,
      `SELECT MIN(deadline) AS deadline FROM (
         SELECT expires_at AS deadline FROM invites WHERE state = 'open'
         UNION ALL
         SELECT expires_at AS deadline FROM requests WHERE state = 'pending'
         UNION ALL
         SELECT MIN(received_at) + ? AS deadline FROM hook_deliveries
         UNION ALL
         SELECT MIN(retired_at) + ? AS deadline FROM hooks WHERE active = 0
       )`,
      RELAY_HOOK_HOLD_MS,
      RETIRED_HOOK_KEEP_MS,
    )[0];
    return row?.deadline ?? null;
  }

  // ----- usage ----------------------------------------------------------------

  /** Whether committed plus pending usage reaches today's allowance. */
  isLimited(now: number, pending: PendingUsage = NO_PENDING_USAGE): boolean {
    this.rollUsageDay(now);
    return (
      this.usageMessages + pending.messages >= this.limits.dailyMessages ||
      this.usageAwakeSeconds + pending.awakeSeconds >= this.limits.dailyAwakeSeconds
    );
  }

  usage(now: number, pending: PendingUsage = NO_PENDING_USAGE): RelayUsageToday {
    this.rollUsageDay(now);
    return {
      messages: this.usageMessages + pending.messages,
      awakeSeconds: this.usageAwakeSeconds + pending.awakeSeconds,
      messageLimit: this.limits.dailyMessages,
      awakeSecondsLimit: this.limits.dailyAwakeSeconds,
      limited: this.isLimited(now, pending),
      resetsAt: iso(nextUtcMidnight(now)),
      hooks: this.usageHooks,
      hookLimit: this.limits.dailyHooks,
    };
  }

  /** Adds tallies to today's stored usage (one row write). */
  commitUsage(now: number, delta: PendingUsage): void {
    this.rollUsageDay(now);
    if (delta.messages === 0 && delta.awakeSeconds === 0) return;
    this.usageMessages += delta.messages;
    this.usageAwakeSeconds += delta.awakeSeconds;
    this.sql.exec(
      `INSERT INTO usage (day, messages, awake_seconds) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET messages = excluded.messages,
         awake_seconds = excluded.awake_seconds`,
      this.usageDay,
      this.usageMessages,
      this.usageAwakeSeconds,
    );
  }

  private rollUsageDay(now: number): void {
    const day = utcDay(now);
    if (day === this.usageDay) return;
    this.sql.exec("DELETE FROM usage WHERE day < ?", day);
    this.sql.exec("DELETE FROM hook_usage WHERE day < ?", day);
    this.sql.exec("DELETE FROM push_usage WHERE day < ?", day);
    this.usageDay = day;
    const stored = sqlRows<UsageRow>(
      this.sql,
      "SELECT day, messages, awake_seconds FROM usage WHERE day = ?",
      day,
    )[0];
    this.usageMessages = stored?.messages ?? 0;
    this.usageAwakeSeconds = stored?.awake_seconds ?? 0;
    this.usageHooks = this.storedHookCount(day);
  }

  private storedHookCount(day: string): number {
    return (
      sqlRows<{ readonly hooks: number }>(
        this.sql,
        "SELECT hooks FROM hook_usage WHERE day = ?",
        day,
      )[0]?.hooks ?? 0
    );
  }

  // ----- push alerts ------------------------------------------------------------
  //
  // A phone registers its push subscription here itself (device secret), so
  // the host never learns the endpoint. The host asks to send an alert it
  // sealed for one registration; the relay sends it only while the phone is
  // active, the registration is still that one, the phone wants that kind of
  // alert, and today's allowances hold. Allowances are charged before the
  // send, so a failed send still counts.

  /** Records the phone's subscription and the alerts it wants (replacing any earlier one). */
  setDevicePush(input: {
    readonly deviceId: string;
    readonly registrationId: string;
    readonly endpoint: string;
    readonly keyId: string;
    readonly kinds: PushAlertKinds;
    readonly now: number;
  }): void {
    if (this.device(input.deviceId)?.state !== "active") {
      throw new HostCoreError("forbidden", "This device no longer has access.");
    }
    this.sql.exec(
      `INSERT INTO device_push (device_id, registration_id, endpoint, key_id, kinds, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET registration_id = excluded.registration_id,
         endpoint = excluded.endpoint, key_id = excluded.key_id, kinds = excluded.kinds,
         updated_at = excluded.updated_at`,
      input.deviceId,
      input.registrationId,
      input.endpoint,
      input.keyId,
      JSON.stringify(input.kinds),
      input.now,
    );
  }

  /** The phone turned alerts off: forget its subscription. */
  removeDevicePush(deviceId: string): void {
    this.sql.exec("DELETE FROM device_push WHERE device_id = ?", deviceId);
  }

  /**
   * Whether an alert the host sealed for `registrationId` may go out now, and
   * where. A `send` answer has already been charged to today's allowances.
   */
  admitAlert(input: {
    readonly deviceId: string;
    readonly registrationId: string;
    readonly kind: RelayAlertKind;
    readonly now: number;
  }):
    | {
        readonly decision: "send";
        readonly endpoint: string;
        readonly keyId: string;
      }
    | {
        readonly decision: Exclude<RelayDeviceAlertOutcome, "sent" | "retry" | "rejected" | "gone">;
      } {
    if (this.device(input.deviceId)?.state !== "active") return { decision: "unavailable" };
    const push = sqlRows<DevicePushRow>(
      this.sql,
      "SELECT * FROM device_push WHERE device_id = ?",
      input.deviceId,
    )[0];
    if (!push) return { decision: "unavailable" };
    if (push.registration_id !== input.registrationId) return { decision: "stale" };
    if (input.kind !== "test" && !parseKinds(push.kinds)[input.kind]) {
      return { decision: "muted" };
    }
    this.rollUsageDay(input.now);
    const hostAlerts = this.storedAlertCount("");
    const deviceAlerts = this.storedAlertCount(input.deviceId);
    if (hostAlerts >= this.limits.dailyAlerts || deviceAlerts >= this.limits.dailyAlertsPerDevice) {
      return { decision: "limited" };
    }
    for (const [deviceId, alerts] of [
      ["", hostAlerts + 1],
      [input.deviceId, deviceAlerts + 1],
    ] as const) {
      this.sql.exec(
        `INSERT INTO push_usage (day, device_id, alerts) VALUES (?, ?, ?)
         ON CONFLICT(day, device_id) DO UPDATE SET alerts = excluded.alerts`,
        this.usageDay,
        deviceId,
        alerts,
      );
    }
    return { decision: "send", endpoint: push.endpoint, keyId: push.key_id };
  }

  /**
   * The push service said the subscription ended. Forgets it only if it is
   * still the one the alert was sent to: the phone may have re-subscribed.
   */
  forgetDevicePush(deviceId: string, registrationId: string): void {
    this.sql.exec(
      "DELETE FROM device_push WHERE device_id = ? AND registration_id = ?",
      deviceId,
      registrationId,
    );
  }

  private storedAlertCount(deviceId: string): number {
    return (
      sqlRows<{ readonly alerts: number }>(
        this.sql,
        "SELECT alerts FROM push_usage WHERE day = ? AND device_id = ?",
        this.usageDay,
        deviceId,
      )[0]?.alerts ?? 0
    );
  }

  // ----- hooks ------------------------------------------------------------------
  //
  // Event tasks' addresses (docs/design/event-tasks.md). The host changes its
  // hooks only with a revision, and a call applies only if its revision is
  // newer than the last applied one, so a late or reordered call can't undo a
  // newer one. Deliveries are stored sealed to the host's hook key and wait
  // until the host acknowledges them, a day at most.

  /** The last hook revision applied; 0 before any. */
  hookRevision(): number {
    return (
      sqlRows<{ readonly revision: number }>(
        this.sql,
        "SELECT revision FROM hook_state WHERE id = 1",
      )[0]?.revision ?? 0
    );
  }

  private setHookRevision(revision: number, publicKey: string): void {
    this.sql.exec(
      `INSERT INTO hook_state (id, revision, public_key) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
         public_key = excluded.public_key`,
      revision,
      publicKey,
    );
  }

  /** Adds an active hook, unless a newer revision was already applied. */
  mintHook(input: {
    readonly hookId: string;
    readonly revision: number;
    readonly publicKey: string;
    readonly keptHeaders: ReadonlyArray<string>;
    readonly now: number;
  }): RelayHookStateResult {
    const current = this.hookRevision();
    if (input.revision <= current) return { applied: false, revision: current };
    const count = sqlRows<{ readonly count: number }>(
      this.sql,
      "SELECT COUNT(*) AS count FROM hooks",
    )[0]!.count;
    if (count >= this.limits.maxHooks) {
      throw new HostCoreError(
        "too-many-hooks",
        "This computer has as many event addresses as the relay keeps. Remove some first.",
      );
    }
    this.sql.exec(
      `INSERT INTO hooks (hook_id, kept_headers, active, created_at, retired_at)
       VALUES (?, ?, 1, ?, NULL)`,
      input.hookId,
      JSON.stringify(input.keptHeaders),
      input.now,
    );
    this.setHookRevision(input.revision, input.publicKey);
    return { applied: true, revision: input.revision };
  }

  /**
   * The host's whole wanted state: named hooks active with these kept
   * headers (a retired one still kept comes back), every other one retired.
   * Hooks this host never minted here are ignored.
   */
  setHooks(input: {
    readonly revision: number;
    readonly publicKey: string;
    readonly active: ReadonlyArray<{
      readonly hookId: string;
      readonly keptHeaders: ReadonlyArray<string>;
    }>;
    readonly now: number;
  }): RelayHookStateResult {
    const current = this.hookRevision();
    if (input.revision <= current) return { applied: false, revision: current };
    const wanted = new Map(input.active.map((hook) => [hook.hookId, hook.keptHeaders]));
    for (const hook of sqlRows<HookRow>(this.sql, "SELECT * FROM hooks")) {
      const keptHeaders = wanted.get(hook.hook_id);
      if (keptHeaders !== undefined) {
        this.sql.exec(
          "UPDATE hooks SET active = 1, kept_headers = ?, retired_at = NULL WHERE hook_id = ?",
          JSON.stringify(keptHeaders),
          hook.hook_id,
        );
      } else if (hook.active === 1) {
        this.sql.exec(
          "UPDATE hooks SET active = 0, retired_at = ? WHERE hook_id = ?",
          input.now,
          hook.hook_id,
        );
      }
    }
    this.setHookRevision(input.revision, input.publicKey);
    return { applied: true, revision: input.revision };
  }

  /**
   * Whether a delivery to `hookId` may come in now: the hook is active, the
   * host has hooks (and messages) left today, and its queue has room for
   * `size` more sealed bytes.
   */
  admitHookDelivery(input: {
    readonly hookId: string;
    readonly now: number;
    readonly pending?: PendingUsage;
    readonly size?: number;
  }): HookAdmission {
    const hook =
      sqlRows<HookRow>(
        this.sql,
        "SELECT * FROM hooks WHERE hook_id = ? AND active = 1",
        input.hookId,
      )[0] ?? null;
    const publicKey =
      sqlRows<{ readonly public_key: string }>(
        this.sql,
        "SELECT public_key FROM hook_state WHERE id = 1",
      )[0]?.public_key ?? null;
    if (!hook || !publicKey) return { ok: false, status: 404, reason: "unknown-hook" };

    if (this.isLimited(input.now, input.pending) || this.usageHooks >= this.limits.dailyHooks) {
      return {
        ok: false,
        status: 429,
        reason: "daily-limit",
        retryAfterSeconds: Math.ceil((nextUtcMidnight(input.now) - input.now) / 1000),
      };
    }

    this.pruneHooks(input.now);
    const queued = sqlRows<{ readonly count: number; readonly bytes: number }>(
      this.sql,
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM hook_deliveries",
    )[0]!;
    if (
      queued.count + 1 > this.limits.maxPendingHookDeliveries ||
      queued.bytes + Math.max(input.size ?? 0, 1) > this.limits.maxPendingHookBytes
    ) {
      return {
        ok: false,
        status: 429,
        reason: "queue-full",
        retryAfterSeconds: HOOK_QUEUE_FULL_RETRY_SECONDS,
      };
    }
    return { ok: true, keptHeaders: parseStoredHeaders(hook.kept_headers), publicKey };
  }

  /**
   * Stores a sealed delivery, admitted again now that its size is known (the
   * object may have taken other deliveries while this one was read and
   * sealed). Counts it as one of today's hooks and one message, and hands it
   * to the host: whole when it fits on the control socket, announced
   * otherwise.
   */
  storeHookDelivery(input: {
    readonly deliveryId: string;
    readonly hookId: string;
    readonly sealed: string;
    readonly now: number;
    readonly pending?: PendingUsage;
  }): Outcome<HookAdmission> {
    const size = input.sealed.length;
    const admission = this.admitHookDelivery({
      hookId: input.hookId,
      now: input.now,
      ...(input.pending ? { pending: input.pending } : {}),
      size,
    });
    if (!admission.ok) return { result: admission, effects: [] };
    this.sql.exec(
      `INSERT INTO hook_deliveries (delivery_id, hook_id, received_at, size, sealed)
       VALUES (?, ?, ?, ?, ?)`,
      input.deliveryId,
      input.hookId,
      input.now,
      size,
      input.sealed,
    );
    this.commitUsage(input.now, { messages: 1, awakeSeconds: 0 });
    this.usageHooks += 1;
    this.sql.exec(
      `INSERT INTO hook_usage (day, hooks) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET hooks = excluded.hooks`,
      this.usageDay,
      this.usageHooks,
    );
    const row: HookDeliveryRow = {
      delivery_id: input.deliveryId,
      hook_id: input.hookId,
      received_at: input.now,
      size,
    };
    return {
      result: admission,
      effects: [
        { type: "control", event: this.hookDeliveryEvent(row, input.sealed) },
        { type: "control", event: { type: "usage", usage: this.usage(input.now, input.pending) } },
      ],
    };
  }

  /** A waiting delivery, for the host to fetch when it was too large for the socket. */
  hookDelivery(deliveryId: string): RelayHookDelivery | null {
    const row =
      sqlRows<HookDeliveryRow & { readonly sealed: string }>(
        this.sql,
        "SELECT * FROM hook_deliveries WHERE delivery_id = ?",
        deliveryId,
      )[0] ?? null;
    return row
      ? {
          deliveryId: row.delivery_id as RelayHookDeliveryId,
          hookId: row.hook_id as RelayHookId,
          receivedAt: iso(row.received_at),
          sealed: row.sealed,
        }
      : null;
  }

  /** The host stored these; forget them. Unknown ids are ignored. */
  ackHookDeliveries(deliveryIds: ReadonlyArray<string>): void {
    for (const deliveryId of deliveryIds) {
      this.sql.exec("DELETE FROM hook_deliveries WHERE delivery_id = ?", deliveryId);
    }
  }

  /**
   * Every waiting delivery, oldest first, for a host that just connected.
   * Whole deliveries go out until `inlineBudget` sealed bytes are used; the
   * rest are announced and fetched, so a long-asleep host isn't sent tens of
   * megabytes on one socket at once.
   */
  hookReplay(now: number, inlineBudget: number): RelayControlEvent[] {
    this.pruneHooks(now);
    let budget = inlineBudget;
    const events: RelayControlEvent[] = [];
    for (const row of sqlRows<HookDeliveryRow>(
      this.sql,
      `SELECT delivery_id, hook_id, received_at, size FROM hook_deliveries
       ORDER BY received_at, rowid`,
    )) {
      const inline = row.size <= RELAY_HOOK_INLINE_SEALED_BYTES && row.size <= budget;
      if (!inline) {
        events.push(this.hookDeliveryEvent(row, null));
        continue;
      }
      budget -= row.size;
      const sealed = sqlRows<{ readonly sealed: string }>(
        this.sql,
        "SELECT sealed FROM hook_deliveries WHERE delivery_id = ?",
        row.delivery_id,
      )[0]?.sealed;
      if (sealed !== undefined) events.push(this.hookDeliveryEvent(row, sealed));
    }
    return events;
  }

  /** Drops deliveries held past a day and retired hooks past their keep time. */
  private pruneHooks(now: number): void {
    this.sql.exec("DELETE FROM hook_deliveries WHERE received_at <= ?", now - RELAY_HOOK_HOLD_MS);
    this.sql.exec(
      "DELETE FROM hooks WHERE active = 0 AND retired_at <= ?",
      now - RETIRED_HOOK_KEEP_MS,
    );
  }

  private hookDeliveryEvent(row: HookDeliveryRow, sealed: string | null): RelayControlEvent {
    const base = {
      deliveryId: row.delivery_id as RelayHookDeliveryId,
      hookId: row.hook_id as RelayHookId,
      receivedAt: iso(row.received_at),
    };
    return sealed !== null && row.size <= RELAY_HOOK_INLINE_SEALED_BYTES
      ? { type: "hook.delivery", delivery: { ...base, sealed } }
      : { type: "hook.pending", ...base, size: row.size };
  }

  // ----- mapping --------------------------------------------------------------

  private hostNonceOf(request: RequestRow) {
    return request.host_nonce !== null && request.host_public_key !== null
      ? { hostNonce: request.host_nonce, hostPublicKey: request.host_public_key }
      : null;
  }

  private toJoinRequest(request: RequestRow): RelayJoinRequest {
    return {
      requestId: request.request_id as RelayRequestId,
      inviteId: request.invite_id as RelayInviteId,
      joinId: request.join_id,
      deviceId: request.device_id as RelayDeviceId,
      devicePublicKey: request.device_public_key,
      joiner: {
        label: request.label,
        ...(request.platform ? { platform: request.platform } : {}),
        kind: request.kind as RelayDeviceKind,
      },
      ...(request.commitment !== null ? { commitment: request.commitment } : {}),
      ...(request.claim_proof !== null ? { claimProof: request.claim_proof } : {}),
      ...(request.host_nonce !== null ? { hostNonce: request.host_nonce } : {}),
      ...(request.device_nonce !== null ? { deviceNonce: request.device_nonce } : {}),
      autoApprove: request.auto_approve === 1,
      state: request.state,
      createdAt: iso(request.created_at),
      expiresAt: iso(request.expires_at),
    };
  }

  private toJoinResult(host: HostRow, request: RequestRow): RelayJoinResult {
    return {
      hostId: host.host_id as RelayHostId,
      hostEnvironmentId: host.environment_id,
      requestId: request.request_id as RelayRequestId,
      deviceId: request.device_id as RelayDeviceId,
      hostLabel: host.label,
      autoApprove: request.auto_approve === 1,
      expiresAt: iso(request.expires_at),
    };
  }

  private toDecision(request: RequestRow): RelayDecisionResult {
    return {
      requestId: request.request_id as RelayRequestId,
      deviceId: request.device_id as RelayDeviceId,
      state: request.state,
    };
  }

  private toStatus(request: RequestRow): RelayRequestStatusResult {
    const hostNonce = this.hostNonceOf(request);
    return {
      requestId: request.request_id as RelayRequestId,
      deviceId: request.device_id as RelayDeviceId,
      state: request.state,
      ...(hostNonce ? { hostNonce } : {}),
    };
  }
}

function parseStoredHeaders(text: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** A join failure that still changed state (for example it expired an old request). */
export class HostCoreErrorWithEffects extends HostCoreError {
  readonly effects: ReadonlyArray<HostEffect>;

  constructor(code: HostCoreErrorCode, message: string, effects: ReadonlyArray<HostEffect>) {
    super(code, message);
    this.effects = effects;
  }
}
