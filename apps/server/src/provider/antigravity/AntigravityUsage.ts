/**
 * AntigravityUsage — how much of the user's Google plan an Antigravity
 * instance has used, and the signed-in Google account's email.
 *
 * THIS READS AN UNPUBLISHED GOOGLE API. `v1internal:retrieveUserQuotaSummary`
 * and `v1internal:fetchAvailableModels` on Google's Cloud Code hosts are what
 * Google's own Antigravity apps call; Google documents neither and can change
 * or close them at any time. Everything that knows about them is in this
 * module, so it comes out in one piece: delete this file and the lines in
 * `Drivers/AntigravityDriver.ts` and `acp/AntigravityAcpSupport.ts` that name
 * it. The answer shapes follow T3 Code (MIT, `antigravityUsageLimits.ts` and
 * its open pull requests); the code is our own.
 *
 * Rules it keeps:
 * - It reads only for a Google sign-in (Google account or Gemini
 *   Enterprise). An instance switched to an API key or Vertex AI keeps its
 *   earlier Google token on disk on purpose, and that token says nothing
 *   about what the instance now bills.
 * - The token is the CLI's own file in the instance's profile
 *   (`antigravityTokenPath`), read and never written, renewed or removed.
 *   Google's token endpoint is never called and the OS keyring never read.
 *   An expired token keeps the last numbers, with a line saying a chat
 *   refreshes them: the agent renews its own sign-in when it runs.
 * - Readings are kept per sign-in fingerprint and Google account, so one
 *   account never shows another's numbers or email.
 * - Requests go only to the two Cloud Code hosts and Google's userinfo
 *   endpoint, through a fetch that refuses every other host and every
 *   redirect. Cloud Code requests send Google's Antigravity client User-Agent
 *   (Cloud Code gates quota responses on it); userinfo sends Threadlines' own.
 *   The token is never logged: warnings carry only host, operation, and a
 *   fixed status/reason string.
 * - It fails soft. A status check never waits for Google: it gets the last
 *   reading and starts a read in the background. One read at a time, 10
 *   seconds per request and 30 in all; a failed read keeps the last good
 *   numbers. Signing in or out cancels a read in flight.
 *
 * @module provider/antigravity/AntigravityUsage
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

import type {
  AntigravityAuthMethod,
  RuntimeUsageLimit,
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderAuth,
  ServerProviderAuthCapability,
  ServerProviderRateLimitResetCredit,
  ServerProviderRateLimitResetCreditOutcome,
  ServerProviderRateLimitResetCredits,
  ServerProviderScopedUsageWindow,
} from "@threadlines/contracts";
import { usageLimitForModel } from "@threadlines/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "../Services/ServerProvider.ts";

import { THREADLINES_ACP_CLIENT_INFO } from "../acp/acpClientInfo.ts";
import { makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import { antigravityTokenPath } from "./AntigravityProfile.ts";

// ── Google's hosts ───────────────────────────────────────────────────

const DAILY_HOST = "daily-cloudcode-pa.googleapis.com";
const PROD_HOST = "cloudcode-pa.googleapis.com";
const USERINFO_HOST = "www.googleapis.com";
const USERINFO_URL = `https://${USERINFO_HOST}/oauth2/v2/userinfo`;

/** Every host a read may contact. */
export const ANTIGRAVITY_USAGE_HOSTS = [DAILY_HOST, PROD_HOST, USERINFO_HOST] as const;

type GoogleMethod = Extract<AntigravityAuthMethod, "oauth-personal" | "oauth-business">;

/**
 * Both hosts are asked: their answers differ by account. Where both name a
 * bucket, the host the account is metered on wins (T3 Code: personal
 * accounts on the daily host, Enterprise on the production one).
 */
const HOSTS_BY_METHOD: Record<GoogleMethod, readonly [string, string]> = {
  "oauth-personal": [DAILY_HOST, PROD_HOST],
  "oauth-business": [PROD_HOST, DAILY_HOST],
};

const isGoogleMethod = (method: AntigravityAuthMethod): method is GoogleMethod =>
  method === "oauth-personal" || method === "oauth-business";

/** What a usage surface calls the reading. */
export const ANTIGRAVITY_USAGE_LABEL = "Antigravity usage";

/**
 * Google's Cloud Code quota endpoints gate on the client User-Agent and
 * refuse or drop groups for unrecognized strings. Matches Antigravity's own
 * Go client string (`runtime.GOOS` / `runtime.GOARCH`) on those endpoints;
 * userinfo still sends Threadlines' name.
 */
export function antigravityUsageUserAgent(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): string {
  const osType = platform === "win32" ? "windows" : platform;
  const arch = architecture === "x64" ? "amd64" : architecture === "ia32" ? "386" : architecture;
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${osType}; arch=${arch}; cl=963137146)`;
}

export const ANTIGRAVITY_USAGE_USER_AGENT = antigravityUsageUserAgent();
const THREADLINES_USER_AGENT = `Threadlines/${THREADLINES_ACP_CLIENT_INFO.version}`;

const REQUEST_TIMEOUT = Duration.seconds(10);
const READ_TIMEOUT = Duration.seconds(30);
/** Status checks come every five minutes and on demand; reads come no closer than this. */
const MIN_READ_INTERVAL_MS = 2 * 60_000;
/** A token this close to expiry counts as expired: a read would race it. */
const EXPIRY_MARGIN_MS = 60_000;
/** Answers are a few kilobytes; anything near this is not one. */
const MAX_ANSWER_CHARS = 2_000_000;

// ── The CLI's token file ─────────────────────────────────────────────

const TokenFile = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
    expiry: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  id_token_email: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeTokenFile = Schema.decodeUnknownOption(Schema.fromJsonString(TokenFile));

interface SavedToken {
  readonly accessToken: string;
  /** Short hash of the access token: spots a CLI token renewal without holding the secret. */
  readonly tokenHash: string;
  /** Undefined when the file doesn't say: then it counts as expired. */
  readonly expiresAtMs: number | undefined;
  readonly email: string | undefined;
  /** Names the Google sign-in without holding it. */
  readonly accountKey: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

const cleanEmail = (value: string | null | undefined) => {
  const email = value?.trim();
  return email && email.includes("@") && email.length <= 320 ? email : undefined;
};

const readSavedToken = (
  profileDir: string,
  onUnreadable?: (key: string, detail: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const readResult = yield* Effect.promise(async () => {
      try {
        return {
          ok: true as const,
          raw: await fs.readFile(antigravityTokenPath(profileDir), "utf8"),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
        return { ok: false as const, code };
      }
    });
    if (!readResult.ok) {
      if (readResult.code !== "ENOENT" && onUnreadable) {
        yield* onUnreadable(`read:${readResult.code}`, `read error (${readResult.code})`);
      }
      return undefined;
    }
    const raw = readResult.raw;
    if (raw.trim().length === 0) return undefined;
    const decoded = decodeTokenFile(raw);
    if (decoded._tag === "None") {
      if (onUnreadable) yield* onUnreadable(`decode:${sha256(raw)}`, "unexpected token file shape");
      return undefined;
    }
    const { token, id_token_email } = decoded.value;
    const expiresAtMs = token.expiry ? Date.parse(token.expiry) : Number.NaN;
    const email = cleanEmail(id_token_email);
    const refreshToken = token.refresh_token ?? undefined;
    return {
      accessToken: token.access_token,
      tokenHash: sha256(token.access_token),
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
      email,
      // The refresh token outlives renewals; the access token is the last resort.
      accountKey: sha256(`antigravity-account/1\0${refreshToken || email || token.access_token}`),
    } satisfies SavedToken;
  });

// ── Google's answers ─────────────────────────────────────────────────

const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const BankedReset = Schema.Struct({
  resetId: Schema.NonEmptyString,
  displayLabel: Schema.optional(Schema.String),
  expireTime: Schema.optional(Schema.String),
  claimable: Schema.optional(Schema.Boolean),
  ineligibleReason: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  remainingCount: Schema.optional(Schema.Number),
  bucketIds: Schema.optional(Schema.Array(Schema.String)),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
  bankedResets: Schema.optional(Schema.Array(BankedReset)),
});
const ClaimResponse = Schema.Struct({
  quotaSummary: Schema.optional(Summary),
  groups: Summary.fields.groups,
  buckets: Summary.fields.buckets,
  bankedResets: Summary.fields.bankedResets,
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
      isInternal: Schema.optional(Schema.Boolean),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});
const UserInfo = Schema.Struct({ email: Schema.optional(Schema.String) });

const decodeSummary = Schema.decodeUnknownOption(Summary);
const decodeClaimResponse = Schema.decodeUnknownOption(ClaimResponse);
const decodeModels = Schema.decodeUnknownOption(Models);
const decodeUserInfo = Schema.decodeUnknownOption(UserInfo);

type Period = "5h" | "weekly" | "quota";
const PERIOD_MINUTES: Record<Period, number | undefined> = {
  "5h": 5 * 60,
  weekly: 7 * 24 * 60,
  quota: undefined,
};

/** A group of models one quota covers: a pool, or one model's own quota. */
interface Family {
  readonly key: string;
  readonly label: string;
  /** Names a model holds to be in the family; undefined: the label. */
  readonly models?: ReadonlyArray<string>;
  /** A Gemini family, which the summary sometimes leaves out. */
  readonly gemini: boolean;
  /** One model's own quota (Enterprise answers, per-model quotas), not a pool. */
  readonly perModel?: boolean;
}

const GEMINI: Family = { key: "gemini", label: "Gemini", models: ["Gemini"], gemini: true };
const SHARED_3P: Family = {
  key: "3p",
  label: "Claude & GPT",
  models: ["Claude", "GPT"],
  gemini: false,
};

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A Gemini 4 pool of its own (`gemini-argon-wtu-weekly`). */
function geminiSubfamily(sub: string, groupName: string | undefined): Family {
  const named = groupName?.trim();
  return {
    key: `gemini-${sub}`,
    label:
      named && named.toLowerCase().split(/\s+/).includes(sub) ? named : `Gemini ${capitalize(sub)}`,
    models: [capitalize(sub)],
    gemini: true,
  };
}

/** A thinking level a per-model quota is named with: one model's levels share its row. */
const EFFORT_SUFFIX = /-(?:extra-high|xhigh|high|medium|low|minimal)$/u;
const EFFORT_NAME = /\s*\((?:extra high|xhigh|high|medium|low|minimal)\)$/iu;

/**
 * One model's own quota, named as the picker names the model: the display
 * name Google gives ("Claude Opus 5.5 (High)" without its level), else one
 * made from the id ("claude-opus-5-5-high" is "Claude Opus 5.5").
 */
function perModelFamily(modelId: string, displayName: string | undefined): Family | undefined {
  const id = modelId.toLowerCase().replace(EFFORT_SUFFIX, "");
  if (!/^(gemini|claude|gpt)-/.test(id)) return undefined;
  const label =
    displayName?.trim().replace(EFFORT_NAME, "") ||
    id
      .replace(/(\d)-(?=\d)/g, "$1.")
      .split("-")
      .map((word) => (word === "gpt" ? "GPT" : capitalize(word)))
      .join(" ");
  return {
    key: `model:${id}`,
    label,
    models: [label],
    gemini: id.startsWith("gemini-"),
    perModel: true,
  };
}

interface QuotaWindow {
  readonly family: Family;
  readonly period: Period;
  /** 0 to 100, unrounded. */
  readonly usedPercent: number;
  readonly resetsAtMs: number | undefined;
  /** When it was read, for a window kept from an earlier read. */
  readonly checkedAt?: string;
}

const windowKey = (window: Pick<QuotaWindow, "family" | "period">) =>
  `${window.family.key}:${window.period}`;

function usedPercentOf(quota: typeof Quota.Type): number | undefined {
  const fraction = quota.remainingFraction;
  if (fraction === undefined || !Number.isFinite(fraction)) return undefined;
  return (1 - Math.max(0, Math.min(1, fraction))) * 100;
}

const parseTime = (value: string | undefined) => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Keeps the fuller of two readings of one window; on a tie, the one with a
 * reset time, then the earlier reset. A model's row is as tight as its
 * tightest thinking level.
 */
function fold(into: Map<string, QuotaWindow>, window: QuotaWindow) {
  const key = windowKey(window);
  const previous = into.get(key);
  if (
    previous === undefined ||
    window.usedPercent > previous.usedPercent ||
    (window.usedPercent === previous.usedPercent &&
      window.resetsAtMs !== undefined &&
      (previous.resetsAtMs === undefined || window.resetsAtMs < previous.resetsAtMs))
  ) {
    into.set(key, window);
  }
}

export interface ParsedBankedReset {
  readonly resetId: string;
  readonly host: string;
  readonly displayLabel: string | undefined;
  readonly expiresAtMs: number | undefined;
  readonly claimable: boolean;
  readonly ineligibleReason: "usage_below_threshold" | undefined;
  readonly remainingCount: number;
  readonly bucketIds: ReadonlyArray<string>;
}

interface ParsedQuotaWindows {
  readonly ok: boolean;
  readonly windows: ReadonlyArray<QuotaWindow>;
  readonly bankedResets: ReadonlyArray<ParsedBankedReset>;
}

function familyForBucketId(
  id: string,
  options?: {
    readonly pooled?: boolean;
    readonly groupDisplayName?: string | undefined;
    readonly bucketDisplayName?: string | undefined;
  },
): Family {
  const pooled = options?.pooled ?? /-(?:5h|weekly)$/.test(id);
  const sub = /^gemini-([a-z]+)-/.exec(id)?.[1];
  return (
    (id.startsWith("3p-")
      ? SHARED_3P
      : /^gemini-(5h|weekly|quota)$/.test(id)
        ? GEMINI
        : pooled && sub !== undefined
          ? geminiSubfamily(sub, options?.groupDisplayName)
          : !pooled
            ? perModelFamily(id, options?.bucketDisplayName)
            : undefined) ??
    ({
      key: `other-${id}`,
      label: options?.groupDisplayName?.trim() || options?.bucketDisplayName?.trim() || id,
      gemini: false,
    } satisfies Family)
  );
}

function parseBankedResetIneligibleReason(
  value: string | number | undefined,
): "usage_below_threshold" | undefined {
  if (value === 1) return "usage_below_threshold";
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (
      normalized === "QUOTA_SUMMARY_BANKED_RESET_INELIGIBLE_REASON_USAGE_BELOW_THRESHOLD" ||
      normalized === "USAGE_BELOW_THRESHOLD"
    ) {
      return "usage_below_threshold";
    }
  }
  return undefined;
}

function parseBankedResets(
  entries: ReadonlyArray<typeof BankedReset.Type> | undefined,
  host: string,
): ReadonlyArray<ParsedBankedReset> {
  if (!entries || entries.length === 0) return [];
  const byId = new Map<string, ParsedBankedReset>();
  for (const entry of entries) {
    const resetId = entry.resetId.trim();
    if (!resetId) continue;
    const claimable = entry.claimable === true;
    const rawCount = entry.remainingCount;
    const remainingCount =
      rawCount !== undefined && Number.isInteger(rawCount) && rawCount >= 0
        ? rawCount
        : claimable
          ? 1
          : 0;
    if (remainingCount <= 0) continue;
    const bucketIds = (entry.bucketIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
    byId.set(resetId, {
      resetId,
      host,
      displayLabel: entry.displayLabel?.trim() || undefined,
      expiresAtMs: parseTime(entry.expireTime),
      claimable,
      ineligibleReason: claimable
        ? undefined
        : parseBankedResetIneligibleReason(entry.ineligibleReason),
      remainingCount,
      bucketIds,
    });
  }
  return [...byId.values()];
}

function parseSummaryAnswer(
  answer: unknown,
  requestedAtMs: number,
  host = DAILY_HOST,
): ParsedQuotaWindows {
  const decoded = decodeSummary(answer);
  if (
    decoded._tag === "None" ||
    (decoded.value.groups === undefined &&
      decoded.value.buckets === undefined &&
      decoded.value.bankedResets === undefined)
  ) {
    return { ok: false, windows: [], bankedResets: [] };
  }
  const summary = decoded.value;
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ displayName: undefined, buckets: summary.buckets }];
  const windows = new Map<string, QuotaWindow>();
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      const usedPercent = usedPercentOf(bucket);
      if (usedPercent === undefined) continue;
      const pooled = bucket.window === "5h" || bucket.window === "weekly";
      const period: Period = pooled ? (bucket.window as Period) : "quota";
      const family = familyForBucketId(bucket.bucketId, {
        pooled,
        groupDisplayName: group.displayName,
        bucketDisplayName: bucket.displayName,
      });
      // A pool nobody has touched reports a reset one full window from now,
      // which is not a real reset time.
      const minutes = PERIOD_MINUTES[period];
      const resetsAtMs = parseTime(bucket.resetTime);
      const untouched =
        bucket.remainingFraction === 1 &&
        bucket.description === undefined &&
        minutes !== undefined &&
        resetsAtMs !== undefined &&
        Math.abs(resetsAtMs - requestedAtMs - minutes * 60_000) <= 60_000;
      fold(windows, {
        family,
        period,
        usedPercent,
        resetsAtMs: untouched ? undefined : resetsAtMs,
      });
    }
  }
  const bankedResets = parseBankedResets(summary.bankedResets, host);
  return { ok: true, windows: [...windows.values()], bankedResets };
}

/**
 * The windows in one `retrieveUserQuotaSummary` answer, requested at
 * `requestedAtMs`. Pools (`5h`, `weekly`) keep their own rows; an Enterprise
 * answer's per-model buckets get one row per model, its thinking levels
 * folded together.
 */
export function antigravitySummaryWindows(
  answer: unknown,
  requestedAtMs: number,
): ReadonlyArray<QuotaWindow> {
  return parseSummaryAnswer(answer, requestedAtMs).windows;
}

function parseModelsAnswer(answer: unknown): ParsedQuotaWindows {
  const decoded = decodeModels(answer);
  if (decoded._tag === "None") return { ok: false, windows: [], bankedResets: [] };
  const windows = new Map<string, QuotaWindow>();
  for (const [modelId, model] of Object.entries(decoded.value.models)) {
    if (model.isInternal) continue;
    const family = perModelFamily(modelId, model.displayName);
    if (!family) continue;
    for (const [period, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      const usedPercent = quota ? usedPercentOf(quota) : undefined;
      if (usedPercent === undefined) continue;
      fold(windows, { family, period, usedPercent, resetsAtMs: parseTime(quota?.resetTime) });
    }
  }
  return { ok: true, windows: [...windows.values()], bankedResets: [] };
}

/**
 * The windows in a `fetchAvailableModels` answer: each model's own quota.
 * Older accounts report quotas this way only, without a window length, so
 * none is made up.
 */
export function antigravityModelWindows(answer: unknown): ReadonlyArray<QuotaWindow> {
  return parseModelsAnswer(answer).windows;
}

/** Merges answers in host order: the first host's reading of a window wins. */
function mergeHosts(answers: ReadonlyArray<ReadonlyArray<QuotaWindow>>) {
  const merged = new Map<string, QuotaWindow>();
  for (const windows of answers) {
    for (const window of windows) {
      if (!merged.has(windowKey(window))) merged.set(windowKey(window), window);
    }
  }
  return [...merged.values()];
}

const FAMILY_ORDER = (family: Family) =>
  family.key === "gemini" ? 0 : family.gemini ? 1 : family === SHARED_3P || family.perModel ? 2 : 3;
const PERIOD_ORDER: Record<Period, number> = { "5h": 0, weekly: 1, quota: 2 };

/** Words as `usageScopeHoldsModel` (@threadlines/shared/usageLimits) reads them. */
const familyWords = (name: string) =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .filter(Boolean);
const holdsWords = (model: ReadonlyArray<string>, words: ReadonlyArray<string>) =>
  words.length > 0 &&
  model.some((_, start) => words.every((word, offset) => model[start + offset] === word));

/**
 * A used share as the snapshot carries it, in whole percent. Only an empty
 * quota is 100: rounding 99.6 up would say "limit reached" with quota left.
 */
function wholePercentUsed(usedPercent: number): number {
  return usedPercent >= 100 ? 100 : Math.min(99, Math.round(usedPercent));
}

function scopeForBankedReset(
  bucketIds: ReadonlyArray<string>,
  allFamilies: ReadonlyArray<Family>,
): {
  readonly label?: string;
  readonly scopeModels?: ReadonlyArray<string>;
  readonly scopeExcludes?: ReadonlyArray<string>;
} {
  if (bucketIds.length === 0) return {};
  const covered = new Map<string, Family>();
  for (const id of bucketIds) {
    const family = familyForBucketId(id);
    if (!covered.has(family.key)) covered.set(family.key, family);
  }
  const families = [...covered.values()];
  if (families.length === 0) return {};
  const label = families.map((family) => family.label).join(", ");
  // If any covered family is unrecognized (no `models`), don't constrain model matching
  // so we never falsely hide a valid reset on a new bucket id.
  if (families.some((family) => !family.models || family.models.length === 0)) {
    return { label };
  }
  const scopeModels = [...new Set(families.flatMap((family) => family.models ?? []))];
  const coveredKeys = new Set(covered.keys());
  const scopeExcludes: Array<string> = [];
  if (coveredKeys.has("gemini")) {
    for (const other of allFamilies) {
      if (
        other.gemini &&
        !other.perModel &&
        other.key !== "gemini" &&
        !coveredKeys.has(other.key)
      ) {
        for (const model of other.models ?? []) {
          if (!scopeExcludes.includes(model)) scopeExcludes.push(model);
        }
      }
    }
  }
  return {
    label,
    ...(scopeModels.length > 0 ? { scopeModels } : {}),
    ...(scopeExcludes.length > 0 ? { scopeExcludes } : {}),
  };
}

/**
 * Banked resets as the usage contract carries them. `availableCount` counts
 * spendable (claimable, unexpired) units; threshold-locked banked resets stay
 * in `credits` as `"unknown"` with their explanation so users can see them.
 */
export function antigravityRateLimitResetCredits(
  bankedResets: ReadonlyArray<ParsedBankedReset>,
  windows: ReadonlyArray<QuotaWindow>,
  nowMs: number,
): ServerProviderRateLimitResetCredits | undefined {
  const allFamilies = [
    ...new Map(windows.map((window) => [window.family.key, window.family])).values(),
  ];
  let availableCount = 0;
  const credits: Array<ServerProviderRateLimitResetCredit> = [];
  for (const reset of bankedResets) {
    if (reset.remainingCount <= 0) continue;
    if (reset.expiresAtMs !== undefined && reset.expiresAtMs <= nowMs) continue;
    const scope = scopeForBankedReset(reset.bucketIds, allFamilies);
    const title =
      reset.displayLabel ?? (scope.label ? `${scope.label} reset` : "Antigravity usage reset");
    let description: string | undefined;
    if (!reset.claimable) {
      const reason =
        reset.ineligibleReason === "usage_below_threshold"
          ? "Use more of this window before claiming"
          : "Not currently eligible";
      description =
        scope.label && !title.toLowerCase().includes(scope.label.toLowerCase())
          ? `${scope.label} · ${reason}`
          : reason;
    } else if (scope.label && !title.toLowerCase().includes(scope.label.toLowerCase())) {
      description = `Refreshes ${scope.label}`;
    }
    if (reset.claimable) {
      availableCount += reset.remainingCount;
    }
    credits.push({
      id: reset.resetId,
      resetType: "unknown",
      status: reset.claimable ? "available" : "unknown",
      ...(reset.expiresAtMs !== undefined ? { expiresAt: reset.expiresAtMs } : {}),
      title,
      ...(description ? { description } : {}),
      remainingCount: reset.remainingCount,
      ...(scope.scopeModels ? { scopeModels: scope.scopeModels } : {}),
      ...(scope.scopeExcludes ? { scopeExcludes: scope.scopeExcludes } : {}),
    });
  }
  if (credits.length === 0) return undefined;
  return { availableCount, credits };
}

/**
 * A reading as the snapshot carries it: every window is one family's or
 * model's own (`scoped`), since a spent one never stops the others. A row
 * leaves out the models that have a row of their own: the default Gemini pool
 * leaves out the Gemini 4 pools, and "Claude Opus 5" leaves out "Claude Opus
 * 5.5".
 */
export function antigravityAccountUsage(
  windows: ReadonlyArray<QuotaWindow>,
  checkedAt: string,
  bankedResets: ReadonlyArray<ParsedBankedReset> = [],
  nowMs: number = Date.parse(checkedAt) || Date.now(),
): ServerProviderAccountUsage {
  const families = [
    ...new Map(windows.map((window) => [window.family.key, window.family])).values(),
  ];
  const excludesOf = (family: Family): ReadonlyArray<string> => {
    if (family.key === "gemini") {
      return [
        ...new Set(
          families
            .filter((other) => other.gemini && !other.perModel && other.key !== "gemini")
            .flatMap((other) => other.models ?? []),
        ),
      ];
    }
    if (!family.perModel) return [];
    const words = familyWords(family.label);
    return families
      .filter(
        (other) =>
          other.perModel &&
          other.key !== family.key &&
          familyWords(other.label).length > words.length &&
          holdsWords(familyWords(other.label), words),
      )
      .map((other) => other.label);
  };
  const scoped = [...windows]
    .sort(
      (a, b) =>
        FAMILY_ORDER(a.family) - FAMILY_ORDER(b.family) ||
        a.family.label.localeCompare(b.family.label) ||
        PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period],
    )
    .map((window): ServerProviderScopedUsageWindow => {
      const usedPercent = wholePercentUsed(window.usedPercent);
      const minutes = PERIOD_MINUTES[window.period];
      const excludes = excludesOf(window.family);
      return {
        scopeLabel: window.family.label,
        ...(window.family.models ? { scopeModels: window.family.models } : {}),
        ...(excludes.length > 0 ? { scopeExcludes: excludes } : {}),
        usedPercent,
        remainingPercent: 100 - usedPercent,
        ...(window.resetsAtMs !== undefined ? { resetsAt: window.resetsAtMs } : {}),
        ...(minutes !== undefined ? { windowDurationMins: minutes } : {}),
        checkedAt: window.checkedAt ?? checkedAt,
      };
    });
  const rateLimitResetCredits = antigravityRateLimitResetCredits(bankedResets, windows, nowMs);
  return {
    // Older clients reject a source they don't know, and with it the whole
    // config, so the reading goes under an existing one and names itself
    // in `limitName` (see `ServerProviderAccountUsage.source`).
    source: "grok-billing",
    checkedAt,
    primaryLimitId: "antigravity",
    ...(rateLimitResetCredits ? { rateLimitResetCredits } : {}),
    limits: [{ limitId: "antigravity", limitName: ANTIGRAVITY_USAGE_LABEL, scoped }],
  };
}

// ── Requests ─────────────────────────────────────────────────────────

/** Why a request failed, in words that never carry the token. */
class UsageRequestError extends Schema.TaggedError<UsageRequestError>()(
  "AntigravityUsageRequestError",
  { reason: Schema.String },
) {}

interface Timeouts {
  readonly request: Duration.Input;
  readonly read: Duration.Input;
}

const SAFE_REQUEST_REASON = /^(?:status \d{3}|answer too large|invalid JSON|timed out)$/u;

const requestFailureReason = (cause: unknown): string =>
  cause instanceof Error && SAFE_REQUEST_REASON.test(cause.message)
    ? cause.message
    : "request failed";

const requestJson = (
  fetch: DownloadFetch,
  url: string,
  init: { method: "GET" | "POST"; accessToken: string; userAgent: string; body?: string },
  timeout: Duration.Input,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${init.accessToken}`,
          "User-Agent": init.userAgent,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`status ${response.status}`);
      }
      const text = await response.text();
      if (text.length > MAX_ANSWER_CHARS) throw new Error("answer too large");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("invalid JSON");
      }
    },
    // The cause can quote the request; only fixed status/reason words are kept.
    catch: (cause) => new UsageRequestError({ reason: requestFailureReason(cause) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new UsageRequestError({ reason: "timed out" })),
    }),
  );

interface ClaimHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

/** Sends a claim request and keeps non-2xx JSON bodies so Google RPC statuses map cleanly. */
const requestClaimJson = (
  fetch: DownloadFetch,
  url: string,
  init: { accessToken: string; userAgent: string; body: string },
  timeout: Duration.Input,
) =>
  Effect.tryPromise({
    try: async (signal): Promise<ClaimHttpResponse> => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${init.accessToken}`,
          "User-Agent": init.userAgent,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: init.body,
        redirect: "manual",
        signal,
      });
      const text = await response.text();
      if (text.length > MAX_ANSWER_CHARS) {
        if (!response.ok) return { ok: false, status: response.status, body: undefined };
        throw new Error("answer too large");
      }
      let body: unknown;
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          if (response.ok) throw new Error("invalid JSON");
        }
      }
      return { ok: response.ok, status: response.status, body };
    },
    catch: (cause) => new UsageRequestError({ reason: requestFailureReason(cause) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new UsageRequestError({ reason: "timed out" })),
    }),
  );

interface HostBankedResetsUpdate {
  readonly host: string;
  readonly answered: boolean;
  readonly bankedResets: ReadonlyArray<ParsedBankedReset>;
}

/** What a read got: its windows, per-host banked reset inventories, and whether every request answered. */
interface QuotaRead {
  readonly windows: ReadonlyArray<QuotaWindow>;
  readonly bankedByHost: ReadonlyArray<HostBankedResetsUpdate>;
  readonly complete: boolean;
}

/**
 * Replaces each answered host's banked reset inventory while retaining failed
 * hosts' prior inventories, then deduplicates in account host order.
 */
function mergeBankedResetsByHost(
  previous: Readonly<Record<string, ReadonlyArray<ParsedBankedReset>>> | undefined,
  updates: ReadonlyArray<HostBankedResetsUpdate>,
  hostOrder: ReadonlyArray<string>,
): {
  readonly byHost: Readonly<Record<string, ReadonlyArray<ParsedBankedReset>>>;
  readonly merged: ReadonlyArray<ParsedBankedReset>;
} {
  const byHost: Record<string, ReadonlyArray<ParsedBankedReset>> = { ...(previous ?? {}) };
  for (const update of updates) {
    if (update.answered) {
      byHost[update.host] = update.bankedResets;
    }
  }
  const seen = new Set<string>();
  const merged: Array<ParsedBankedReset> = [];
  for (const host of hostOrder) {
    for (const reset of byHost[host] ?? []) {
      if (seen.has(reset.resetId)) continue;
      seen.add(reset.resetId);
      merged.push(reset);
    }
  }
  return { byHost, merged };
}

/** One operation on every host, in the method's host order; a host that fails adds nothing. */
const askHosts = (
  fetch: DownloadFetch,
  method: GoogleMethod,
  accessToken: string,
  operation: "retrieveUserQuotaSummary" | "fetchAvailableModels",
  parse: (answer: unknown, requestedAtMs: number, host: string) => ParsedQuotaWindows,
  timeout: Duration.Input,
  project?: string,
) => {
  const body = project ? JSON.stringify({ project }) : "{}";
  return Effect.forEach(
    HOSTS_BY_METHOD[method],
    (host) =>
      Effect.gen(function* () {
        const requestedAtMs = yield* Clock.currentTimeMillis;
        const answer = yield* requestJson(
          fetch,
          `https://${host}/v1internal:${operation}`,
          { method: "POST", accessToken, userAgent: ANTIGRAVITY_USAGE_USER_AGENT, body },
          timeout,
        );
        const parsed = parse(answer, requestedAtMs, host);
        if (!parsed.ok) {
          yield* Effect.logWarning("Antigravity usage response had an unexpected shape", {
            host,
            operation,
          });
          return { host, answered: false, windows: [] as const, bankedResets: [] as const };
        }
        return {
          host,
          answered: true,
          windows: parsed.windows,
          bankedResets: parsed.bankedResets,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Antigravity usage request failed", {
            host,
            operation,
            reason: error.reason,
          }).pipe(
            Effect.as({ host, answered: false, windows: [] as const, bankedResets: [] as const }),
          ),
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((answers): QuotaRead => ({
      complete: answers.every((answer) => answer.answered),
      windows: mergeHosts(answers.map((answer) => answer.windows)),
      bankedByHost: answers.map((answer) => ({
        host: answer.host,
        answered: answer.answered,
        bankedResets: answer.bankedResets,
      })),
    })),
  );
};

/**
 * One full read. The summary comes first; when it has no Gemini row (Google
 * leaves it out for some clients) the per-model quotas fill in Gemini, and
 * when it has nothing they stand in for all of it.
 */
const readQuotaWindows = (
  fetch: DownloadFetch,
  method: GoogleMethod,
  accessToken: string,
  timeout: Duration.Input,
  project?: string,
) =>
  Effect.gen(function* () {
    const summary = yield* askHosts(
      fetch,
      method,
      accessToken,
      "retrieveUserQuotaSummary",
      parseSummaryAnswer,
      timeout,
      project,
    );
    if (summary.windows.some((window) => window.family.gemini)) return summary;
    const models = yield* askHosts(
      fetch,
      method,
      accessToken,
      "fetchAvailableModels",
      parseModelsAnswer,
      timeout,
      project,
    );
    if (summary.windows.length === 0) {
      return {
        windows: models.windows,
        bankedByHost: summary.bankedByHost,
        complete: summary.complete && models.complete,
      };
    }
    return {
      windows: [...summary.windows, ...models.windows.filter((window) => window.family.gemini)],
      bankedByHost: summary.bankedByHost,
      complete: summary.complete && models.complete,
    } satisfies QuotaRead;
  });

const readEmail = (fetch: DownloadFetch, accessToken: string, timeout: Duration.Input) =>
  requestJson(
    fetch,
    USERINFO_URL,
    { method: "GET", accessToken, userAgent: THREADLINES_USER_AGENT },
    timeout,
  ).pipe(
    Effect.map((answer) => {
      const decoded = decodeUserInfo(answer);
      return decoded._tag === "Some" ? cleanEmail(decoded.value.email) : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * A read on top of the last one for the same account. Where a host or the
 * per-model fallback didn't answer, the rows it would have given are kept
 * from before, with the time they were read, so a partial outage doesn't
 * drop them. Where every request was answered, the read stands as it is.
 */
function mergeRead(
  previous: ReadonlyArray<QuotaWindow> | undefined,
  read: QuotaRead,
  checkedAt: string,
): ReadonlyArray<QuotaWindow> {
  const fresh = read.windows.map((window) => ({ ...window, checkedAt }));
  if (read.complete || previous === undefined) return fresh;
  const got = new Set(fresh.map(windowKey));
  return [...fresh, ...previous.filter((window) => !got.has(windowKey(window)))];
}

// ── The reader ───────────────────────────────────────────────────────

export const ANTIGRAVITY_USAGE_EXPIRED_DETAIL =
  "Start a chat to refresh these limits. Antigravity renews its Google sign-in only while it runs.";
export const ANTIGRAVITY_USAGE_FAILED_DETAIL =
  "Couldn't read Antigravity limits. Trying again soon.";

/** What a status check shows of the plan: the reading, the email, and what to say about either. */
export interface AntigravityUsageStatus {
  /** Names the Google account the rest belongs to (`ServerProviderAuth.accountId`). */
  readonly accountId?: string;
  readonly accountUsage?: ServerProviderAccountUsage;
  readonly email?: string;
  /** Set when there is something to say: an expired token, or a failed read. */
  readonly usage?: ServerProviderAuthCapability;
}

/** The instance's snapshot, as the reader uses it once it exists. */
export type AntigravityUsageSnapshot = Pick<ServerProviderShape, "getSnapshot" | "patchSnapshot">;

export class AntigravityBankedResetClaimError extends Data.TaggedError(
  "AntigravityBankedResetClaimError",
)<{
  readonly message: string;
}> {}

export interface AntigravityUsageReader {
  /**
   * The last reading for the sign-in on disk, never waiting on Google: it
   * reads only the token file, and starts a read in the background when one
   * is due. Empty for a method that isn't a Google sign-in, or when signed out.
   */
  readonly status: Effect.Effect<AntigravityUsageStatus>;
  /**
   * Checks the sign-in on disk and starts a background read if due or if the
   * CLI just renewed the access token (e.g. when a chat session starts or
   * finishes a turn).
   */
  readonly refresh: Effect.Effect<void>;
  /**
   * Folds the latest landed background reading onto a freshly checked snapshot
   * when both belong to the same account, so a read that completed during
   * model discovery is not overwritten by the earlier probe result.
   */
  readonly reconcile: (snapshot: ServerProvider) => ServerProvider;
  /** Cancels a read in flight and forgets every reading: for sign-in and sign-out. */
  readonly reset: Effect.Effect<void>;
  /** The instance's snapshot, once it exists: finished reads publish to it. */
  readonly attach: (snapshot: AntigravityUsageSnapshot) => void;
  /**
   * The limit the last reading says `model` (a picker slug, or a model's
   * name) is stopped on, for Continue at reset when the agent gave no time.
   */
  readonly usageLimitFor: (model: string) => Effect.Effect<RuntimeUsageLimit | undefined>;
  /**
   * Claims one banked quota reset via Google's `v1internal:claimBankedQuotaReset`,
   * updating the cached usage snapshot immediately from the returned summary.
   */
  readonly claimBankedReset: (input: {
    readonly idempotencyKey: string;
    readonly creditId?: string;
    readonly accountId?: string;
  }) => Effect.Effect<
    { readonly outcome: ServerProviderRateLimitResetCreditOutcome },
    AntigravityBankedResetClaimError
  >;
}

export interface AntigravityUsageReaderInput {
  readonly profileDir: string;
  readonly method: AntigravityAuthMethod;
  /** `antigravityCredentialFingerprint` of the instance's sign-in. */
  readonly fingerprint: string;
  /** Google Cloud project for Gemini Enterprise (`oauth-business`), sent in Cloud Code requests. */
  readonly project?: string;
  /** Test seam; by default a fetch held to `ANTIGRAVITY_USAGE_HOSTS` with no redirects. */
  readonly fetch?: DownloadFetch;
  /** Test seam; by default 10 seconds per request and 30 per read. */
  readonly timeouts?: Timeouts;
}

interface Reading {
  readonly key: string;
  readonly windows: ReadonlyArray<QuotaWindow>;
  readonly bankedByHost: Readonly<Record<string, ReadonlyArray<ParsedBankedReset>>>;
  readonly bankedResets: ReadonlyArray<ParsedBankedReset>;
  readonly accountUsage: ServerProviderAccountUsage;
}

function googleClaimErrorOutcome(
  status: number,
  body: unknown,
):
  | { readonly kind: "outcome"; readonly outcome: ServerProviderRateLimitResetCreditOutcome }
  | { readonly kind: "error"; readonly message: string } {
  const err =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { readonly error?: unknown }).error
      : undefined;
  const rpcStatus =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { status?: unknown }).status === "string"
      ? (err as { status: string }).status.trim().toUpperCase()
      : "";
  const rpcMessage =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message.trim()
      : "";
  const lowerMessage = rpcMessage.toLowerCase();

  if (
    rpcStatus === "FAILED_PRECONDITION" ||
    lowerMessage.includes("below threshold") ||
    lowerMessage.includes("not eligible") ||
    lowerMessage.includes("nothing to reset")
  ) {
    return { kind: "outcome", outcome: "nothingToReset" };
  }
  if (
    rpcStatus === "ALREADY_EXISTS" ||
    lowerMessage.includes("already claimed") ||
    lowerMessage.includes("already redeemed")
  ) {
    return { kind: "outcome", outcome: "alreadyRedeemed" };
  }
  if (
    rpcStatus === "NOT_FOUND" ||
    lowerMessage.includes("no banked reset") ||
    lowerMessage.includes("no reset") ||
    lowerMessage.includes("expired") ||
    lowerMessage.includes("exhausted")
  ) {
    return { kind: "outcome", outcome: "noCredit" };
  }
  if (status === 401 || rpcStatus === "UNAUTHENTICATED") {
    return {
      kind: "error",
      message:
        "Antigravity's Google sign-in has expired. Send a message in an Antigravity chat to renew it, then try again.",
    };
  }
  return {
    kind: "error",
    message: `Antigravity couldn't claim this reset (status ${status}).`,
  };
}

function selectClaimableBankedReset(
  resets: ReadonlyArray<ParsedBankedReset>,
  nowMs: number,
): ParsedBankedReset | undefined {
  const candidates = resets.filter(
    (reset) =>
      reset.claimable &&
      reset.remainingCount > 0 &&
      (reset.expiresAtMs === undefined || reset.expiresAtMs > nowMs),
  );
  if (candidates.length === 0) return undefined;
  return candidates.toSorted((left, right) => {
    const a = left.expiresAtMs ?? Number.POSITIVE_INFINITY;
    const b = right.expiresAtMs ?? Number.POSITIVE_INFINITY;
    return a - b;
  })[0];
}

export const makeAntigravityUsageReader = (
  input: AntigravityUsageReaderInput,
): Effect.Effect<AntigravityUsageReader, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fetch =
      input.fetch ?? makeHttpsFetch({ allowedHosts: ANTIGRAVITY_USAGE_HOSTS, maxRedirects: 0 });
    const timeouts = input.timeouts ?? { request: REQUEST_TIMEOUT, read: READ_TIMEOUT };
    const inFlight = yield* FiberHandle.make<void, never>();
    const claimLock = Semaphore.makeUnsafe(1);
    let reading: Reading | undefined;
    let emails = new Map<string, string>();
    /** The key, access-token hash, time and outcome of the last read started. */
    let lastAttempt: { key: string; tokenHash: string; atMs: number; failed: boolean } | undefined;
    /** Most recent background read landed for the active account, for `reconcile`. */
    let latestLanded:
      | { readonly accountId: string; readonly status: AntigravityUsageStatus }
      | undefined;
    /** Avoids repeating the same unreadable-token warning on every 5-minute probe. */
    let warnedTokenHash: string | undefined;
    /** Bumped by `reset` and claim commits: a read started before it doesn't land. */
    let generation = 0;
    let snapshot: AntigravityUsageSnapshot | undefined;

    const readToken = readSavedToken(input.profileDir, (warningKey, detail) =>
      warnedTokenHash === warningKey
        ? Effect.void
        : Effect.suspend(() => {
            warnedTokenHash = warningKey;
            return Effect.logWarning("Antigravity token file could not be read for usage", {
              reason: detail,
            });
          }),
    );

    const keyOf = (token: SavedToken) => `${input.fingerprint}:${token.accountKey}`;

    const statusFor = (token: SavedToken, key: string, nowMs: number): AntigravityUsageStatus => {
      const kept = reading?.key === key ? reading.accountUsage : undefined;
      const email = token.email ?? emails.get(key);
      const expired =
        token.expiresAtMs === undefined || token.expiresAtMs <= nowMs + EXPIRY_MARGIN_MS;
      const usage: ServerProviderAuthCapability | undefined = expired
        ? { status: "unavailable", detail: ANTIGRAVITY_USAGE_EXPIRED_DETAIL }
        : lastAttempt?.key === key && lastAttempt.failed
          ? {
              status: "unavailable",
              reason: "unreachable",
              detail: ANTIGRAVITY_USAGE_FAILED_DETAIL,
            }
          : undefined;
      return {
        accountId: accountIdOf(key),
        ...(kept ? { accountUsage: kept } : {}),
        ...(email ? { email } : {}),
        ...(usage ? { usage } : {}),
      };
    };

    const publishStatus = (status: AntigravityUsageStatus) =>
      snapshot
        ? snapshot.patchSnapshot((current) => {
            if (
              !current.enabled ||
              current.auth.status !== "authenticated" ||
              current.auth.type !== input.method
            ) {
              return null;
            }
            return withAntigravityUsage(current, status);
          })
        : Effect.void;

    /**
     * Where every read ends, done or timed out: only while the sign-in it read
     * for is still the one on disk, so one account's numbers and email never
     * land on another's.
     */
    const land = (
      key: string,
      tokenHash: string,
      started: number,
      read: QuotaRead,
      email: string | undefined,
      hostOrder: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const current = yield* readToken;
        if (generation !== started || current === undefined || keyOf(current) !== key) return;
        const nowMs = yield* Clock.currentTimeMillis;
        const checkedAt = new Date(nowMs).toISOString();
        const previousForKey = reading?.key === key ? reading : undefined;
        const nextBanked = mergeBankedResetsByHost(
          previousForKey?.bankedByHost,
          read.bankedByHost,
          hostOrder,
        );
        const anyAnswered = read.bankedByHost.some((entry) => entry.answered);
        const hasReadingData =
          read.windows.length > 0 ||
          nextBanked.merged.length > 0 ||
          (previousForKey !== undefined && anyAnswered);
        if (hasReadingData) {
          const windows =
            read.windows.length > 0
              ? mergeRead(previousForKey?.windows, read, checkedAt)
              : (previousForKey?.windows ?? []);
          reading = {
            key,
            windows,
            bankedByHost: nextBanked.byHost,
            bankedResets: nextBanked.merged,
            accountUsage: antigravityAccountUsage(windows, checkedAt, nextBanked.merged, nowMs),
          };
        }
        if (email) emails.set(key, email);
        lastAttempt = {
          key,
          tokenHash,
          atMs:
            lastAttempt?.key === key && lastAttempt.tokenHash === tokenHash
              ? lastAttempt.atMs
              : nowMs,
          failed: (read.windows.length === 0 && nextBanked.merged.length === 0) || !read.complete,
        };
        const nextStatus = statusFor(current, key, nowMs);
        latestLanded = { accountId: accountIdOf(key), status: nextStatus };
        yield* publishStatus(nextStatus);
      });

    const read = (token: SavedToken, key: string, method: GoogleMethod) =>
      Effect.gen(function* () {
        const started = generation;
        const hostOrder = HOSTS_BY_METHOD[method];
        return yield* Effect.gen(function* () {
          const [windows, email] = yield* Effect.all(
            [
              readQuotaWindows(
                fetch,
                method,
                token.accessToken,
                timeouts.request,
                input.project?.trim() || undefined,
              ),
              token.email !== undefined || emails.has(key)
                ? Effect.succeed(token.email ?? emails.get(key))
                : readEmail(fetch, token.accessToken, timeouts.request),
            ],
            { concurrency: "unbounded" },
          );
          yield* land(key, token.tokenHash, started, windows, email, hostOrder);
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeouts.read,
            orElse: () =>
              land(
                key,
                token.tokenHash,
                started,
                { windows: [], bankedByHost: [], complete: false },
                undefined,
                hostOrder,
              ),
          }),
        );
      }).pipe(
        // Nothing a read does may fail the instance.
        Effect.catchCause(() => Effect.void),
      );

    const status = Effect.gen(function* () {
      if (!isGoogleMethod(input.method)) return {};
      const token = yield* readToken;
      if (token === undefined) {
        // Signed out: whatever is kept belongs to a sign-in that's gone.
        reading = undefined;
        latestLanded = undefined;
        return {};
      }
      warnedTokenHash = undefined;
      const key = keyOf(token);
      const accountId = accountIdOf(key);
      if (reading !== undefined && reading.key !== key) reading = undefined;
      const nowMs = yield* Clock.currentTimeMillis;
      const expired =
        token.expiresAtMs === undefined || token.expiresAtMs <= nowMs + EXPIRY_MARGIN_MS;
      if (latestLanded !== undefined && (latestLanded.accountId !== accountId || expired)) {
        latestLanded = undefined;
      }
      const tokenChanged =
        lastAttempt !== undefined &&
        (lastAttempt.key !== key || lastAttempt.tokenHash !== token.tokenHash);
      const due =
        lastAttempt === undefined ||
        tokenChanged ||
        nowMs - lastAttempt.atMs >= MIN_READ_INTERVAL_MS;
      if (!expired && due) {
        lastAttempt = {
          key,
          tokenHash: token.tokenHash,
          atMs: nowMs,
          failed: lastAttempt?.key === key && !tokenChanged ? lastAttempt.failed : false,
        };
        // A changed account or renewed token replaces any read still running on the old one.
        yield* FiberHandle.run(inFlight, read(token, key, input.method), {
          onlyIfMissing: !tokenChanged,
        });
      }
      return statusFor(token, key, nowMs);
    }).pipe(Effect.catchCause(() => Effect.succeed({})));

    const reconcile = (next: ServerProvider): ServerProvider => {
      if (
        !next.enabled ||
        next.auth.status !== "authenticated" ||
        next.auth.type !== input.method ||
        latestLanded === undefined
      ) {
        return next;
      }
      // `latestLanded` is cleared on sign-out, expiry, reset, and whenever `status`
      // sees a different account, and only set after `land` confirms the token on
      // disk still matches. It is therefore never older than `next`, even when an
      // account switched while model discovery was still running.
      return withAntigravityUsage(next, latestLanded.status);
    };

    const claimBankedReset: AntigravityUsageReader["claimBankedReset"] = (claimInput) =>
      claimLock.withPermits(1)(
        Effect.gen(function* () {
          if (!isGoogleMethod(input.method)) {
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({
                message: "Banked resets are only available for Google sign-in accounts.",
              }),
            );
          }
          const method = input.method;
          const hostOrder = HOSTS_BY_METHOD[method];
          const project = input.project?.trim() || undefined;
          const token = yield* readToken;
          if (token === undefined) {
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({
                message: "Sign in to Antigravity with Google before using a reset.",
              }),
            );
          }
          const nowMs = yield* Clock.currentTimeMillis;
          if (token.expiresAtMs === undefined || token.expiresAtMs <= nowMs + EXPIRY_MARGIN_MS) {
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({
                message:
                  "Antigravity's Google sign-in has expired. Send a message in an Antigravity chat to renew it, then try again.",
              }),
            );
          }
          const expectedKey = keyOf(token);
          if (
            (claimInput.accountId !== undefined &&
              accountIdOf(expectedKey) !== claimInput.accountId) ||
            (reading !== undefined && reading.key !== expectedKey)
          ) {
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({
                message: "The signed-in Antigravity account changed. Refresh and try again.",
              }),
            );
          }
          const requestedId = claimInput.creditId?.trim() || undefined;
          let currentResets = reading?.key === expectedKey ? reading.bankedResets : undefined;
          if (
            currentResets === undefined ||
            (requestedId !== undefined &&
              !currentResets.some((entry) => entry.resetId === requestedId))
          ) {
            // Capture generation before the network read so any intervening reset/claim invalidates it.
            const started = generation;
            const fresh = yield* readQuotaWindows(
              fetch,
              method,
              token.accessToken,
              timeouts.request,
              project,
            );
            yield* land(
              expectedKey,
              token.tokenHash,
              started,
              fresh,
              token.email ?? emails.get(expectedKey),
              hostOrder,
            );
            currentResets = reading?.key === expectedKey ? reading.bankedResets : [];
          }

          const matched =
            requestedId !== undefined
              ? currentResets.find((entry) => entry.resetId === requestedId)
              : selectClaimableBankedReset(currentResets, yield* Clock.currentTimeMillis);

          let resetId: string;
          let targetHost: string;
          if (matched !== undefined) {
            resetId = matched.resetId;
            targetHost = matched.host;
          } else if (requestedId !== undefined) {
            resetId = requestedId;
            targetHost = hostOrder[0];
          } else {
            const checkMs = yield* Clock.currentTimeMillis;
            const hasIneligible = currentResets.some(
              (entry) =>
                entry.remainingCount > 0 &&
                (entry.expiresAtMs === undefined || entry.expiresAtMs > checkMs),
            );
            return {
              outcome: hasIneligible ? ("nothingToReset" as const) : ("noCredit" as const),
            };
          }

          // Confirm the profile still holds the same valid Google sign-in right before POSTing.
          const latestToken = yield* readToken;
          const beforePostMs = yield* Clock.currentTimeMillis;
          if (
            latestToken === undefined ||
            keyOf(latestToken) !== expectedKey ||
            (claimInput.accountId !== undefined &&
              accountIdOf(keyOf(latestToken)) !== claimInput.accountId)
          ) {
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({
                message: "The signed-in Antigravity account changed. Refresh and try again.",
              }),
            );
          }
          if (
            latestToken.expiresAtMs === undefined ||
            latestToken.expiresAtMs <= beforePostMs + EXPIRY_MARGIN_MS
          ) {
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({
                message:
                  "Antigravity's Google sign-in has expired. Send a message in an Antigravity chat to renew it, then try again.",
              }),
            );
          }

          const requestBody = JSON.stringify({
            ...(project ? { project } : {}),
            resetId,
            requestId: claimInput.idempotencyKey,
          });
          const response = yield* requestClaimJson(
            fetch,
            `https://${targetHost}/v1internal:claimBankedQuotaReset`,
            {
              accessToken: latestToken.accessToken,
              userAgent: ANTIGRAVITY_USAGE_USER_AGENT,
              body: requestBody,
            },
            timeouts.request,
          ).pipe(
            Effect.mapError(
              (error) =>
                new AntigravityBankedResetClaimError({
                  message:
                    error.reason === "timed out"
                      ? "Antigravity didn't respond in time while claiming this reset. Try again to confirm."
                      : `Antigravity couldn't claim this reset (${error.reason}).`,
                }),
            ),
          );

          if (!response.ok) {
            const mapped = googleClaimErrorOutcome(response.status, response.body);
            if (mapped.kind === "outcome") {
              return { outcome: mapped.outcome };
            }
            return yield* Effect.fail(
              new AntigravityBankedResetClaimError({ message: mapped.message }),
            );
          }

          // Invalidate any pre-claim background poll so it cannot overwrite the claim result.
          generation += 1;
          yield* FiberHandle.clear(inFlight);

          const afterMs = yield* Clock.currentTimeMillis;
          const checkedAt = new Date(afterMs).toISOString();
          const decodedClaim = decodeClaimResponse(response.body);
          const summaryPayload =
            decodedClaim._tag === "Some"
              ? (decodedClaim.value.quotaSummary ?? decodedClaim.value)
              : undefined;
          const parsedSummary =
            summaryPayload !== undefined
              ? parseSummaryAnswer(summaryPayload, afterMs, targetHost)
              : undefined;

          const postToken = yield* readToken;
          if (postToken !== undefined && keyOf(postToken) === expectedKey) {
            if (parsedSummary?.ok) {
              const previousForKey = reading?.key === expectedKey ? reading : undefined;
              // Drop the claimed resetId from other hosts' stale cached inventories so
              // an exhausted credit cannot resurface from a sibling host's older poll,
              // while keeping unrelated credits on other hosts intact.
              const prunedPreviousByHost =
                previousForKey?.bankedByHost !== undefined
                  ? Object.fromEntries(
                      Object.entries(previousForKey.bankedByHost).map(([host, entries]) => [
                        host,
                        host === targetHost
                          ? entries
                          : entries.filter((entry) => entry.resetId !== resetId),
                      ]),
                    )
                  : undefined;
              const hostUpdates: ReadonlyArray<HostBankedResetsUpdate> = [
                { host: targetHost, answered: true, bankedResets: parsedSummary.bankedResets },
              ];
              const nextBanked = mergeBankedResetsByHost(
                prunedPreviousByHost,
                hostUpdates,
                hostOrder,
              );
              const nextWindows =
                parsedSummary.windows.length > 0
                  ? mergeRead(
                      previousForKey?.windows,
                      {
                        windows: parsedSummary.windows,
                        bankedByHost: hostUpdates,
                        complete: false,
                      },
                      checkedAt,
                    )
                  : (previousForKey?.windows ?? []);
              reading = {
                key: expectedKey,
                windows: nextWindows,
                bankedByHost: nextBanked.byHost,
                bankedResets: nextBanked.merged,
                accountUsage: antigravityAccountUsage(
                  nextWindows,
                  checkedAt,
                  nextBanked.merged,
                  afterMs,
                ),
              };
              lastAttempt = {
                key: expectedKey,
                tokenHash: postToken.tokenHash,
                atMs: afterMs,
                failed: false,
              };
              const nextStatus = statusFor(postToken, expectedKey, afterMs);
              latestLanded = { accountId: accountIdOf(expectedKey), status: nextStatus };
              yield* publishStatus(nextStatus);
            } else {
              // No refreshed summary returned: let the next status refresh re-read immediately.
              lastAttempt = undefined;
            }
          }
          return { outcome: "reset" as const };
        }),
      );

    /** A picker slug's model name, from the instance's model list; a name passes through. */
    const modelName = (model: string) =>
      snapshot
        ? snapshot.getSnapshot.pipe(
            Effect.map(
              (current) =>
                current.models.find((candidate) => candidate.slug === model)?.name ?? model,
            ),
          )
        : Effect.succeed(model);

    return {
      status,
      refresh: Effect.asVoid(status),
      reconcile,
      reset: Effect.gen(function* () {
        generation += 1;
        yield* FiberHandle.clear(inFlight);
        reading = undefined;
        emails = new Map();
        lastAttempt = undefined;
        latestLanded = undefined;
        warnedTokenHash = undefined;
      }),
      attach: (next) => {
        snapshot = next;
      },
      usageLimitFor: (model) =>
        Effect.gen(function* () {
          if (!isGoogleMethod(input.method)) return undefined;
          const token = yield* readToken;
          if (token === undefined || reading?.key !== keyOf(token)) return undefined;
          return usageLimitForModel(
            reading.accountUsage,
            yield* modelName(model),
            yield* Clock.currentTimeMillis,
          );
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
      claimBankedReset,
    } satisfies AntigravityUsageReader;
  });

/** An opaque name for one Google account on one instance's sign-in; never the token's hash itself. */
const accountIdOf = (key: string) =>
  createHash("sha256").update(`antigravity-account-id/1\0${key}`).digest("hex").slice(0, 16);

/**
 * A snapshot (or status) with a usage status folded in: the reading, the
 * email, the line about them, and the account they belong to. A status
 * without a reading keeps the one already there, the last good one, but only
 * for the same account: another account's numbers and email are dropped.
 */
export function withAntigravityUsage<
  T extends {
    readonly auth: ServerProviderAuth;
    readonly accountUsage?: ServerProviderAccountUsage | undefined;
  },
>(target: T, status: AntigravityUsageStatus): T {
  const { capabilities, email: previousEmail, accountId: previousAccountId, ...auth } = target.auth;
  const { usage: _previous, ...others } = capabilities ?? {};
  const nextCapabilities = { ...others, ...(status.usage ? { usage: status.usage } : {}) };
  const sameAccount = previousAccountId === undefined || previousAccountId === status.accountId;
  const { accountUsage: previousUsage, ...rest } = target;
  const email = status.email ?? (sameAccount ? previousEmail : undefined);
  const accountUsage = status.accountUsage ?? (sameAccount ? previousUsage : undefined);
  return {
    ...rest,
    auth: {
      ...auth,
      ...(status.accountId ? { accountId: status.accountId } : {}),
      ...(email ? { email } : {}),
      ...(Object.keys(nextCapabilities).length > 0 ? { capabilities: nextCapabilities } : {}),
    },
    ...(accountUsage ? { accountUsage } : {}),
  } as T;
}
