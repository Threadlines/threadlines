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
 * The endpoint is unofficial, so every step here degrades to `undefined`
 * rather than failing the provider probe: missing credentials (API key auth,
 * logged out), non-2xx responses, and unexpected payload shapes all simply omit
 * the usage section from the card. We still log redacted diagnostics and honor
 * Retry-After so a rate-limited usage check doesn't keep hammering the endpoint.
 *
 * @module provider/Layers/ClaudeUsage
 */
import type {
  ClaudeSettings,
  ServerProviderAccountUsage,
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

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_MACOS_KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_FETCH_TIMEOUT_MS = 4_000;
const KEYCHAIN_READ_TIMEOUT_MS = 1_500;
const FIVE_HOUR_WINDOW_MINS = 300;
const SEVEN_DAY_WINDOW_MINS = 10_080;
const CLAUDE_USAGE_BACKOFF_MAX_MS = 60 * 60 * 1000;
const claudeUsageBackoffUntilMsByCredential = new Map<string, number>();

const ClaudeCredentialAccount = Schema.Struct({
  email: Schema.optional(Schema.String),
});

const ClaudeCredentialsPayload = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
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

  return {
    source: "claude-oauth-usage",
    checkedAt,
    primaryLimitId: "claude",
    limits: [
      {
        limitId: "claude",
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {}),
        ...(scoped.length > 0 ? { scoped } : {}),
      },
    ],
  };
}

/**
 * One rate-limit window from the Agent SDK's `rate_limit_event` stream
 * message. Structural subset of the SDK's `SDKRateLimitInfo` so this module
 * stays decoupled from the SDK package.
 */
export interface ClaudeRateLimitEventInfo {
  readonly rateLimitType?: string | undefined;
  readonly utilization?: number | undefined;
  readonly resetsAt?: number | undefined;
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
 * Merge one live rate-limit window (the Agent SDK's `rate_limit_event`) into
 * the usage snapshot fetched from the OAuth endpoint. The event carries a
 * single window at a time, so only the matching window is patched; the rest
 * of the snapshot is preserved. Returns `undefined` when there is nothing to
 * apply (unknown window type, missing utilization, or no change).
 */
export function applyClaudeRateLimitInfoToAccountUsage(
  current: ServerProviderAccountUsage | undefined,
  info: ClaudeRateLimitEventInfo,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  if (typeof info.utilization !== "number" || !Number.isFinite(info.utilization)) {
    return undefined;
  }
  if (!info.rateLimitType) return undefined;

  const usedPercent = normalizeUsagePercent(info.utilization);
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const resetsAt = normalizeClaudeUsageResetsAt(info.resetsAt);

  const windowTarget = CLAUDE_RATE_LIMIT_EVENT_WINDOWS[info.rateLimitType];
  if (windowTarget) {
    const nextWindow: ServerProviderUsageWindow = {
      usedPercent,
      remainingPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      windowDurationMins: windowTarget.windowDurationMins,
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
    if (usageWindowsEqual(existingLimit[windowTarget.field], nextWindow)) {
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

  const scopedKeyword = CLAUDE_RATE_LIMIT_EVENT_SCOPED_KEYWORDS[info.rateLimitType];
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
  };
  if (
    existingScoped.usedPercent === nextScoped.usedPercent &&
    existingScoped.remainingPercent === nextScoped.remainingPercent &&
    existingScoped.resetsAt === nextScoped.resetsAt
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
}

export function claudeUsageBackoffKey(credential: ClaudeOAuthCredential): string {
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
  // source of truth. Treat it as advisory and let the usage endpoint decide.
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
  };
}

/**
 * Read the OAuth credentials Claude Code maintains in
 * `<home>/.claude/.credentials.json`. Returns `undefined` when the file is
 * missing (API-key auth, keychain-backed storage) or unparseable.
 */
const readClaudeCredentialsFile = Effect.fn("readClaudeCredentialsFile")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<
  ClaudeCredentialsPayload | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* resolveClaudeHomePath(claudeSettings);
  const credentialsPath = path.join(homePath, ".claude", ".credentials.json");

  const credentials = yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.flatMap((content) => decodeClaudeCredentialsFile(content)),
    Effect.orElseSucceed(() => undefined),
  );
  return credentials;
});

const readClaudeMacOSKeychainCredentials = Effect.fn("readClaudeMacOSKeychainCredentials")(
  function* (
    platform: NodeJS.Platform = process.platform,
  ): Effect.fn.Return<
    ClaudeCredentialsPayload | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    if (platform !== "darwin") return undefined;

    const readSecret = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const command = ChildProcess.make("security", args, { shell: false });
        const result = yield* spawnAndCollect("security", command).pipe(
          Effect.timeoutOption(KEYCHAIN_READ_TIMEOUT_MS),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
        if (Option.isNone(result)) return undefined;
        return result.value.code === 0 ? result.value.stdout.trim() : undefined;
      });

    const accountScopedArgs = [
      "find-generic-password",
      "-a",
      NodeOS.userInfo().username,
      "-w",
      "-s",
      CLAUDE_MACOS_KEYCHAIN_SERVICE,
    ] as const;
    const serviceScopedArgs = [
      "find-generic-password",
      "-w",
      "-s",
      CLAUDE_MACOS_KEYCHAIN_SERVICE,
    ] as const;
    const secret = (yield* readSecret(accountScopedArgs)) ?? (yield* readSecret(serviceScopedArgs));
    if (!secret) return undefined;

    return yield* decodeClaudeCredentialsFile(secret).pipe(Effect.orElseSucceed(() => undefined));
  },
);

export const readClaudeOAuthCredential = Effect.fn("readClaudeOAuthCredential")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
  options: {
    readonly platform?: NodeJS.Platform;
  } = {},
): Effect.fn.Return<
  ClaudeOAuthCredential | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileCredentials = yield* readClaudeCredentialsFile(claudeSettings);
  const fileCredential = extractClaudeOAuthCredential(fileCredentials);
  if (fileCredential) return fileCredential;

  const keychainCredentials = yield* readClaudeMacOSKeychainCredentials(options.platform);
  return extractClaudeOAuthCredential(keychainCredentials);
});

/**
 * Fetch the subscription usage snapshot (5h + weekly windows) for the
 * account Claude Code is logged into. Never fails — any error path resolves
 * to `undefined` so the provider probe stays healthy without usage data.
 */
export const fetchClaudeAccountUsage = Effect.fn("fetchClaudeAccountUsage")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderAccountUsage | undefined,
  never,
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const credential = yield* readClaudeOAuthCredential(claudeSettings);
  if (!credential) {
    yield* Effect.logDebug("claude.usage.fetch.skipped", {
      reason:
        normalizeCredentialString(environment[CLAUDE_CODE_OAUTH_TOKEN_ENV]) !== undefined
          ? "long-lived-token-lacks-usage-scope"
          : "missing-oauth-credential",
    });
    return undefined;
  }

  const backoffKey = claudeUsageBackoffKey(credential);
  const backoffUntilMs = claudeUsageBackoffUntilMsByCredential.get(backoffKey);
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  if (backoffUntilMs !== undefined && backoffUntilMs > nowMs) {
    yield* Effect.logDebug("claude.usage.fetch.skipped", {
      reason: "retry-after-backoff",
      retryAfterMs: backoffUntilMs - nowMs,
    });
    return undefined;
  }

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
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(USAGE_FETCH_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  if (Option.isNone(response)) return undefined;

  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    const responseBody = yield* httpResponse.json.pipe(Effect.orElseSucceed(() => undefined));
    const retryAfterReferenceMs = DateTime.toEpochMillis(yield* DateTime.now);
    const retryAfterMs = parseClaudeUsageRetryAfter(
      readHeaderValue(httpResponse.headers, "retry-after"),
      retryAfterReferenceMs,
    );
    if (httpResponse.status === 429 && retryAfterMs !== undefined) {
      claudeUsageBackoffUntilMsByCredential.set(backoffKey, retryAfterMs);
    }

    yield* Effect.logWarning("claude.usage.fetch.unavailable", {
      status: httpResponse.status,
      retryAfterMs:
        retryAfterMs !== undefined ? Math.max(0, retryAfterMs - retryAfterReferenceMs) : undefined,
      errorType: readClaudeUsageErrorType(responseBody),
      hasUsageFields: hasKnownClaudeUsageField(responseBody),
    });
    return undefined;
  }

  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap((body) => decodeClaudeOAuthUsageResponse(body)),
    Effect.orElseSucceed(() => undefined),
  );
  if (!payload) return undefined;

  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return normalizeClaudeAccountUsage(payload, checkedAt);
});
