/**
 * Local Claude token history for the provider settings heatmap.
 *
 * Claude's OAuth usage endpoint only reports rolling subscription windows. Its
 * calendar history lives on the paired computer instead: Claude Code maintains
 * `stats-cache.json`, and the JSONL transcripts remain the source of truth when
 * that cache has not been generated yet. This reader imports both without
 * coupling the provider card to the all-environment `/usage` projection.
 *
 * The returned buckets are merged into the provider status cache by
 * `ProviderRegistry`, which turns the initial import into a rolling 366-day
 * Threadlines history across restarts.
 *
 * @module provider/Layers/ClaudeTokenUsageHistory
 */
import type {
  ClaudeSettings,
  ServerProviderAccountTokenUsage,
  ServerProviderAccountTokenUsageDailyBucket,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import {
  formatProviderTokenUsageDateKey,
  parseProviderTokenUsageDateKey,
  PROVIDER_TOKEN_USAGE_RETENTION_DAYS,
  retainProviderTokenUsageBuckets,
  shiftProviderTokenUsageDateKey,
  summarizeProviderTokenUsageBuckets,
} from "../providerTokenUsageHistory.ts";
import { UsageAggregator } from "../../usage/usageAggregation.ts";
import { dedupeWithinFile, type ScanCache } from "../../usage/usageScanCache.ts";
import { listTranscriptFiles, readTranscriptRecords } from "../../usage/usageTranscriptReader.ts";
import { totalTokens } from "../../usage/usageTranscripts.ts";

const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

interface ClaudeStatsTokenUsageHistory {
  readonly dailyBuckets: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
  readonly firstSessionDate?: string;
  readonly lastComputedDate?: string;
  readonly lifetimeTokens?: number;
}

interface TranscriptHistoryScan {
  readonly buckets: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
  readonly complete: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;

const normalizeDateKey = (value: unknown): string | undefined =>
  typeof value === "string" && parseProviderTokenUsageDateKey(value) !== null ? value : undefined;

const dateKeyFromUnknownInstant = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatProviderTokenUsageDateKey(ms) : undefined;
};

const sumTokenFields = (value: unknown): number | undefined => {
  if (!isRecord(value)) return undefined;
  const fields = [
    value["inputTokens"],
    value["outputTokens"],
    value["cacheReadInputTokens"],
    value["cacheCreationInputTokens"],
  ];
  if (!fields.some((field) => nonNegativeNumber(field) !== undefined)) return undefined;
  return fields.reduce<number>((sum, field) => sum + (nonNegativeNumber(field) ?? 0), 0);
};

/** Narrow Claude Code's deliberately undocumented, rebuildable stats cache. */
export function parseClaudeStatsTokenUsage(document: unknown): ClaudeStatsTokenUsageHistory | null {
  if (!isRecord(document) || !Array.isArray(document["dailyModelTokens"])) return null;

  const tokensByDay = new Map<string, number>();
  for (const entry of document["dailyModelTokens"]) {
    if (!isRecord(entry)) continue;
    const date = normalizeDateKey(entry["date"]);
    const tokensByModel = entry["tokensByModel"];
    if (!date || !isRecord(tokensByModel)) continue;
    const tokens = Object.values(tokensByModel).reduce<number>(
      (sum, value) => sum + (nonNegativeNumber(value) ?? 0),
      0,
    );
    tokensByDay.set(date, (tokensByDay.get(date) ?? 0) + tokens);
  }

  const modelUsage = document["modelUsage"];
  let lifetimeTokens: number | undefined;
  if (isRecord(modelUsage)) {
    const totals = Object.values(modelUsage)
      .map(sumTokenFields)
      .filter((value): value is number => value !== undefined);
    if (totals.length > 0) lifetimeTokens = totals.reduce((sum, value) => sum + value, 0);
  }

  return {
    dailyBuckets: [...tokensByDay.entries()]
      .map(([startDate, tokens]) => ({ startDate, tokens }))
      .toSorted((left, right) => left.startDate.localeCompare(right.startDate)),
    ...(dateKeyFromUnknownInstant(document["firstSessionDate"])
      ? { firstSessionDate: dateKeyFromUnknownInstant(document["firstSessionDate"]) }
      : {}),
    ...(normalizeDateKey(document["lastComputedDate"])
      ? { lastComputedDate: normalizeDateKey(document["lastComputedDate"]) }
      : {}),
    ...(lifetimeTokens !== undefined ? { lifetimeTokens } : {}),
  };
}

const sumBuckets = (buckets: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>): number =>
  buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);

const clampDateKey = (value: string, minimum: string, maximum: string): string =>
  value < minimum ? minimum : value > maximum ? maximum : value;

export const makeClaudeTokenUsageHistoryReader = Effect.fn("ClaudeTokenUsageHistory.makeReader")(
  function* (settings: Pick<ClaudeSettings, "homePath">) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedHomePath = yield* resolveClaudeHomePath(settings);
    const nestedDataDir = path.join(resolvedHomePath, ".claude");
    const nestedDataDirExists = yield* fileSystem
      .exists(nestedDataDir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    const dataDir = nestedDataDirExists ? nestedDataDir : resolvedHomePath;
    const statsCachePath = path.join(dataDir, "stats-cache.json");
    const transcriptDir = path.join(dataDir, "projects");
    const fileCache: ScanCache = new Map();

    const readStatsCache = Effect.gen(function* () {
      const raw = yield* fileSystem
        .readFileString(statsCachePath)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (raw === null) return null;
      try {
        return parseClaudeStatsTokenUsage(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    });

    const scanTranscripts = (
      sinceDay: string,
      untilDay: string,
    ): Effect.Effect<TranscriptHistoryScan> =>
      Effect.promise(async () => {
        const sinceMs = parseProviderTokenUsageDateKey(sinceDay);
        if (sinceMs === null) return { buckets: [], complete: false };
        const files = await listTranscriptFiles(transcriptDir, sinceMs - MTIME_SLACK_MS);
        const livePaths = new Set(files.map((file) => file.path));
        const aggregator = new UsageAggregator({
          timeZone: "UTC",
          sinceDay,
          untilDay,
          rates: new Map(),
        });
        let complete = true;

        for (const file of files) {
          const cached = fileCache.get(file.path);
          let records =
            cached?.provider === "claude" &&
            cached.size === file.size &&
            cached.mtimeMs === file.mtimeMs
              ? cached.records
              : undefined;
          if (!records) {
            const parsed = await readTranscriptRecords(file.path, "claude");
            if (parsed === null) {
              complete = false;
              continue;
            }
            records = dedupeWithinFile(parsed);
            fileCache.set(file.path, {
              provider: "claude",
              size: file.size,
              mtimeMs: file.mtimeMs,
              records,
            });
          }
          for (const record of records) aggregator.add(record);
        }

        for (const cachedPath of fileCache.keys()) {
          if (!livePaths.has(cachedPath)) fileCache.delete(cachedPath);
        }

        const tokensByDay = new Map<string, number>();
        for (const bucket of aggregator.finish().buckets) {
          tokensByDay.set(
            bucket.day,
            (tokensByDay.get(bucket.day) ?? 0) + totalTokens(bucket.totals),
          );
        }
        return {
          complete,
          buckets: [...tokensByDay.entries()]
            .map(([startDate, tokens]) => ({ startDate, tokens }))
            .toSorted((left, right) => left.startDate.localeCompare(right.startDate)),
        };
      });

    return Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const today = checkedAt.slice(0, 10);
      const firstRetainedDate = shiftProviderTokenUsageDateKey(
        today,
        -(PROVIDER_TOKEN_USAGE_RETENTION_DAYS - 1),
      );
      if (!firstRetainedDate) return undefined;

      const stats = yield* readStatsCache;
      const transcriptDirExists = yield* fileSystem
        .exists(transcriptDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!stats && !transcriptDirExists) return undefined;

      const scanStartDate = clampDateKey(
        stats?.lastComputedDate ?? firstRetainedDate,
        firstRetainedDate,
        today,
      );
      const scan = transcriptDirExists
        ? yield* scanTranscripts(scanStartDate, today).pipe(
            Effect.catchCause(() => Effect.succeed({ buckets: [], complete: false })),
          )
        : { buckets: [], complete: false };
      if (!stats && !scan.complete) return undefined;

      const allBucketsByDay = new Map(
        (stats?.dailyBuckets ?? []).map((bucket) => [bucket.startDate, bucket] as const),
      );
      if (scan.complete) {
        for (const date of allBucketsByDay.keys()) {
          if (date >= scanStartDate) allBucketsByDay.delete(date);
        }
        for (const bucket of scan.buckets) allBucketsByDay.set(bucket.startDate, bucket);
      }
      const allBuckets = [...allBucketsByDay.values()].toSorted((left, right) =>
        left.startDate.localeCompare(right.startDate),
      );
      const retainedBuckets = retainProviderTokenUsageBuckets(allBuckets, today);

      const statsReplacedTokens = sumBuckets(
        (stats?.dailyBuckets ?? []).filter((bucket) => bucket.startDate >= scanStartDate),
      );
      const lifetimeTokens =
        stats?.lifetimeTokens !== undefined
          ? Math.max(0, stats.lifetimeTokens - statsReplacedTokens) +
            (scan.complete ? sumBuckets(scan.buckets) : statsReplacedTokens)
          : sumBuckets(allBuckets);
      const coverageStartDate = scan.complete
        ? firstRetainedDate
        : stats?.firstSessionDate
          ? clampDateKey(stats.firstSessionDate, firstRetainedDate, today)
          : retainedBuckets[0]?.startDate;
      const coverageEndDate = scan.complete
        ? today
        : stats?.lastComputedDate
          ? clampDateKey(stats.lastComputedDate, firstRetainedDate, today)
          : undefined;
      const completeLifetimeHistory = Boolean(
        stats?.firstSessionDate &&
        stats.firstSessionDate >= firstRetainedDate &&
        coverageEndDate === today,
      );

      return {
        checkedAt,
        scope: "local",
        ...(coverageStartDate ? { coverageStartDate } : {}),
        ...(coverageEndDate ? { coverageEndDate } : {}),
        completeLifetimeHistory,
        dailyBuckets: retainedBuckets,
        summary: summarizeProviderTokenUsageBuckets({
          buckets: allBuckets,
          anchorDateKey: today,
          lifetimeTokens,
        }),
      } satisfies ServerProviderAccountTokenUsage;
    });
  },
);
