/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * Every `costUsd` here is an API list-price equivalent, not billed spend.
 *
 * @module usageMerge
 */
import type {
  EnvironmentId,
  UsageBucket,
  UsageDay,
  UsageHourBucket,
  UsageProviderKind,
  UsageSourceFingerprint,
  UsageSummary,
} from "@threadlines/contracts";

/**
 * Narrows a scanned summary to a shorter day range.
 *
 * The page scans once for the longest window it offers and derives the 7- and
 * 30-day views from that result, so switching windows is arithmetic rather than
 * another disk walk. Sources, pricing and freshness describe the scan itself and
 * pass through untouched: they do not become less true for a shorter window.
 */
export function filterSummaryWindow(
  summary: UsageSummary,
  sinceDay: UsageDay,
  untilDay: UsageDay,
): UsageSummary {
  return {
    ...summary,
    sinceDay,
    untilDay,
    // `YYYY-MM-DD` days with fixed width compare correctly as strings.
    buckets: summary.buckets.filter((bucket) => bucket.day >= sinceDay && bucket.day <= untilDay),
  };
}

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

/**
 * Tokens by kind, with the cost and responses that came with them. Every level
 * of the merge (the whole window, a provider, a model, a day, an hour) carries
 * the same tally, so the page can split any of them the same way.
 */
export interface UsageTally {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  /** A subset of `outputTokens`, never added on top. */
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly records: number;
}

/** A tally that knows which model it belongs to. */
export interface ModelTally extends UsageTally {
  readonly provider: UsageProviderKind;
  readonly model: string;
}

export interface ProviderTotals extends UsageTally {
  readonly provider: UsageProviderKind;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals extends ModelTally {
  /** Identity across the merge: the key into {@link PeriodTotals.byModel}. */
  readonly key: string;
  readonly costShare: number;
  readonly tokenShare: number;
}

/** One day's or one hour's usage, split the same ways the whole window is. */
export interface PeriodTotals extends UsageTally {
  readonly byProvider: ReadonlyMap<UsageProviderKind, UsageTally>;
  /** Keyed by {@link ModelTotals.key}. */
  readonly byModel: ReadonlyMap<string, ModelTally>;
}

export interface DailyTotals extends PeriodTotals {
  readonly day: string;
}

export interface HourlyTotals extends PeriodTotals {
  /** Start of the hour, epoch milliseconds. */
  readonly hourStartMs: number;
}

/** A run of periods added up: the totals, and who used them, heaviest first. */
export interface UsageBreakdown extends UsageTally {
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

export interface MergedUsage extends UsageBreakdown {
  readonly sessions: number;
  readonly daily: readonly DailyTotals[];
  /** The trailing hours, oldest first; only the hours that had usage. */
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly staleEnvironments: readonly EnvironmentId[];
  /**
   * Environments whose server predates hourly usage. Their days count; their
   * hours are missing, and the hourly view must say so rather than show zero.
   */
  readonly hourlyMissingEnvironments: readonly EnvironmentId[];
  /** Oldest `lastScannedAt` across contributing sources, or `null` when none. */
  readonly oldestScanAt: string | null;
}

/**
 * Two sources are the same physical transcript directory only when host,
 * provider, path and filesystem identity all agree.
 *
 * `volumeId` is what stops two machines that happen to share a hostname and a
 * home path, which is every Mac with the default computer name, from collapsing
 * into one source and having one of them silently dropped.
 */
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token. The
 * first environment in a stable order claims a fingerprint; the rest have that
 * provider's buckets dropped. Environments are sorted by id so the winner does
 * not change between renders.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly duplicates: readonly string[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort((a, b) => a.environmentId.localeCompare(b.environmentId));

  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status === "missing") continue;
      const key = fingerprintKey(source.fingerprint);
      if (ownerByFingerprint.has(key)) {
        duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
        continue;
      }
      ownerByFingerprint.set(key, environment.environmentId);
    }
  }

  return { ownerByFingerprint, duplicates };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
): {
  readonly ownsSources: boolean;
  readonly buckets: readonly UsageBucket[];
  /** `null` when the environment's server does not report hours at all. */
  readonly hourlyBuckets: readonly UsageHourBucket[] | null;
  readonly sessions: number;
  readonly oldestScanAt: string | null;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  let sessions = 0;
  let oldestScanAt: string | null = null;
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = fingerprintKey(source.fingerprint);
    if (ownerByFingerprint.get(key) !== environment.environmentId) continue;
    ownedProviders.add(source.fingerprint.provider);
    // Distinct within a directory. Summing per-bucket session counts instead
    // would count a session once per day and model it spans.
    sessions += source.distinctSessions;
    // ISO instants with the same precision sort lexicographically.
    if (oldestScanAt === null || source.lastScannedAt < oldestScanAt) {
      oldestScanAt = source.lastScannedAt;
    }
  }
  const hourlyBuckets = environment.summary.hourlyBuckets;
  return {
    ownsSources: ownedProviders.size > 0,
    buckets: environment.summary.buckets.filter((bucket) => ownedProviders.has(bucket.provider)),
    hourlyBuckets:
      hourlyBuckets === undefined
        ? null
        : hourlyBuckets.filter((bucket) => ownedProviders.has(bucket.provider)),
    sessions,
    oldestScanAt,
  };
}

type Mutable<Shape> = { -readonly [Field in keyof Shape]: Shape[Field] };

function emptyTally(): Mutable<UsageTally> {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    records: 0,
  };
}

function addTally(target: Mutable<UsageTally>, source: UsageTally): void {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.totalTokens += source.totalTokens;
  target.costUsd += source.costUsd;
  target.records += source.records;
}

/** What day and hour buckets have in common: one model's tokens, cost and responses. */
type TalliedBucket = Pick<UsageBucket, "provider" | "model" | "totals" | "costUsd" | "records">;

function bucketTally(bucket: TalliedBucket): UsageTally {
  return {
    ...bucket.totals,
    // reasoningTokens is a subset of outputTokens and must not be added again.
    totalTokens:
      bucket.totals.uncachedInputTokens +
      bucket.totals.cachedInputTokens +
      bucket.totals.cacheCreationTokens +
      bucket.totals.outputTokens,
    costUsd: bucket.costUsd,
    records: bucket.records,
  };
}

function tallyIn<Key>(map: Map<Key, Mutable<UsageTally>>, key: Key): Mutable<UsageTally> {
  let tally = map.get(key);
  if (tally === undefined) {
    tally = emptyTally();
    map.set(key, tally);
  }
  return tally;
}

function modelTallyIn(
  map: Map<string, Mutable<ModelTally>>,
  key: string,
  identity: { readonly provider: UsageProviderKind; readonly model: string },
): Mutable<ModelTally> {
  let tally = map.get(key);
  if (tally === undefined) {
    tally = { ...emptyTally(), provider: identity.provider, model: identity.model };
    map.set(key, tally);
  }
  return tally;
}

/** One model's identity. Model names are only unique within a provider. */
function modelKey(provider: UsageProviderKind, model: string): string {
  return `${provider} ${model}`;
}

interface MutablePeriod extends Mutable<UsageTally> {
  readonly byProvider: Map<UsageProviderKind, Mutable<UsageTally>>;
  readonly byModel: Map<string, Mutable<ModelTally>>;
}

function addToPeriod<Key>(
  periods: Map<Key, MutablePeriod>,
  periodKey: Key,
  bucket: TalliedBucket,
): void {
  let period = periods.get(periodKey);
  if (period === undefined) {
    period = { ...emptyTally(), byProvider: new Map(), byModel: new Map() };
    periods.set(periodKey, period);
  }
  const tally = bucketTally(bucket);
  addTally(period, tally);
  addTally(tallyIn(period.byProvider, bucket.provider), tally);
  addTally(modelTallyIn(period.byModel, modelKey(bucket.provider, bucket.model), bucket), tally);
}

/**
 * Adds up a run of days or hours into totals plus a provider and model split.
 * The whole window and the last 24 hours both come through here, so they rank
 * and share identically.
 */
export function sumUsagePeriods(periods: Iterable<PeriodTotals>): UsageBreakdown {
  const total = emptyTally();
  const providers = new Map<UsageProviderKind, Mutable<UsageTally>>();
  const models = new Map<string, Mutable<ModelTally>>();
  for (const period of periods) {
    addTally(total, period);
    for (const [provider, tally] of period.byProvider)
      addTally(tallyIn(providers, provider), tally);
    for (const [key, tally] of period.byModel) addTally(modelTallyIn(models, key, tally), tally);
  }

  const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
  // Token-first: the heaviest provider and model lead, cost breaks ties.
  return {
    ...total,
    providers: [...providers.entries()]
      .map(([provider, tally]) => ({
        ...tally,
        provider,
        costShare: share(tally.costUsd, total.costUsd),
        tokenShare: share(tally.totalTokens, total.totalTokens),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd),
    models: [...models.entries()]
      .map(([key, tally]) => ({
        ...tally,
        key,
        costShare: share(tally.costUsd, total.costUsd),
        tokenShare: share(tally.totalTokens, total.totalTokens),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd),
  };
}

const EMPTY_MERGED: MergedUsage = {
  ...sumUsagePeriods([]),
  sessions: 0,
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  duplicateSources: [],
  contributingEnvironments: [],
  staleEnvironments: [],
  hourlyMissingEnvironments: [],
  oldestScanAt: null,
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against an environment running older server
 * code: rather than blocking the page, its data is excluded and its id is
 * reported so the UI can say coverage is partial.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const staleEnvironments: EnvironmentId[] = [];
  for (const environment of environments) {
    if (environment.summary.contractVersion === expectedContractVersion) {
      current.push(environment);
    } else {
      staleEnvironments.push(environment.environmentId);
    }
  }

  const { ownerByFingerprint, duplicates } = claimSources(current);

  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  let oldestScanAt: string | null = null;
  const dailyAccumulator = new Map<string, MutablePeriod>();
  const hourlyAccumulator = new Map<number, MutablePeriod>();
  const contributingEnvironments: EnvironmentId[] = [];
  const hourlyMissingEnvironments: EnvironmentId[] = [];

  for (const environment of current) {
    const contribution = ownedContribution(environment, ownerByFingerprint);
    if (contribution.buckets.length > 0) contributingEnvironments.push(environment.environmentId);
    if (contribution.ownsSources && contribution.hourlyBuckets === null) {
      hourlyMissingEnvironments.push(environment.environmentId);
    }
    sessions += contribution.sessions;
    if (
      contribution.oldestScanAt !== null &&
      (oldestScanAt === null || contribution.oldestScanAt < oldestScanAt)
    ) {
      oldestScanAt = contribution.oldestScanAt;
    }

    for (const bucket of contribution.buckets) {
      addToPeriod(dailyAccumulator, bucket.day, bucket);
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;
    }
    for (const bucket of contribution.hourlyBuckets ?? []) {
      addToPeriod(hourlyAccumulator, bucket.hourStartMs, bucket);
    }
  }

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, period]) => ({ ...period, day }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const hourly: HourlyTotals[] = [...hourlyAccumulator.entries()]
    .map(([hourStartMs, period]) => ({ ...period, hourStartMs }))
    .sort((a, b) => a.hourStartMs - b.hourStartMs);
  const breakdown = sumUsagePeriods(daily);
  const records = breakdown.records;

  return {
    ...breakdown,
    sessions,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    staleEnvironments,
    hourlyMissingEnvironments,
    oldestScanAt,
  };
}
