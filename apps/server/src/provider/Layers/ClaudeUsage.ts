/**
 * ClaudeUsage — subscription usage snapshot for the Claude provider card.
 *
 * The data behind Claude Code's `/usage` screen is served by Anthropic's
 * OAuth usage endpoint, which the wider Claude Code tooling ecosystem
 * (statusline plugins, usage monitors) reads with the same scoped OAuth
 * credential Claude Code maintains in `<home>/.claude/.credentials.json` or
 * macOS Keychain. (The Agent SDK now also exposes an experimental `get_usage`
 * control request on live sessions, but the probe needs usage without a
 * running session, so the endpoint remains the source here. Mid-turn deltas
 * arrive separately via `rate_limit_event` — see
 * `applyClaudeRateLimitInfoToAccountUsage` below.)
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` is intentionally not
 * used here. It is valid for long-lived inference auth, but the usage endpoint
 * rejects it without the profile/usage scope and may then apply long Retry-After
 * windows. Chat can still work while usage is unavailable.
 *
 * The endpoint is unofficial, so no step here fails the provider probe. A
 * check that cannot produce numbers says why (`ClaudeUsageCheck`): the
 * sign-in is confirmed gone, the endpoint is rate limiting, or it could not
 * be reached. The driver keeps showing the last reading meanwhile (see
 * `carryClaudeAccountUsageForward`). We still log redacted diagnostics and
 * honor Retry-After so a rate-limited check doesn't keep hammering the endpoint.
 *
 * This module never writes or refreshes the credential itself — the CLI owns
 * the credential store and its refresh-token rotation. When the access token
 * has expired (401), the fetch delegates to an injected refresh effect that
 * runs a real Claude turn on normal sign-in auth, then retries once against
 * the re-read store. See `fetchClaudeAccountUsage`.
 *
 * @module provider/Layers/ClaudeUsage
 */
import type {
  ServerProviderAccountUsage,
  ServerProviderAuthCapabilityReason,
  ServerProviderScopedUsageWindow,
  ServerProviderUsageWindow,
} from "@threadlines/contracts";
import { createHash } from "node:crypto";
import * as NodeOS from "node:os";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type ClaudeFolderConfig,
  makeClaudeEnvironment,
  resolveClaudeConfigDir,
} from "../Drivers/ClaudeHome.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_MACOS_KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_FETCH_TIMEOUT_MS = 4_000;
const KEYCHAIN_READ_TIMEOUT_MS = 1_500;
const FIVE_HOUR_WINDOW_MINS = 300;
const SEVEN_DAY_WINDOW_MINS = 10_080;
const CLAUDE_USAGE_BACKOFF_MAX_MS = 60 * 60 * 1000;
const CLAUDE_USAGE_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const claudeUsageBackoffUntilMsByCredential = new Map<string, number>();
// Keyed like the backoff map: a genuinely revoked sign-in keeps producing the
// same stale token, so its key stays cooled down; a fresh sign-in rotates the
// token and gets a new key (and an immediate refresh attempt).
const claudeUsageRefreshCooldownUntilMsByCredential = new Map<string, number>();
// Concurrent refresh turns would race Anthropic's refresh-token rotation
// against each other; only ever run one at a time.
let claudeUsageCredentialRefreshInFlight = false;

const ClaudeCredentialAccount = Schema.Struct({
  email: Schema.optional(Schema.String),
});

const ClaudeCredentialsPayload = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      refreshToken: Schema.optional(Schema.NullOr(Schema.String)),
      expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
      email: Schema.optional(Schema.String),
      account: Schema.optional(ClaudeCredentialAccount),
    }),
  ),
  account: Schema.optional(ClaudeCredentialAccount),
  email: Schema.optional(Schema.String),
  userEmail: Schema.optional(Schema.String),
  organizationUuid: Schema.optional(Schema.String),
});
type ClaudeCredentialsPayload = typeof ClaudeCredentialsPayload.Type;

const ClaudeCredentialsFile = Schema.fromJsonString(ClaudeCredentialsPayload);
const decodeClaudeCredentialsFile = Schema.decodeUnknownEffect(ClaudeCredentialsFile);

const ClaudeUsageWindow = Schema.Struct({
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
});
export type ClaudeUsageWindow = typeof ClaudeUsageWindow.Type;

/**
 * Entry in the endpoint's generic `limits` array. Unscoped entries (`scope`
 * null) duplicate `five_hour`/`seven_day`; scoped entries describe limits
 * that only apply to part of the account's usage (e.g. one model's weekly
 * cap) and have no dedicated top-level field.
 */
const ClaudeUsageLimitEntry = Schema.Struct({
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  group: Schema.optional(Schema.NullOr(Schema.String)),
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  severity: Schema.optional(Schema.NullOr(Schema.String)),
  resets_at: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              display_name: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
        surface: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type ClaudeUsageLimitEntry = typeof ClaudeUsageLimitEntry.Type;

const ClaudeOAuthUsageResponse = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeUsageWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeUsageWindow)),
  limits: Schema.optional(Schema.NullOr(Schema.Array(ClaudeUsageLimitEntry))),
});
export type ClaudeOAuthUsageResponse = typeof ClaudeOAuthUsageResponse.Type;
const decodeClaudeOAuthUsageResponse = Schema.decodeUnknownEffect(ClaudeOAuthUsageResponse);

const KNOWN_CLAUDE_USAGE_FIELDS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "cinder_cove",
  "extra_usage",
  "limits",
] as const;

const CLAUDE_USAGE_LIMIT_GROUP_DURATION_MINS: Record<string, number> = {
  session: FIVE_HOUR_WINDOW_MINS,
  daily: 1_440,
  weekly: SEVEN_DAY_WINDOW_MINS,
};

function normalizeUsagePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * The endpoint reports `resets_at` as an ISO 8601 string; tolerate epoch
 * numbers too. Normalized to epoch milliseconds — the UI's reset-countdown
 * formatter accepts either seconds or milliseconds.
 */
export function normalizeClaudeUsageResetsAt(
  value: string | number | null | undefined,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function normalizeClaudeUsageWindow(
  window: ClaudeUsageWindow | null | undefined,
  windowDurationMins: number,
): ServerProviderUsageWindow | undefined {
  if (!window || typeof window.utilization !== "number") return undefined;

  const usedPercent = normalizeUsagePercent(window.utilization);
  const resetsAt = normalizeClaudeUsageResetsAt(window.resets_at);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    windowDurationMins,
  };
}

/**
 * Map a scoped `limits` entry (non-null `scope`) onto a scoped usage window.
 * Unscoped entries are skipped — they duplicate `five_hour`/`seven_day` —
 * as are entries without a percent or a usable scope label.
 */
export function normalizeClaudeScopedUsageWindow(
  entry: ClaudeUsageLimitEntry,
): ServerProviderScopedUsageWindow | undefined {
  if (!entry.scope || typeof entry.percent !== "number") return undefined;

  const scopeLabel = entry.scope.model?.display_name?.trim() || entry.scope.surface?.trim();
  if (!scopeLabel) return undefined;

  const usedPercent = normalizeUsagePercent(entry.percent);
  const resetsAt = normalizeClaudeUsageResetsAt(entry.resets_at);
  const windowDurationMins =
    typeof entry.group === "string"
      ? CLAUDE_USAGE_LIMIT_GROUP_DURATION_MINS[entry.group]
      : undefined;
  const severity = entry.severity?.trim();
  return {
    scopeLabel,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(severity ? { severity } : {}),
  };
}

export function normalizeClaudeAccountUsage(
  payload: ClaudeOAuthUsageResponse,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  const primary = normalizeClaudeUsageWindow(payload.five_hour, FIVE_HOUR_WINDOW_MINS);
  const secondary = normalizeClaudeUsageWindow(payload.seven_day, SEVEN_DAY_WINDOW_MINS);
  const scoped = (payload.limits ?? [])
    .map((entry) => normalizeClaudeScopedUsageWindow(entry))
    .filter((window): window is ServerProviderScopedUsageWindow => window !== undefined);
  if (!primary && !secondary && scoped.length === 0) return undefined;

  // Each window records when it was read, so a reading kept across a failed
  // check can say how old it is.
  return {
    source: "claude-oauth-usage",
    checkedAt,
    primaryLimitId: "claude",
    limits: [
      {
        limitId: "claude",
        ...(primary ? { primary: { ...primary, checkedAt } } : {}),
        ...(secondary ? { secondary: { ...secondary, checkedAt } } : {}),
        ...(scoped.length > 0
          ? { scoped: scoped.map((window) => ({ ...window, checkedAt })) }
          : {}),
      },
    ],
  };
}

/**
 * How long a reading stands before an event that repeats it is worth
 * publishing again. An unchanged window publishes nothing, so without this a
 * steady reading would look older and older while events keep confirming it.
 */
const CLAUDE_USAGE_READING_CONFIRM_INTERVAL_MS = 5 * 60 * 1000;

function isReadingDueForConfirmation(readAt: string | undefined, checkedAt: string): boolean {
  const readAtMs = readAt === undefined ? Number.NaN : Date.parse(readAt);
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(readAtMs)) return true;
  return (
    Number.isFinite(checkedAtMs) &&
    checkedAtMs - readAtMs >= CLAUDE_USAGE_READING_CONFIRM_INTERVAL_MS
  );
}

/** Endpoint readings carry reset times in epoch milliseconds, events in seconds. */
function usageResetTimeMs(resetsAt: number | undefined): number | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
}

function hasUsageWindowReset(
  window: { readonly resetsAt?: number | undefined },
  nowMs: number,
): boolean {
  const resetMs = usageResetTimeMs(window.resetsAt);
  return resetMs !== undefined && resetMs <= nowMs;
}

/**
 * The usage to keep showing when a check produced no numbers: the previous
 * reading, moved forward to `nowMs`. A window whose reset time has passed
 * starts over: nothing used, and no reset time until it is read again. Each
 * window keeps the time it was read, so the client can say how old it is.
 * `undefined` when there is no window to keep.
 */
export function carryClaudeAccountUsageForward(
  previous: ServerProviderAccountUsage | undefined,
  nowMs: number,
): ServerProviderAccountUsage | undefined {
  if (!previous || previous.source !== "claude-oauth-usage") return undefined;

  // A reading saved before windows recorded their own time is as old as the
  // snapshot it came in: without that it would pass for a current one.
  const rollWindow = (stored: ServerProviderUsageWindow): ServerProviderUsageWindow => {
    const window = stored.checkedAt ? stored : { ...stored, checkedAt: previous.checkedAt };
    if (!hasUsageWindowReset(window, nowMs)) return window;
    const { resetsAt: _resetsAt, ...rest } = window;
    return { ...rest, usedPercent: 0, remainingPercent: 100 };
  };
  const rollScopedWindow = (
    stored: ServerProviderScopedUsageWindow,
  ): ServerProviderScopedUsageWindow => {
    const window = stored.checkedAt ? stored : { ...stored, checkedAt: previous.checkedAt };
    if (!hasUsageWindowReset(window, nowMs)) return window;
    const { resetsAt: _resetsAt, severity: _severity, ...rest } = window;
    return { ...rest, usedPercent: 0, remainingPercent: 100 };
  };

  const limits = previous.limits.flatMap((limit) => {
    const hasWindows =
      limit.primary !== undefined ||
      limit.secondary !== undefined ||
      (limit.scoped?.length ?? 0) > 0;
    if (!hasWindows) return [];
    return [
      {
        ...limit,
        ...(limit.primary ? { primary: rollWindow(limit.primary) } : {}),
        ...(limit.secondary ? { secondary: rollWindow(limit.secondary) } : {}),
        ...(limit.scoped ? { scoped: limit.scoped.map(rollScopedWindow) } : {}),
      },
    ];
  });
  return limits.length > 0 ? { ...previous, limits } : undefined;
}

function isNewerReading(candidate: string | undefined, than: string | undefined): boolean {
  const candidateMs = candidate === undefined ? Number.NaN : Date.parse(candidate);
  const thanMs = than === undefined ? Number.NaN : Date.parse(than);
  return Number.isFinite(candidateMs) && Number.isFinite(thanMs) && candidateMs > thanMs;
}

/**
 * A fresh endpoint reading with any window swapped for the previous one when
 * that was read later. A check takes seconds, and a chat reply can publish a
 * newer window while it runs: publishing the check must not roll that back.
 * The endpoint still decides which windows exist, so only windows it
 * returned are considered. Returns `fresh` itself when nothing was newer.
 */
export function preferNewerClaudeUsageReadings(
  previous: ServerProviderAccountUsage | undefined,
  fresh: ServerProviderAccountUsage | undefined,
): ServerProviderAccountUsage | undefined {
  if (!previous || !fresh || previous.source !== fresh.source) return fresh;
  let changed = false;
  const limits = fresh.limits.map((limit) => {
    const earlier = previous.limits.find((candidate) => candidate.limitId === limit.limitId);
    if (!earlier) return limit;
    const pick = <Window extends { readonly checkedAt?: string | undefined }>(
      freshWindow: Window | undefined,
      earlierWindow: Window | undefined,
    ): Window | undefined => {
      if (
        freshWindow === undefined ||
        earlierWindow === undefined ||
        !isNewerReading(earlierWindow.checkedAt, freshWindow.checkedAt)
      ) {
        return freshWindow;
      }
      changed = true;
      return earlierWindow;
    };
    const primary = pick(limit.primary, earlier.primary);
    const secondary = pick(limit.secondary, earlier.secondary);
    const scoped = limit.scoped?.map(
      (window) =>
        pick(
          window,
          earlier.scoped?.find((candidate) => candidate.scopeLabel === window.scopeLabel),
        ) ?? window,
    );
    return {
      ...limit,
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(scoped ? { scoped } : {}),
    };
  });
  return changed ? { ...fresh, limits } : fresh;
}

/** One window's reading in a `rate_limit_event`. */
export interface ClaudeRateLimitEventWindow {
  readonly utilization?: number | undefined;
  readonly resetsAt?: number | undefined;
}

/**
 * The Agent SDK's `rate_limit_event` stream message. Structural subset of
 * the SDK's `SDKRateLimitInfo` so this module stays decoupled from the SDK
 * package. Unlike the OAuth endpoint's 0–100 `utilization`, the event's is a
 * 0–1 fraction (0.79 = 79%), with `resetsAt` in epoch seconds.
 *
 * The top-level window (`rateLimitType` + `utilization`) only carries a
 * reading once it crosses a warning threshold. `unifiedWindows` carries
 * every window the CLI tracked on each response; the CLI sends it at
 * runtime but the SDK's typings omit it, so it is read defensively.
 */
export interface ClaudeRateLimitEventInfo extends ClaudeRateLimitEventWindow {
  readonly rateLimitType?: string | undefined;
  readonly unifiedWindows?: unknown;
}

const CLAUDE_RATE_LIMIT_EVENT_WINDOWS: Record<
  string,
  { readonly field: "primary" | "secondary"; readonly windowDurationMins: number }
> = {
  five_hour: { field: "primary", windowDurationMins: FIVE_HOUR_WINDOW_MINS },
  seven_day: { field: "secondary", windowDurationMins: SEVEN_DAY_WINDOW_MINS },
};

/**
 * Per-model window types map onto the scoped windows the OAuth endpoint
 * reports. The event only carries the enum (no display label), so patches
 * apply to an existing scoped entry whose label matches — never create one.
 */
const CLAUDE_RATE_LIMIT_EVENT_SCOPED_KEYWORDS: Record<string, string> = {
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
};

type ClaudeUsageLimit = ServerProviderAccountUsage["limits"][number];

function claudeUsageLimitIndex(usage: ServerProviderAccountUsage): number {
  const targetLimitId = usage.primaryLimitId ?? "claude";
  const index = usage.limits.findIndex((limit) => limit.limitId === targetLimitId);
  return index >= 0 ? index : 0;
}

function usageWindowsEqual(
  left: ServerProviderUsageWindow | undefined,
  right: ServerProviderUsageWindow,
): boolean {
  return (
    left !== undefined &&
    left.usedPercent === right.usedPercent &&
    left.remainingPercent === right.remainingPercent &&
    left.resetsAt === right.resetsAt &&
    left.windowDurationMins === right.windowDurationMins
  );
}

function withClaudeUsageWindow(
  limit: ClaudeUsageLimit,
  field: "primary" | "secondary",
  window: ServerProviderUsageWindow,
): ClaudeUsageLimit {
  return field === "primary" ? { ...limit, primary: window } : { ...limit, secondary: window };
}

/**
 * Every window reading in one event, keyed by window type. `unifiedWindows`
 * entries win over the top-level window; the two agree when both are sent.
 */
function readClaudeRateLimitEventWindows(
  info: ClaudeRateLimitEventInfo,
): Map<string, ClaudeRateLimitEventWindow> {
  const windows = new Map<string, ClaudeRateLimitEventWindow>();
  if (info.rateLimitType) {
    windows.set(info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt });
  }
  if (info.unifiedWindows && typeof info.unifiedWindows === "object") {
    for (const [rateLimitType, window] of Object.entries(
      info.unifiedWindows as Record<string, unknown>,
    )) {
      if (window && typeof window === "object") windows.set(rateLimitType, window);
    }
  }
  return windows;
}

/**
 * Merge a live `rate_limit_event` into the usage snapshot fetched from the
 * OAuth endpoint. Each window the event reports patches its matching window;
 * the rest of the snapshot is preserved. Returns `undefined` when there is
 * nothing to apply (unknown window types, missing utilization, or a reading
 * that only repeats a recent one).
 */
export function applyClaudeRateLimitInfoToAccountUsage(
  current: ServerProviderAccountUsage | undefined,
  info: ClaudeRateLimitEventInfo,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  let next = current;
  for (const [rateLimitType, window] of readClaudeRateLimitEventWindows(info)) {
    next = applyClaudeRateLimitWindow(next, rateLimitType, window, checkedAt) ?? next;
  }
  return next === current ? undefined : next;
}

function applyClaudeRateLimitWindow(
  current: ServerProviderAccountUsage | undefined,
  rateLimitType: string,
  window: ClaudeRateLimitEventWindow,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  if (typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) {
    return undefined;
  }

  const usedPercent = normalizeUsagePercent(window.utilization * 100);
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const resetsAt = normalizeClaudeUsageResetsAt(window.resetsAt);

  const windowTarget = CLAUDE_RATE_LIMIT_EVENT_WINDOWS[rateLimitType];
  if (windowTarget) {
    const nextWindow: ServerProviderUsageWindow = {
      usedPercent,
      remainingPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      windowDurationMins: windowTarget.windowDurationMins,
      checkedAt,
    };
    if (!current) {
      return {
        source: "claude-oauth-usage",
        checkedAt,
        primaryLimitId: "claude",
        limits: [withClaudeUsageWindow({ limitId: "claude" }, windowTarget.field, nextWindow)],
      };
    }

    const limitIndex = claudeUsageLimitIndex(current);
    const existingLimit = current.limits[limitIndex];
    if (!existingLimit) {
      return {
        ...current,
        checkedAt,
        limits: [
          ...current.limits,
          withClaudeUsageWindow({ limitId: "claude" }, windowTarget.field, nextWindow),
        ],
      };
    }
    const existingWindow = existingLimit[windowTarget.field];
    if (
      usageWindowsEqual(existingWindow, nextWindow) &&
      !isReadingDueForConfirmation(existingWindow?.checkedAt, checkedAt)
    ) {
      return undefined;
    }
    return {
      ...current,
      checkedAt,
      limits: current.limits.map((limit, index) =>
        index === limitIndex ? withClaudeUsageWindow(limit, windowTarget.field, nextWindow) : limit,
      ),
    };
  }

  const scopedKeyword = CLAUDE_RATE_LIMIT_EVENT_SCOPED_KEYWORDS[rateLimitType];
  if (!scopedKeyword || !current) return undefined;

  const limitIndex = claudeUsageLimitIndex(current);
  const existingLimit = current.limits[limitIndex];
  const scoped = existingLimit?.scoped;
  if (!existingLimit || !scoped) return undefined;

  const scopedIndex = scoped.findIndex((window) =>
    window.scopeLabel.toLowerCase().includes(scopedKeyword),
  );
  const existingScoped = scopedIndex >= 0 ? scoped[scopedIndex] : undefined;
  if (!existingScoped) return undefined;

  const nextScoped: ServerProviderScopedUsageWindow = {
    ...existingScoped,
    usedPercent,
    remainingPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    checkedAt,
  };
  if (
    existingScoped.usedPercent === nextScoped.usedPercent &&
    existingScoped.remainingPercent === nextScoped.remainingPercent &&
    existingScoped.resetsAt === nextScoped.resetsAt &&
    !isReadingDueForConfirmation(existingScoped.checkedAt, checkedAt)
  ) {
    return undefined;
  }
  return {
    ...current,
    checkedAt,
    limits: current.limits.map((limit, index) =>
      index === limitIndex
        ? {
            ...limit,
            scoped: scoped.map((window, index2) => (index2 === scopedIndex ? nextScoped : window)),
          }
        : limit,
    ),
  };
}

export interface ClaudeOAuthCredential {
  readonly accessToken: string;
  readonly organizationUuid?: string;
  readonly email?: string;
  /**
   * When the CLI will treat the access token as expired (epoch ms), from the
   * stored field the CLI itself decides on. Absent when the store records
   * none, which the CLI reads as never expiring.
   */
  readonly expiresAt?: number;
  /** Whether the store holds a refresh token; without one the CLI cannot renew. */
  readonly renewable: boolean;
}

export function claudeUsageBackoffKey(
  credential: Pick<ClaudeOAuthCredential, "accessToken" | "organizationUuid">,
): string {
  // A fresh login rotates the access token. Include a one-way token
  // fingerprint so a Retry-After received for an expired credential cannot
  // suppress the replacement credential for the rest of the old backoff.
  const tokenFingerprint = createHash("sha256")
    .update(credential.accessToken)
    .digest("base64url")
    .slice(0, 16);
  return `${credential.organizationUuid ?? "default"}:${tokenFingerprint}`;
}

function readHeaderValue(headers: unknown, headerName: string): string | undefined {
  const get = headers && typeof headers === "object" ? (headers as { get?: unknown }).get : null;
  if (typeof get === "function") {
    const value = get.call(headers, headerName);
    return typeof value === "string" ? value : undefined;
  }

  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const exact = record[headerName];
  if (typeof exact === "string") return exact;

  const lower = record[headerName.toLowerCase()];
  return typeof lower === "string" ? lower : undefined;
}

export function parseClaudeUsageRetryAfter(
  value: string | undefined,
  nowMs: number,
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return nowMs + Math.min(seconds * 1000, CLAUDE_USAGE_BACKOFF_MAX_MS);
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate) || parsedDate <= nowMs) return undefined;
  return Math.min(parsedDate, nowMs + CLAUDE_USAGE_BACKOFF_MAX_MS);
}

function readClaudeUsageErrorType(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const type = (error as Record<string, unknown>).type;
  return typeof type === "string" && type.trim() ? type : undefined;
}

function hasKnownClaudeUsageField(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return KNOWN_CLAUDE_USAGE_FIELDS.some((field) => field in record);
}

function normalizeCredentialString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function extractClaudeOAuthCredential(
  credentials: ClaudeCredentialsPayload | undefined,
): ClaudeOAuthCredential | undefined {
  const accessToken = normalizeCredentialString(credentials?.claudeAiOauth?.accessToken);
  if (!accessToken) return undefined;

  // Claude Code may leave `expiresAt` stale when secure storage/keychain is the
  // source of truth, so the usage endpoint decides whether the token still
  // works. The stored value still predicts when a starting CLI will renew.
  const expiresAt = credentials?.claudeAiOauth?.expiresAt;
  const organizationUuid = normalizeCredentialString(credentials?.organizationUuid);
  const email =
    normalizeCredentialString(credentials?.account?.email) ??
    normalizeCredentialString(credentials?.claudeAiOauth?.account?.email) ??
    normalizeCredentialString(credentials?.claudeAiOauth?.email) ??
    normalizeCredentialString(credentials?.email) ??
    normalizeCredentialString(credentials?.userEmail);
  return {
    accessToken,
    ...(organizationUuid ? { organizationUuid } : {}),
    ...(email ? { email } : {}),
    ...(typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    renewable:
      normalizeCredentialString(credentials?.claudeAiOauth?.refreshToken ?? undefined) !==
      undefined,
  };
}

/**
 * The keychain item Claude Code keeps its login in, for the environment it
 * runs with (Claude Code 2.1.289): `Claude Code-credentials`, plus `-` and
 * the first 8 hex of sha256 of the config folder (NFC, otherwise verbatim)
 * when `CLAUDE_CONFIG_DIR` is set. `CLAUDE_SECURESTORAGE_CONFIG_DIR` takes
 * precedence; set but empty, it names the default item.
 */
export function claudeKeychainServiceName(environment: NodeJS.ProcessEnv): string {
  const secureStorageDir = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const hashInput =
    secureStorageDir !== undefined ? secureStorageDir : environment.CLAUDE_CONFIG_DIR;
  if (!hashInput) return CLAUDE_MACOS_KEYCHAIN_SERVICE;
  const digest = createHash("sha256").update(hashInput.normalize("NFC")).digest("hex");
  return `${CLAUDE_MACOS_KEYCHAIN_SERVICE}-${digest.slice(0, 8)}`;
}

/** The keychain account Claude Code files its login under. */
export function claudeKeychainAccountName(environment: NodeJS.ProcessEnv): string {
  let name: string | undefined;
  try {
    name = environment.USER || NodeOS.userInfo().username;
  } catch {
    name = undefined;
  }
  return name && /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/** One place the CLI may keep its login: read, confirmed empty, or not readable. */
type ClaudeCredentialStoreRead =
  | { readonly _tag: "Found"; readonly payload: ClaudeCredentialsPayload }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Failed"; readonly transient: boolean };

/** `security find-generic-password` exits with this when no item matches. */
const SECURITY_ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * Read the OAuth credentials Claude Code keeps in `<config folder>/.credentials.json`
 * (its store off macOS, and its fallback on macOS). `NotFound` when the file
 * is missing (API-key auth, keychain storage).
 */
const readClaudeCredentialsFile = Effect.fn("readClaudeCredentialsFile")(function* (
  claudeSettings: ClaudeFolderConfig,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeCredentialStoreRead, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeConfigDir(claudeSettings, environment);
  const credentialsPath = path.join(configDir, ".credentials.json");

  const exists = yield* fileSystem.exists(credentialsPath).pipe(Effect.option);
  if (Option.isNone(exists)) return { _tag: "Failed", transient: true };
  if (!exists.value) return { _tag: "NotFound" };
  return yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.flatMap((content) => decodeClaudeCredentialsFile(content)),
    Effect.map((payload): ClaudeCredentialStoreRead => ({ _tag: "Found", payload })),
    Effect.orElseSucceed((): ClaudeCredentialStoreRead => ({ _tag: "Failed", transient: false })),
  );
});

/**
 * Reads the login from the macOS keychain the way the CLI would: `security`
 * runs with the CLI's own environment, so a `HOME` override changes what it
 * can reach exactly as it does for Claude. A read that did not finish is a
 * `transient` failure: the CLI may still find a login there.
 */
const readClaudeMacOSKeychainCredentials = Effect.fn("readClaudeMacOSKeychainCredentials")(
  function* (
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
  ): Effect.fn.Return<ClaudeCredentialStoreRead, never, ChildProcessSpawner.ChildProcessSpawner> {
    if (platform !== "darwin") return { _tag: "NotFound" };

    const readSecret = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const command = ChildProcess.make("security", args, { shell: false, env: environment });
        const result = yield* spawnAndCollect("security", command).pipe(
          Effect.timeoutOption(KEYCHAIN_READ_TIMEOUT_MS),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
        if (Option.isNone(result)) return { _tag: "Failed", transient: true } as const;
        if (result.value.code === 0) {
          return { _tag: "Secret", secret: result.value.stdout.trim() } as const;
        }
        return result.value.code === SECURITY_ITEM_NOT_FOUND_EXIT_CODE
          ? ({ _tag: "NotFound" } as const)
          : ({ _tag: "Failed", transient: false } as const);
      });

    const service = claudeKeychainServiceName(environment);
    const accountScopedArgs = [
      "find-generic-password",
      "-a",
      claudeKeychainAccountName(environment),
      "-w",
      "-s",
      service,
    ] as const;
    const serviceScopedArgs = ["find-generic-password", "-w", "-s", service] as const;
    const accountScoped = yield* readSecret(accountScopedArgs);
    // The service-wide lookup covers every account, so its answer stands
    // whenever the account-scoped one found nothing usable.
    const read =
      accountScoped._tag === "Secret" && accountScoped.secret
        ? accountScoped
        : yield* readSecret(serviceScopedArgs);
    if (read._tag !== "Secret") return read;
    if (!read.secret) return { _tag: "NotFound" };

    return yield* decodeClaudeCredentialsFile(read.secret).pipe(
      Effect.map((payload): ClaudeCredentialStoreRead => ({ _tag: "Found", payload })),
      Effect.orElseSucceed((): ClaudeCredentialStoreRead => ({ _tag: "Failed", transient: false })),
    );
  },
);

/**
 * What the credential store holds for an instance's normal Claude sign-in.
 * `Absent` is only reported once every store was read and none holds a
 * login: that is the one state that means "signed out". `Unreadable` covers
 * the rest, and is `transient` when a read did not finish (a slow keychain
 * on a busy machine), so a login may be there all the same.
 */
export type ClaudeStoredSignIn =
  | { readonly _tag: "Present"; readonly credential: ClaudeOAuthCredential }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unreadable"; readonly transient: boolean };

/**
 * The sign-in this instance's Claude would use, read in the CLI's order
 * (keychain on macOS, then the folder's file) for the exact environment it
 * is spawned with. Never another instance's login: an account whose store is
 * empty is signed out rather than borrowing someone else's.
 */
export const readClaudeStoredSignIn = Effect.fn("readClaudeStoredSignIn")(function* (
  claudeSettings: ClaudeFolderConfig,
  options: {
    readonly platform?: NodeJS.Platform;
    /** The instance's environment before Claude-specific additions. */
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Effect.fn.Return<
  ClaudeStoredSignIn,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const spawnEnvironment = yield* makeClaudeEnvironment(
    claudeSettings,
    options.environment ?? process.env,
  );
  const keychain = yield* readClaudeMacOSKeychainCredentials(spawnEnvironment, options.platform);
  const keychainCredential =
    keychain._tag === "Found" ? extractClaudeOAuthCredential(keychain.payload) : undefined;
  if (keychainCredential) return { _tag: "Present", credential: keychainCredential };

  const file = yield* readClaudeCredentialsFile(claudeSettings, spawnEnvironment);
  const fileCredential =
    file._tag === "Found" ? extractClaudeOAuthCredential(file.payload) : undefined;
  if (fileCredential) return { _tag: "Present", credential: fileCredential };

  if (keychain._tag === "Failed") return { _tag: "Unreadable", transient: keychain.transient };
  if (file._tag === "Failed") return { _tag: "Unreadable", transient: file.transient };
  return { _tag: "Absent" };
});

/**
 * How close to expiry the stored sign-in must be before a starting CLI is
 * expected to renew it. The CLI's own margin is 5 minutes; this is wider so
 * a clock that runs slightly off still lands on the careful side.
 */
const CLAUDE_SIGN_IN_RENEWAL_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether a Claude CLI started now may try to renew the stored sign-in. A
 * renewal rotates the refresh token, and a CLI stopped before it saved the
 * new one leaves the stored sign-in dead, so callers must not start a
 * short-lived CLI, or stop a running one, while this holds.
 *
 * Only `CLAUDE_CODE_OAUTH_TOKEN` keeps the CLI off the stored sign-in; with an
 * API key or auth token in the environment it renews all the same (checked
 * against Claude Code 2.1.289). A store that could not be read in time counts
 * as due: the CLI may still read it.
 */
export function isClaudeSignInRenewalDue(input: {
  readonly stored: ClaudeStoredSignIn;
  readonly environment: NodeJS.ProcessEnv;
  readonly nowMs: number;
}): boolean {
  if (normalizeCredentialString(input.environment[CLAUDE_CODE_OAUTH_TOKEN_ENV]) !== undefined) {
    return false;
  }
  if (input.stored._tag === "Unreadable") return input.stored.transient;
  if (input.stored._tag === "Absent") return false;
  const { expiresAt, renewable } = input.stored.credential;
  return (
    renewable &&
    expiresAt !== undefined &&
    expiresAt - input.nowMs <= CLAUDE_SIGN_IN_RENEWAL_WINDOW_MS
  );
}

/**
 * `isClaudeSignInRenewalDue` for the store as it is now. The store is not
 * read at all when the environment keeps the CLI off the stored sign-in.
 */
export const checkClaudeSignInRenewalDue = <R>(input: {
  readonly readStoredSignIn: Effect.Effect<ClaudeStoredSignIn, never, R>;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<boolean, never, R> =>
  Effect.gen(function* () {
    if (normalizeCredentialString(input.environment[CLAUDE_CODE_OAUTH_TOKEN_ENV]) !== undefined) {
      return false;
    }
    const stored = yield* input.readStoredSignIn;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return isClaudeSignInRenewalDue({ stored, environment: input.environment, nowMs });
  });

/** Why a usage check produced no numbers. */
export type ClaudeUsageUnavailableReason = ServerProviderAuthCapabilityReason;

/** The outcome of one usage check: fresh numbers, or why there are none. */
export type ClaudeUsageCheck =
  | { readonly _tag: "Fresh"; readonly usage: ServerProviderAccountUsage }
  | { readonly _tag: "Unavailable"; readonly reason: ClaudeUsageUnavailableReason };

const usageUnavailable = (reason: ClaudeUsageUnavailableReason): ClaudeUsageCheck => ({
  _tag: "Unavailable",
  reason,
});

/**
 * One usage-endpoint round trip, body included, under one timeout. Resolves
 * to `undefined` on a network error or timeout; otherwise carries the HTTP
 * status plus the parsed usage snapshot (present only for a 2xx response
 * with a recognizable payload). The status lets the caller tell an expired
 * credential (401) and a rate limit (429) apart from every other failure.
 */
const fetchClaudeUsageSnapshotOnce = Effect.fn("fetchClaudeUsageSnapshotOnce")(function* (
  credential: ClaudeOAuthCredential,
): Effect.fn.Return<
  { readonly status: number; readonly usage: ServerProviderAccountUsage | undefined } | undefined,
  never,
  HttpClient.HttpClient
> {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(CLAUDE_OAUTH_USAGE_URL).pipe(
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
      ...(credential.organizationUuid
        ? { "x-organization-uuid": credential.organizationUuid }
        : {}),
    }),
  );
  const roundTrip = Effect.gen(function* () {
    const httpResponse = yield* client.execute(request);
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      const responseBody = yield* httpResponse.json.pipe(Effect.orElseSucceed(() => undefined));
      const retryAfterReferenceMs = DateTime.toEpochMillis(yield* DateTime.now);
      const retryAfterMs = parseClaudeUsageRetryAfter(
        readHeaderValue(httpResponse.headers, "retry-after"),
        retryAfterReferenceMs,
      );
      if (httpResponse.status === 429 && retryAfterMs !== undefined) {
        claudeUsageBackoffUntilMsByCredential.set(claudeUsageBackoffKey(credential), retryAfterMs);
      }

      yield* Effect.logWarning("claude.usage.fetch.unavailable", {
        status: httpResponse.status,
        retryAfterMs:
          retryAfterMs !== undefined
            ? Math.max(0, retryAfterMs - retryAfterReferenceMs)
            : undefined,
        errorType: readClaudeUsageErrorType(responseBody),
        hasUsageFields: hasKnownClaudeUsageField(responseBody),
      });
      return { status: httpResponse.status, usage: undefined };
    }

    const payload = yield* httpResponse.json.pipe(
      Effect.flatMap((body) => decodeClaudeOAuthUsageResponse(body)),
      Effect.orElseSucceed(() => undefined),
    );
    if (!payload) return { status: httpResponse.status, usage: undefined };

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return { status: httpResponse.status, usage: normalizeClaudeAccountUsage(payload, checkedAt) };
  });
  const result = yield* roundTrip.pipe(
    Effect.timeoutOption(USAGE_FETCH_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  return Option.getOrUndefined(result);
});

/** Why a round trip that returned no numbers failed. */
function claudeUsageFailureReason(
  snapshot: { readonly status: number } | undefined,
): ClaudeUsageUnavailableReason {
  return snapshot?.status === 429 ? "rate_limited" : "unreachable";
}

/**
 * Check the subscription usage (5h + weekly windows) of the account Claude
 * Code is signed in to. Never fails: a check without numbers says why.
 *
 * The stored access token lives ~8 hours, and only a real Claude process can
 * renew it (with the long-lived refresh token kept in the same credential).
 * Threadlines sessions on a chat-only token never renew the stored credential
 * as a side effect, so without help this check starts failing with 401 a few
 * hours after the last sign-in. When `refreshOAuthCredential` is provided it
 * is run on a 401 (expected to make the CLI renew and persist the
 * credential), then the check re-reads the store and retries once. A
 * per-credential cooldown keeps a sign-in that cannot renew from spawning a
 * refresh attempt on every probe.
 *
 * `signed_out` is reported only on proof: the store holds no sign-in, or it
 * holds one that the endpoint rejects and nothing can renew (the CLI removes
 * a sign-in whose renewal was refused, or leaves it without a refresh
 * token). Every other failure is temporary.
 */
export const fetchClaudeAccountUsage = Effect.fn("fetchClaudeAccountUsage")(function* (
  claudeSettings: ClaudeFolderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  refreshOAuthCredential?: Effect.Effect<boolean>,
): Effect.fn.Return<
  ClaudeUsageCheck,
  never,
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const stored = yield* readClaudeStoredSignIn(claudeSettings, { environment });
  if (stored._tag !== "Present") {
    yield* Effect.logDebug("claude.usage.fetch.skipped", {
      reason: stored._tag === "Absent" ? "missing-oauth-credential" : "unreadable-credential-store",
    });
    return usageUnavailable(stored._tag === "Absent" ? "signed_out" : "unreachable");
  }
  const credential = stored.credential;

  const backoffKey = claudeUsageBackoffKey(credential);
  const backoffUntilMs = claudeUsageBackoffUntilMsByCredential.get(backoffKey);
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  if (backoffUntilMs !== undefined && backoffUntilMs > nowMs) {
    yield* Effect.logDebug("claude.usage.fetch.skipped", {
      reason: "retry-after-backoff",
      retryAfterMs: backoffUntilMs - nowMs,
    });
    return usageUnavailable("rate_limited");
  }

  const snapshot = yield* fetchClaudeUsageSnapshotOnce(credential);
  if (snapshot?.usage) return { _tag: "Fresh", usage: snapshot.usage };
  if (snapshot?.status !== 401) return usageUnavailable(claudeUsageFailureReason(snapshot));
  // Another Claude process may have renewed the sign-in since it was read
  // (a status check that was still renewing, a session in a terminal): then
  // the store already holds a working token and nothing needs renewing.
  const latest = yield* readClaudeStoredSignIn(claudeSettings, { environment });
  if (latest._tag === "Present" && latest.credential.accessToken !== credential.accessToken) {
    const renewedElsewhere = yield* fetchClaudeUsageSnapshotOnce(latest.credential);
    if (renewedElsewhere?.usage) return { _tag: "Fresh", usage: renewedElsewhere.usage };
    if (renewedElsewhere?.status !== 401) {
      return usageUnavailable(claudeUsageFailureReason(renewedElsewhere));
    }
  }
  // A rejected sign-in the store holds no refresh token for can never renew.
  const rejected = usageUnavailable(credential.renewable ? "unreachable" : "signed_out");
  if (refreshOAuthCredential === undefined) return rejected;

  const refreshNowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const cooldownUntilMs = claudeUsageRefreshCooldownUntilMsByCredential.get(backoffKey);
  if (cooldownUntilMs !== undefined && cooldownUntilMs > refreshNowMs) {
    yield* Effect.logDebug("claude.usage.credential-refresh.skipped", {
      reason: "cooldown",
      cooldownMs: cooldownUntilMs - refreshNowMs,
    });
    return rejected;
  }
  if (claudeUsageCredentialRefreshInFlight) {
    yield* Effect.logDebug("claude.usage.credential-refresh.skipped", { reason: "in-flight" });
    return usageUnavailable("unreachable");
  }
  claudeUsageRefreshCooldownUntilMsByCredential.set(
    backoffKey,
    refreshNowMs + CLAUDE_USAGE_REFRESH_COOLDOWN_MS,
  );
  claudeUsageCredentialRefreshInFlight = true;
  const refreshed = yield* refreshOAuthCredential.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        claudeUsageCredentialRefreshInFlight = false;
      }),
    ),
  );

  const afterRefresh = yield* readClaudeStoredSignIn(claudeSettings, { environment });
  if (afterRefresh._tag === "Absent") {
    yield* Effect.logWarning("claude.usage.credential-refresh.failed", { reason: "signed-out" });
    return usageUnavailable("signed_out");
  }
  if (!refreshed) {
    yield* Effect.logWarning("claude.usage.credential-refresh.failed", {
      reason: "refresh-turn-failed",
    });
    return afterRefresh._tag === "Present" && !afterRefresh.credential.renewable
      ? usageUnavailable("signed_out")
      : usageUnavailable("unreachable");
  }
  if (
    afterRefresh._tag !== "Present" ||
    afterRefresh.credential.accessToken === credential.accessToken
  ) {
    yield* Effect.logWarning("claude.usage.credential-refresh.failed", {
      reason: "credential-not-rotated",
    });
    return afterRefresh._tag === "Present" && !afterRefresh.credential.renewable
      ? usageUnavailable("signed_out")
      : usageUnavailable("unreachable");
  }

  const retried = yield* fetchClaudeUsageSnapshotOnce(afterRefresh.credential);
  if (retried?.usage) {
    yield* Effect.logInfo("claude.usage.credential-refresh.recovered");
    return { _tag: "Fresh", usage: retried.usage };
  }
  return usageUnavailable(claudeUsageFailureReason(retried));
});
