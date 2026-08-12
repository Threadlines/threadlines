import type {
  ServerProviderAccountTokenUsageDailyBucket,
  ServerProviderAccountTokenUsageSummary,
} from "@threadlines/contracts";

const DAY_MS = 86_400_000;

export const PROVIDER_TOKEN_USAGE_RETENTION_DAYS = 366;

export const parseProviderTokenUsageDateKey = (dateKey: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateKey);
  if (!match) return null;

  const [, year, month, day] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(ms).toISOString().slice(0, 10) === dateKey ? ms : null;
};

export const formatProviderTokenUsageDateKey = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

export const dateKeyFromIsoDateTime = (value: string): string | undefined => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatProviderTokenUsageDateKey(ms) : undefined;
};

export const shiftProviderTokenUsageDateKey = (
  dateKey: string,
  dayOffset: number,
): string | undefined => {
  const ms = parseProviderTokenUsageDateKey(dateKey);
  return ms === null
    ? undefined
    : formatProviderTokenUsageDateKey(ms + Math.trunc(dayOffset) * DAY_MS);
};

/**
 * Keep a calendar-year window of sparse daily usage buckets. Codex omits
 * inactive dates, so limiting by bucket count makes old active days disappear
 * whenever a new active day is reported.
 */
export const retainProviderTokenUsageBuckets = (
  buckets: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>,
  anchorDateKey?: string,
): ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket> => {
  const validBuckets = buckets
    .map((bucket) => {
      const ms = parseProviderTokenUsageDateKey(bucket.startDate);
      return ms === null ? undefined : { bucket, ms };
    })
    .filter(
      (
        entry,
      ): entry is {
        readonly bucket: ServerProviderAccountTokenUsageDailyBucket;
        readonly ms: number;
      } => entry !== undefined,
    );
  if (validBuckets.length === 0) return [];

  const parsedAnchorMs = anchorDateKey ? parseProviderTokenUsageDateKey(anchorDateKey) : null;
  const anchorMs = parsedAnchorMs ?? Math.max(...validBuckets.map((entry) => entry.ms));
  const firstRetainedMs = anchorMs - (PROVIDER_TOKEN_USAGE_RETENTION_DAYS - 1) * DAY_MS;
  const byDate = new Map<string, ServerProviderAccountTokenUsageDailyBucket>();

  for (const { bucket, ms } of validBuckets) {
    if (ms < firstRetainedMs || ms > anchorMs) continue;
    byDate.set(bucket.startDate, bucket);
  }

  return [...byDate.values()].toSorted((left, right) =>
    left.startDate.localeCompare(right.startDate),
  );
};

export const mergeProviderTokenUsageBuckets = (input: {
  readonly previous: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
  readonly next: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
  readonly anchorDateKey: string;
}): ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket> =>
  retainProviderTokenUsageBuckets([...input.previous, ...input.next], input.anchorDateKey);

export const summarizeProviderTokenUsageBuckets = (input: {
  readonly buckets: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
  readonly anchorDateKey: string;
  readonly lifetimeTokens?: number;
  readonly longestRunningTurnSec?: number;
}): ServerProviderAccountTokenUsageSummary => {
  const activeDays = input.buckets
    .filter((bucket) => bucket.tokens > 0)
    .map((bucket) => parseProviderTokenUsageDateKey(bucket.startDate))
    .filter((ms): ms is number => ms !== null)
    .toSorted((left, right) => left - right);
  const activeDaySet = new Set(activeDays);
  let longestStreakDays = 0;
  let runningStreakDays = 0;
  let previousMs: number | undefined;
  for (const ms of activeDays) {
    runningStreakDays =
      previousMs !== undefined && ms - previousMs === DAY_MS ? runningStreakDays + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, runningStreakDays);
    previousMs = ms;
  }

  const anchorMs = parseProviderTokenUsageDateKey(input.anchorDateKey);
  let currentStreakDays = 0;
  if (anchorMs !== null) {
    let cursorMs = activeDaySet.has(anchorMs) ? anchorMs : anchorMs - DAY_MS;
    while (activeDaySet.has(cursorMs)) {
      currentStreakDays += 1;
      cursorMs -= DAY_MS;
    }
  }

  const observedTokens = input.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const peakDailyTokens = Math.max(0, ...input.buckets.map((bucket) => bucket.tokens));
  return {
    lifetimeTokens: Math.max(0, Math.trunc(input.lifetimeTokens ?? observedTokens)),
    peakDailyTokens,
    ...(input.longestRunningTurnSec !== undefined && input.longestRunningTurnSec >= 0
      ? { longestRunningTurnSec: Math.trunc(input.longestRunningTurnSec) }
      : {}),
    ...(currentStreakDays > 0 ? { currentStreakDays } : {}),
    ...(longestStreakDays > 0 ? { longestStreakDays } : {}),
  };
};
