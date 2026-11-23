/**
 * Local Claude token history for the provider settings heatmap.
 *
 * Claude's OAuth usage endpoint only reports rolling subscription windows. Its
 * calendar history lives on the paired computer instead: Claude Code maintains
 * `stats-cache.json`, and the JSONL transcripts remain the source of truth when
 * that cache has not been generated yet. This reader imports both without
 * coupling the provider card to the all-environment `/usage` projection.
 *
 * Claude Code deletes transcripts `cleanupPeriodDays` after they were last
 * written, so every read is folded into a saved history in the server's state
 * folder (`providerTokenUsageStore`). Days whose files are gone keep their
 * totals there, which turns the import into a rolling 366-day history.
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

import { resolveClaudeConfigDir, resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import {
  formatProviderTokenUsageDateKey,
  parseProviderTokenUsageDateKey,
  PROVIDER_TOKEN_USAGE_RETENTION_DAYS,
  retainProviderTokenUsageBuckets,
  shiftProviderTokenUsageDateKey,
  summarizeProviderTokenUsageBuckets,
} from "../providerTokenUsageHistory.ts";
import { makeProviderTokenUsageStore, mergeTokenUsageDays } from "../providerTokenUsageStore.ts";
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
  const firstSessionDate = dateKeyFromUnknownInstant(document["firstSessionDate"]);
  const lastComputedDate = normalizeDateKey(document["lastComputedDate"]);

  return {
    dailyBuckets: [...tokensByDay.entries()]
      .map(([startDate, tokens]) => ({ startDate, tokens }))
      .toSorted((left, right) => left.startDate.localeCompare(right.startDate)),
    ...(firstSessionDate ? { firstSessionDate } : {}),
    ...(lastComputedDate ? { lastComputedDate } : {}),
    ...(lifetimeTokens !== undefined ? { lifetimeTokens } : {}),
  };
}

const clampDateKey = (value: string, minimum: string, maximum: string): string =>
  value < minimum ? minimum : value > maximum ? maximum : value;

export const makeClaudeTokenUsageHistoryReader = Effect.fn("ClaudeTokenUsageHistory.makeReader")(
  function* (
    settings: Pick<ClaudeSettings, "homePath" | "accountFolder">,
    environment: NodeJS.ProcessEnv = process.env,
    options: {
      /** The server's state folder, where the saved history lives. Without it nothing is saved. */
      readonly stateDir?: string;
    } = {},
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedHomePath = yield* resolveClaudeHomePath(settings);
    const configDir = yield* resolveClaudeConfigDir(settings, environment);
    const configDirExists = yield* fileSystem
      .exists(configDir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    // A `homePath` that already names a `.claude` folder is read as-is.
    const dataDir = configDirExists ? configDir : resolvedHomePath;
    const statsCachePath = path.join(dataDir, "stats-cache.json");
    const transcriptDir = path.join(dataDir, "projects");
    const fileCache: ScanCache = new Map();
    const store = options.stateDir
      ? yield* makeProviderTokenUsageStore({
          stateDir: options.stateDir,
          provider: "claude",
          source: dataDir,
        })
      : undefined;

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
            const parsed = await readTranscriptRecords(file.path, "claude", file.mtimeMs);
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
      if (!stats && !transcriptDirExists && !store) return undefined;

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

      // A day takes the larger of the stats cache and the transcripts. The
      // cache's last day may have been computed mid-day, and a transcript it
      // counted may be deleted since; a partial scan is still a lower bound.
      const statsTokensByDay = new Map(
        (stats?.dailyBuckets ?? []).map((bucket) => [bucket.startDate, bucket.tokens] as const),
      );
      const observedBuckets = [
        ...mergeTokenUsageDays([
          statsTokensByDay,
          scan.buckets.map((bucket) => [bucket.startDate, bucket.tokens] as const),
        ]),
      ]
        .map(([startDate, tokens]) => ({ startDate, tokens }))
        .toSorted((left, right) => left.startDate.localeCompare(right.startDate));
      const allBuckets = store ? yield* store.remember(observedBuckets, today) : observedBuckets;
      if (!stats && !scan.complete && (!store || allBuckets.length === 0)) return undefined;
      const retainedBuckets = retainProviderTokenUsageBuckets(allBuckets, today);

      // Claude's own total, plus what the calendar knows beyond its daily
      // figures. Each day only grows, so the total never goes down when a
      // transcript is deleted.
      const lifetimeTokens =
        (stats?.lifetimeTokens ?? 0) +
        allBuckets.reduce(
          (sum, bucket) =>
            sum + Math.max(0, bucket.tokens - (statsTokensByDay.get(bucket.startDate) ?? 0)),
          0,
        );
      const lastBucketDate = retainedBuckets.at(-1)?.startDate;
      const statsEndDate = stats?.lastComputedDate
        ? clampDateKey(stats.lastComputedDate, firstRetainedDate, today)
        : undefined;
      const coverageStartDate = scan.complete
        ? firstRetainedDate
        : stats?.firstSessionDate
          ? clampDateKey(stats.firstSessionDate, firstRetainedDate, today)
          : retainedBuckets[0]?.startDate;
      const coverageEndDate = scan.complete
        ? today
        : statsEndDate && lastBucketDate
          ? statsEndDate > lastBucketDate
            ? statsEndDate
            : lastBucketDate
          : (statsEndDate ?? lastBucketDate);
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
