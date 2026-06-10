/**
 * ClaudeUsage — subscription usage snapshot for the Claude provider card.
 *
 * Claude Code does not expose an on-demand "read rate limits" RPC the way the
 * Codex app-server does (`account/rateLimits/read`). The data behind Claude
 * Code's `/usage` screen is served by Anthropic's OAuth usage endpoint, which
 * the wider Claude Code tooling ecosystem (statusline plugins, usage
 * monitors) reads with the same OAuth access token Claude Code maintains in
 * `<home>/.claude/.credentials.json`.
 *
 * The endpoint is unofficial, so every step here degrades to `undefined`
 * rather than failing the provider probe: missing/expired credentials (API
 * key auth, macOS keychain storage, logged out), non-2xx responses, and
 * unexpected payload shapes all simply omit the usage section from the card.
 *
 * @module provider/Layers/ClaudeUsage
 */
import type {
  ClaudeSettings,
  ServerProviderAccountUsage,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";

export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_FETCH_TIMEOUT_MS = 4_000;
const FIVE_HOUR_WINDOW_MINS = 300;
const SEVEN_DAY_WINDOW_MINS = 10_080;

const ClaudeCredentialsFile = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.optional(
      Schema.Struct({
        accessToken: Schema.optional(Schema.String),
        expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  }),
);
const decodeClaudeCredentialsFile = Schema.decodeUnknownEffect(ClaudeCredentialsFile);

const ClaudeUsageWindow = Schema.Struct({
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
});
export type ClaudeUsageWindow = typeof ClaudeUsageWindow.Type;

const ClaudeOAuthUsageResponse = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeUsageWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeUsageWindow)),
});
export type ClaudeOAuthUsageResponse = typeof ClaudeOAuthUsageResponse.Type;
const decodeClaudeOAuthUsageResponse = Schema.decodeUnknownEffect(ClaudeOAuthUsageResponse);

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

export function normalizeClaudeAccountUsage(
  payload: ClaudeOAuthUsageResponse,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  const primary = normalizeClaudeUsageWindow(payload.five_hour, FIVE_HOUR_WINDOW_MINS);
  const secondary = normalizeClaudeUsageWindow(payload.seven_day, SEVEN_DAY_WINDOW_MINS);
  if (!primary && !secondary) return undefined;

  return {
    source: "claude-oauth-usage",
    checkedAt,
    primaryLimitId: "claude",
    limits: [
      {
        limitId: "claude",
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {}),
      },
    ],
  };
}

/**
 * Read the OAuth access token Claude Code maintains in
 * `<home>/.claude/.credentials.json`. Returns `undefined` when the file is
 * missing (API-key auth, keychain-backed storage), unparseable, or the token
 * is already expired — we never refresh tokens ourselves; Claude Code does
 * that whenever it runs (including this provider's capabilities probe).
 */
const readClaudeOAuthAccessToken = Effect.fn("readClaudeOAuthAccessToken")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* resolveClaudeHomePath(claudeSettings);
  const credentialsPath = path.join(homePath, ".claude", ".credentials.json");

  const credentials = yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.flatMap((content) => decodeClaudeCredentialsFile(content)),
    Effect.orElseSucceed(() => undefined),
  );
  const accessToken = credentials?.claudeAiOauth?.accessToken?.trim();
  if (!accessToken) return undefined;

  const expiresAt = credentials?.claudeAiOauth?.expiresAt;
  if (typeof expiresAt === "number") {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (expiresAt <= now) return undefined;
  }
  return accessToken;
});

/**
 * Fetch the subscription usage snapshot (5h + weekly windows) for the
 * account Claude Code is logged into. Never fails — any error path resolves
 * to `undefined` so the provider probe stays healthy without usage data.
 */
export const fetchClaudeAccountUsage = Effect.fn("fetchClaudeAccountUsage")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<
  ServerProviderAccountUsage | undefined,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const accessToken = yield* readClaudeOAuthAccessToken(claudeSettings);
  if (!accessToken) return undefined;

  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(CLAUDE_OAUTH_USAGE_URL).pipe(
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
    }),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(USAGE_FETCH_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  if (Option.isNone(response)) return undefined;

  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) return undefined;

  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap((body) => decodeClaudeOAuthUsageResponse(body)),
    Effect.orElseSucceed(() => undefined),
  );
  if (!payload) return undefined;

  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return normalizeClaudeAccountUsage(payload, checkedAt);
});
