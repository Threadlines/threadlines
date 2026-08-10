/**
 * Usage reporting contract.
 *
 * Each environment scans the provider CLIs' own on-disk session transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`) rather
 * than Threadlines' orchestration projections, so usage stays complete even for
 * turns that were driven by the CLI, an editor extension, or another tool
 * entirely. `ccusage` takes the same approach.
 *
 * Environments return pre-aggregated `(day, provider, model)` buckets. Raw
 * transcript records never cross the wire.
 *
 * Cost semantics: every `costUsd` in this module is the *API list-price
 * equivalent* of the tokens, not billed spend. Subscription plans bill on their
 * own terms and the transcripts carry no invoice, so a figure here answers
 * "what would this have cost on the API" and nothing else. UI copy must say so.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. A
 * client merging several environments renders partial coverage when one reports
 * an older version rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 1 as const;

export const UsageProviderKind = Schema.Literals(["claude", "codex"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

/**
 * Window lengths the UI offers. The scan cache retains 90 days, so a longer
 * window would cold-scan every time.
 */
export const USAGE_WINDOW_DAY_OPTIONS = [7, 30, 90] as const;

export const UsageWindowDays = Schema.Literals(USAGE_WINDOW_DAY_OPTIONS);
export type UsageWindowDays = typeof UsageWindowDays.Type;

/** Longest window the server will scan, in days. Matches the cache retention. */
export const USAGE_MAX_WINDOW_DAYS = 90 as const;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` — the transcript carried an explicit cost figure.
 * - `modelPriced` — we matched the model against the LiteLLM rate table.
 * - `unpriced` — tokens are known, rates are not. Counted in token totals,
 *   excluded from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/**
 * One `(day, provider, model)` cell.
 *
 * `costUsd` is the API list-price equivalent of these tokens, not money spent.
 * `unpricedRecords` counts records whose tokens are included in the token
 * totals but which contributed nothing to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  day: UsageDay,
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * Identifies the physical transcript directory a source read from.
 *
 * Two environments on one machine (worktree servers, for example) resolve the
 * same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 */
export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   *
   * Hostname and path alone are not enough: every Mac resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have one of them silently dropped. The
   * device/inode pair is stable for two servers reading the same directory and
   * effectively never collides across machines. Empty when it cannot be read.
   */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  /**
   * When this directory was last walked, as an ISO instant. Warm scans reuse
   * memoised per-file results, so this is the only honest freshness signal the
   * client has for a source.
   */
  lastScannedAt: Schema.String,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. A fixed offset would be wrong
   * for any window that crosses a DST boundary, and the viewer's machine is
   * often not the machine holding the transcripts.
   */
  timeZone: TrimmedNonEmptyString,
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket),
  sources: Schema.Array(UsageSource),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedErrorClass<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
