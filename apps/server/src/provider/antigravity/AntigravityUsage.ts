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
 *   redirect, under Threadlines' own User-Agent. The token is never logged:
 *   errors are dropped for fixed words.
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
  ServerProviderScopedUsageWindow,
} from "@threadlines/contracts";
import { usageLimitForModel } from "@threadlines/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

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

/** Threadlines under its own name; never another app's client string. */
export const ANTIGRAVITY_USAGE_USER_AGENT = `Threadlines/${THREADLINES_ACP_CLIENT_INFO.version}`;

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
    refresh_token: Schema.optional(Schema.String),
    expiry: Schema.optional(Schema.String),
  }),
  id_token_email: Schema.optional(Schema.String),
});
const decodeTokenFile = Schema.decodeUnknownOption(Schema.fromJsonString(TokenFile));

interface SavedToken {
  readonly accessToken: string;
  /** Undefined when the file doesn't say: then it counts as expired. */
  readonly expiresAtMs: number | undefined;
  readonly email: string | undefined;
  /** Names the Google sign-in without holding it. */
  readonly accountKey: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

const cleanEmail = (value: string | undefined) => {
  const email = value?.trim();
  return email && email.includes("@") && email.length <= 320 ? email : undefined;
};

const readSavedToken = (profileDir: string) =>
  Effect.promise(async (): Promise<SavedToken | undefined> => {
    const raw = await fs.readFile(antigravityTokenPath(profileDir), "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    const decoded = decodeTokenFile(raw);
    if (decoded._tag === "None") return undefined;
    const { token, id_token_email } = decoded.value;
    const expiresAtMs = token.expiry ? Date.parse(token.expiry) : Number.NaN;
    const email = cleanEmail(id_token_email);
    return {
      accessToken: token.access_token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
      email,
      // The refresh token outlives renewals; the access token is the last resort.
      accountKey: sha256(
        `antigravity-account/1\0${token.refresh_token || email || token.access_token}`,
      ),
    };
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
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      isInternal: Schema.optional(Schema.Boolean),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});
const UserInfo = Schema.Struct({ email: Schema.optional(Schema.String) });

const decodeSummary = Schema.decodeUnknownOption(Summary);
const decodeModels = Schema.decodeUnknownOption(Models);
const decodeUserInfo = Schema.decodeUnknownOption(UserInfo);

type Period = "5h" | "weekly" | "quota";
const PERIOD_MINUTES: Record<Period, number | undefined> = {
  "5h": 5 * 60,
  weekly: 7 * 24 * 60,
  quota: undefined,
};

/** A group of models one quota covers. */
interface Family {
  readonly key: string;
  readonly label: string;
  /** Names a model holds to be in the family; undefined: the label. */
  readonly models?: ReadonlyArray<string>;
}

const GEMINI: Family = { key: "gemini", label: "Gemini", models: ["Gemini"] };
const SHARED_3P: Family = { key: "3p", label: "Claude & GPT", models: ["Claude", "GPT"] };
const CLAUDE: Family = { key: "claude", label: "Claude", models: ["Claude"] };
const GPT: Family = { key: "gpt", label: "GPT", models: ["GPT"] };

/**
 * Gemini 4's own quota families as Google has named them so far. An Enterprise
 * answer meters per model and has no pool to learn them from, so a per-model
 * bucket is placed by these and by the pools in the same answer.
 */
const KNOWN_GEMINI_SUBFAMILIES = ["argon", "carbon", "neon", "hydrogen"];

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function geminiSubfamily(sub: string, groupName: string | undefined): Family {
  const named = groupName?.trim();
  return {
    key: `gemini-${sub}`,
    label:
      named && named.toLowerCase().split(/\s+/).includes(sub) ? named : `Gemini ${capitalize(sub)}`,
    models: [capitalize(sub)],
  };
}

interface QuotaWindow {
  readonly family: Family;
  readonly period: Period;
  /** 0 to 100, unrounded. */
  readonly usedPercent: number;
  readonly resetsAtMs: number | undefined;
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
 * reset time, then the earlier reset. A family's quota is as tight as its
 * tightest model.
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

/** The family a model's id belongs to, for per-model quotas. */
function modelFamily(
  modelId: string,
  provider: string | undefined,
  subfamilies: ReadonlySet<string>,
): Family | undefined {
  const id = modelId.toLowerCase();
  if (provider === "MODEL_PROVIDER_GOOGLE" || id.startsWith("gemini-")) {
    const words = id.split(/[^a-z0-9]+/);
    const sub = words.find((word) => subfamilies.has(word));
    return sub ? geminiSubfamily(sub, undefined) : GEMINI;
  }
  if (provider === "MODEL_PROVIDER_ANTHROPIC" || id.startsWith("claude-")) return CLAUDE;
  if (provider === "MODEL_PROVIDER_OPENAI" || id.startsWith("gpt-")) return GPT;
  return undefined;
}

/**
 * The windows in one `retrieveUserQuotaSummary` answer, requested at
 * `requestedAtMs`. Pools (`5h`, `weekly`) keep their own rows; an Enterprise
 * answer's per-model buckets fold into one row per family.
 */
export function antigravitySummaryWindows(
  answer: unknown,
  requestedAtMs: number,
): ReadonlyArray<QuotaWindow> {
  const decoded = decodeSummary(answer);
  if (decoded._tag === "None") return [];
  const summary = decoded.value;
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ displayName: undefined, buckets: summary.buckets }];
  const buckets = (groups ?? []).flatMap((group) =>
    (group.buckets ?? [])
      .filter((bucket) => !bucket.disabled)
      .map((bucket) => ({ bucket, groupName: group.displayName })),
  );
  // Pools first: they name the Gemini sub-families this account has.
  const subfamilies = new Set(KNOWN_GEMINI_SUBFAMILIES);
  for (const { bucket } of buckets) {
    const sub = /^gemini-([a-z]+)-/.exec(bucket.bucketId)?.[1];
    if (sub && (bucket.window === "5h" || bucket.window === "weekly")) subfamilies.add(sub);
  }
  const windows = new Map<string, QuotaWindow>();
  for (const { bucket, groupName } of buckets) {
    const usedPercent = usedPercentOf(bucket);
    if (usedPercent === undefined) continue;
    const pooled = bucket.window === "5h" || bucket.window === "weekly";
    const period: Period = pooled ? (bucket.window as Period) : "quota";
    const id = bucket.bucketId;
    let family: Family | undefined;
    if (id.startsWith("3p-")) family = SHARED_3P;
    else if (/^gemini-(5h|weekly|quota)$/.test(id)) family = GEMINI;
    else if (pooled && /^gemini-[a-z]+-/.test(id)) {
      family = geminiSubfamily(/^gemini-([a-z]+)-/.exec(id)![1]!, groupName);
    } else if (!pooled) family = modelFamily(id, undefined, subfamilies);
    family ??= {
      key: `other-${id}`,
      label: groupName?.trim() || bucket.displayName?.trim() || id,
    };
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
    fold(windows, { family, period, usedPercent, resetsAtMs: untouched ? undefined : resetsAtMs });
  }
  return [...windows.values()];
}

/**
 * The windows in a `fetchAvailableModels` answer: each model's own quota,
 * folded per family. Older accounts report quotas this way only, without a
 * window length, so none is made up.
 */
export function antigravityModelWindows(answer: unknown): ReadonlyArray<QuotaWindow> {
  const decoded = decodeModels(answer);
  if (decoded._tag === "None") return [];
  const subfamilies = new Set(KNOWN_GEMINI_SUBFAMILIES);
  const windows = new Map<string, QuotaWindow>();
  for (const [modelId, model] of Object.entries(decoded.value.models)) {
    if (model.isInternal) continue;
    const family = modelFamily(modelId, model.modelProvider, subfamilies);
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
  return [...windows.values()];
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
  family.key === "gemini"
    ? 0
    : family.key.startsWith("gemini-")
      ? 1
      : family === SHARED_3P || family.key === "claude" || family.key === "gpt"
        ? 2
        : 3;
const PERIOD_ORDER: Record<Period, number> = { "5h": 0, weekly: 1, quota: 2 };

/**
 * A reading as the snapshot carries it: every window is one family's own
 * (`scoped`), since a spent family never stops the others. The default Gemini
 * pool leaves out the sub-families that have their own.
 */
export function antigravityAccountUsage(
  windows: ReadonlyArray<QuotaWindow>,
  checkedAt: string,
): ServerProviderAccountUsage {
  const ownPools = [
    ...new Set(
      windows
        .filter((window) => window.family.key.startsWith("gemini-"))
        .flatMap((window) => window.family.models ?? []),
    ),
  ];
  const scoped = [...windows]
    .sort(
      (a, b) =>
        FAMILY_ORDER(a.family) - FAMILY_ORDER(b.family) ||
        a.family.label.localeCompare(b.family.label) ||
        PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period],
    )
    .map((window): ServerProviderScopedUsageWindow => {
      const usedPercent = Math.round(window.usedPercent);
      const minutes = PERIOD_MINUTES[window.period];
      return {
        scopeLabel: window.family.label,
        ...(window.family.models ? { scopeModels: window.family.models } : {}),
        ...(window.family.key === "gemini" && ownPools.length > 0
          ? { scopeExcludes: ownPools }
          : {}),
        usedPercent,
        remainingPercent: 100 - usedPercent,
        ...(window.resetsAtMs !== undefined ? { resetsAt: window.resetsAtMs } : {}),
        ...(minutes !== undefined ? { windowDurationMins: minutes } : {}),
        checkedAt,
      };
    });
  return {
    source: "antigravity-quota",
    checkedAt,
    primaryLimitId: "antigravity",
    limits: [{ limitId: "antigravity", scoped }],
  };
}

// ── Requests ─────────────────────────────────────────────────────────

/** Why a request failed, in words that never carry the token. */
class UsageRequestError extends Schema.TaggedError<UsageRequestError>()(
  "AntigravityUsageRequestError",
  { reason: Schema.String },
) {}

const requestJson = (
  fetch: DownloadFetch,
  url: string,
  init: { method: "GET" | "POST"; accessToken: string; body?: string },
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${init.accessToken}`,
          "User-Agent": ANTIGRAVITY_USAGE_USER_AGENT,
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
      return JSON.parse(text) as unknown;
    },
    // The cause can quote the request; only the host is kept.
    catch: () => new UsageRequestError({ reason: `${new URL(url).host} did not answer` }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(new UsageRequestError({ reason: `${new URL(url).host} timed out` })),
    }),
  );

/** One operation on every host, in the method's host order; a host that fails adds nothing. */
const askHosts = (
  fetch: DownloadFetch,
  method: GoogleMethod,
  accessToken: string,
  operation: "retrieveUserQuotaSummary" | "fetchAvailableModels",
  parse: (answer: unknown, requestedAtMs: number) => ReadonlyArray<QuotaWindow>,
) =>
  Effect.forEach(
    HOSTS_BY_METHOD[method],
    (host) =>
      Effect.gen(function* () {
        const requestedAtMs = yield* Clock.currentTimeMillis;
        const answer = yield* requestJson(fetch, `https://${host}/v1internal:${operation}`, {
          method: "POST",
          accessToken,
          body: "{}",
        });
        return { answered: true, windows: parse(answer, requestedAtMs) };
      }).pipe(Effect.orElseSucceed(() => ({ answered: false, windows: [] as const }))),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((answers) => ({
      answered: answers.some((answer) => answer.answered),
      windows: mergeHosts(answers.map((answer) => answer.windows)),
    })),
  );

/**
 * One full read. The summary comes first; when it has no Gemini row (Google
 * leaves it out for some clients) the per-model quotas fill in Gemini, and
 * when it has nothing they stand in for all of it.
 */
const readQuotaWindows = (fetch: DownloadFetch, method: GoogleMethod, accessToken: string) =>
  Effect.gen(function* () {
    const summary = yield* askHosts(
      fetch,
      method,
      accessToken,
      "retrieveUserQuotaSummary",
      antigravitySummaryWindows,
    );
    const hasGemini = summary.windows.some((window) => window.family.key.startsWith("gemini"));
    if (hasGemini) return summary.windows;
    const models = yield* askHosts(
      fetch,
      method,
      accessToken,
      "fetchAvailableModels",
      antigravityModelWindows,
    );
    if (summary.windows.length === 0) return models.windows;
    return [
      ...summary.windows,
      ...models.windows.filter((window) => window.family.key.startsWith("gemini")),
    ];
  });

const readEmail = (fetch: DownloadFetch, accessToken: string) =>
  requestJson(fetch, USERINFO_URL, { method: "GET", accessToken }).pipe(
    Effect.map((answer) => {
      const decoded = decodeUserInfo(answer);
      return decoded._tag === "Some" ? cleanEmail(decoded.value.email) : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

// ── The reader ───────────────────────────────────────────────────────

export const ANTIGRAVITY_USAGE_EXPIRED_DETAIL =
  "Start a chat to refresh these limits. Antigravity renews its Google sign-in only while it runs.";
export const ANTIGRAVITY_USAGE_FAILED_DETAIL =
  "Couldn't read Antigravity limits. Trying again soon.";

/** What a status check shows of the plan: the reading, the email, and what to say about either. */
export interface AntigravityUsageStatus {
  readonly accountUsage?: ServerProviderAccountUsage;
  readonly email?: string;
  /** Set when there is something to say: an expired token, or a failed read. */
  readonly usage?: ServerProviderAuthCapability;
}

export interface AntigravityUsageReader {
  /**
   * The last reading for the sign-in on disk, never waiting on Google: it
   * reads only the token file, and starts a read in the background when one
   * is due. Empty for a method that isn't a Google sign-in, or when signed out.
   */
  readonly status: Effect.Effect<AntigravityUsageStatus>;
  /** Cancels a read in flight and forgets every reading: for sign-in and sign-out. */
  readonly reset: Effect.Effect<void>;
  /** Where a finished read publishes, once the instance's snapshot exists. */
  readonly publishTo: (
    patch: (update: (current: ServerProvider) => ServerProvider | null) => Effect.Effect<void>,
  ) => void;
  /** The limit the last reading says `modelName` is stopped on, for Continue at reset. */
  readonly usageLimitFor: (modelName: string) => Effect.Effect<RuntimeUsageLimit | undefined>;
}

export interface AntigravityUsageReaderInput {
  readonly profileDir: string;
  readonly method: AntigravityAuthMethod;
  /** `antigravityCredentialFingerprint` of the instance's sign-in. */
  readonly fingerprint: string;
  /** Test seam; by default a fetch held to `ANTIGRAVITY_USAGE_HOSTS` with no redirects. */
  readonly fetch?: DownloadFetch;
}

interface Reading {
  readonly key: string;
  readonly accountUsage: ServerProviderAccountUsage;
}

export const makeAntigravityUsageReader = (
  input: AntigravityUsageReaderInput,
): Effect.Effect<AntigravityUsageReader, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fetch =
      input.fetch ?? makeHttpsFetch({ allowedHosts: ANTIGRAVITY_USAGE_HOSTS, maxRedirects: 0 });
    const inFlight = yield* FiberHandle.make<void, never>();
    let reading: Reading | undefined;
    let emails = new Map<string, string>();
    /** The key, time and outcome of the last read started. */
    let lastAttempt: { key: string; atMs: number; failed: boolean } | undefined;
    /** Bumped by `reset`: a read started before it doesn't land. */
    let generation = 0;
    let publish:
      | ((update: (current: ServerProvider) => ServerProvider | null) => Effect.Effect<void>)
      | undefined;

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
        ...(kept ? { accountUsage: kept } : {}),
        ...(email ? { email } : {}),
        ...(usage ? { usage } : {}),
      };
    };

    const publishStatus = (status: AntigravityUsageStatus) =>
      publish
        ? publish((current) => {
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

    const read = (token: SavedToken, key: string, method: GoogleMethod) =>
      Effect.gen(function* () {
        const started = generation;
        const windows = yield* readQuotaWindows(fetch, method, token.accessToken);
        const email =
          token.email ?? emails.get(key) ?? (yield* readEmail(fetch, token.accessToken));
        // Signed in or out meanwhile, or another account's sign-in is on disk now.
        const current = yield* readSavedToken(input.profileDir);
        if (generation !== started || current === undefined || keyOf(current) !== key) return;
        const nowMs = yield* Clock.currentTimeMillis;
        if (windows.length > 0) {
          reading = {
            key,
            accountUsage: antigravityAccountUsage(windows, new Date(nowMs).toISOString()),
          };
        }
        if (email) emails.set(key, email);
        lastAttempt = { key, atMs: lastAttempt?.atMs ?? nowMs, failed: windows.length === 0 };
        yield* publishStatus(statusFor(token, key, nowMs));
      }).pipe(
        Effect.timeoutOrElse({
          duration: READ_TIMEOUT,
          orElse: () =>
            Effect.gen(function* () {
              if (lastAttempt?.key === key) lastAttempt = { ...lastAttempt, failed: true };
              yield* publishStatus(statusFor(token, key, yield* Clock.currentTimeMillis));
            }),
        }),
        // Nothing a read does may fail the instance.
        Effect.catchCause(() => Effect.void),
      );

    const status = Effect.gen(function* () {
      if (!isGoogleMethod(input.method)) return {};
      const token = yield* readSavedToken(input.profileDir);
      if (token === undefined) {
        // Signed out: whatever is kept belongs to a sign-in that's gone.
        reading = undefined;
        return {};
      }
      const key = keyOf(token);
      if (reading !== undefined && reading.key !== key) reading = undefined;
      const nowMs = yield* Clock.currentTimeMillis;
      const expired =
        token.expiresAtMs === undefined || token.expiresAtMs <= nowMs + EXPIRY_MARGIN_MS;
      const due =
        lastAttempt === undefined ||
        lastAttempt.key !== key ||
        nowMs - lastAttempt.atMs >= MIN_READ_INTERVAL_MS;
      if (!expired && due) {
        lastAttempt = {
          key,
          atMs: nowMs,
          failed: lastAttempt?.key === key ? lastAttempt.failed : false,
        };
        yield* FiberHandle.run(inFlight, read(token, key, input.method), { onlyIfMissing: true });
      }
      return statusFor(token, key, nowMs);
    }).pipe(Effect.catchCause(() => Effect.succeed({})));

    return {
      status,
      reset: Effect.gen(function* () {
        generation += 1;
        yield* FiberHandle.clear(inFlight);
        reading = undefined;
        emails = new Map();
        lastAttempt = undefined;
      }),
      publishTo: (patch) => {
        publish = patch;
      },
      usageLimitFor: (modelName) =>
        Effect.gen(function* () {
          if (!isGoogleMethod(input.method)) return undefined;
          const token = yield* readSavedToken(input.profileDir);
          if (token === undefined || reading?.key !== keyOf(token)) return undefined;
          return usageLimitForModel(
            reading.accountUsage,
            modelName,
            yield* Clock.currentTimeMillis,
          );
        }),
    } satisfies AntigravityUsageReader;
  });

/**
 * A snapshot (or status) with a usage status folded in: the reading, the
 * email, and the line about it. A status without a reading keeps the one
 * already there, which is the last good one.
 */
export function withAntigravityUsage<
  T extends {
    readonly auth: ServerProviderAuth;
    readonly accountUsage?: ServerProviderAccountUsage | undefined;
  },
>(target: T, status: AntigravityUsageStatus): T {
  const { capabilities, ...auth } = target.auth;
  const { usage: _previous, ...others } = capabilities ?? {};
  const nextCapabilities = { ...others, ...(status.usage ? { usage: status.usage } : {}) };
  return {
    ...target,
    auth: {
      ...auth,
      ...(status.email ? { email: status.email } : {}),
      ...(Object.keys(nextCapabilities).length > 0 ? { capabilities: nextCapabilities } : {}),
    },
    ...(status.accountUsage ? { accountUsage: status.accountUsage } : {}),
  };
}
