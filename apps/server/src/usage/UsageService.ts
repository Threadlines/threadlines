/**
 * UsageService - scans provider transcripts and returns priced daily usage.
 *
 * The scan reads the provider CLIs' own session files rather than Threadlines'
 * orchestration projections, so usage covers turns driven from the CLI, an
 * editor extension, or any other tool sharing the same provider home. This is
 * the approach `ccusage` takes. OpenCode keeps its sessions in a database
 * instead, and agents that keep nothing are read from the usage ledger
 * Threadlines writes for them (`usageLedger`).
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`; warm scans only reparse files that changed. A database is
 * queried for the window on every scan.
 *
 * Cost figures are API list-price equivalents, never billed spend. Subscription
 * plans bill on their own terms and the transcripts carry no invoice.
 *
 * @module UsageService
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import {
  OpenCodeSettings,
  USAGE_CONTRACT_VERSION,
  USAGE_LEGACY_PROVIDER_KINDS,
  USAGE_MAX_WINDOW_DAYS,
  USAGE_RECENT_HOURS,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  resolveClaudeHomePath,
  resolveClaudeMainConfigDir,
} from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { grokMainHome } from "../provider/grok/GrokAccountFolder.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { museHostEnvironment } from "../provider/muse/MuseLaunch.ts";
import { museSessionsDir } from "../provider/muse/MuseSettingsFile.ts";
import {
  OPENCODE_DATABASE_FILE_NAME,
  openCodeDatabaseLocation,
} from "../provider/opencode/OpenCodeDataPaths.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { piAgentDir } from "../provider/pi/PiBinary.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { hourStartOf, UsageAggregator } from "./usageAggregation.ts";
import { USAGE_LEDGER_PROVIDERS, usageLedgerDir } from "./usageLedger.ts";
import { readOpenCodeUsage } from "./usageOpenCode.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_FETCH_TIMEOUT_MS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = USAGE_MAX_WINDOW_DAYS;

const decodeOpenCodeSettings = Schema.decodeUnknownOption(OpenCodeSettings);

/**
 * Where one provider keeps its usage: a folder of append-only transcripts,
 * cached per file, or a database queried for the window on every scan.
 */
type UsageScanSource =
  | {
      readonly kind: "files";
      readonly provider: UsageProviderKind;
      readonly dir: string;
      /** Only files with this name (Grok keeps usage in `updates.jsonl` beside other logs). */
      readonly fileName?: string;
    }
  | {
      readonly kind: "database";
      readonly provider: UsageProviderKind;
      readonly path: string;
      /** The records since `sinceMs`, or `null` when the database could not be read. */
      readonly read: (sinceMs: number) => readonly UsageRecord[] | null;
    };

interface RatesCacheFile {
  readonly fetchedAtMs: number;
  readonly document: unknown;
}

/** A cache file that is not JSON. */
class CacheFileParseError extends Data.TaggedError("CacheFileParseError")<{
  readonly cause: unknown;
}> {}

/**
 * Both on-disk caches hold documents that are narrowed by hand downstream
 * (`decodeScanCache`, `parseRateTable`), so a schema here would only restate
 * `unknown`. A parse failure means one cold scan, never a failed read.
 */
const parseJsonFile = (raw: string): Effect.Effect<unknown, CacheFileParseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new CacheFileParseError({ cause }),
  });

function readRatesCacheFile(document: unknown): RatesCacheFile | null {
  if (typeof document !== "object" || document === null) return null;
  const record = document as Partial<RatesCacheFile>;
  if (typeof record.fetchedAtMs !== "number" || !Number.isFinite(record.fetchedAtMs)) return null;
  return { fetchedAtMs: record.fetchedAtMs, document: record.document };
}

export interface UsageServiceShape {
  readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
}

export class UsageService extends Context.Service<UsageService, UsageServiceShape>()(
  "threadlines/usage/UsageService",
) {
  /** Empty summary, for suites that only need the RPC surface to resolve. */
  static readonly layerTest = Layer.succeed(
    UsageService,
    UsageService.of({
      readSummary: (input) =>
        Effect.succeed({
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "1970-01-01T00:00:00.000Z",
          timeZone: input.timeZone,
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          buckets: [],
          hourlyBuckets: [],
          sources: [],
          pricing: {
            status: "unavailable",
            source: LITELLM_RATES_URL,
            fetchedAt: null,
            knownModels: 0,
          },
          scanDurationMs: 0,
        }),
    }),
  );
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  /**
   * Both caches are rebuildable, so a failed write costs one cold scan and must
   * never surface. Written atomically so a crash mid-write cannot leave a
   * truncated document that the next start would reject wholesale.
   */
  const writeCacheFile = (filePath: string, contents: string): Effect.Effect<boolean> =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap(parseJsonFile),
        Effect.map(readRatesCacheFile),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(RATES_FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* writeCacheFile(
      ratesCachePath,
      JSON.stringify({ fetchedAtMs: now, document: fetched } satisfies RatesCacheFile),
    );
  });

  /**
   * `resolveClaudeHomePath` returns the process home the CLI runs under, which
   * is the home itself when overridden. A default install nests transcripts
   * under `~/.claude/projects`, so probe that before falling back.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  /** Resolves where each provider keeps its usage: transcript folders and databases. */
  const resolveSources = Effect.fn("UsageService.resolveSources")(function* () {
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            // Bounded description; the squashed failure travels as the cause.
            // Squashed, not the Cause tree: a full tree in a Defect field is
            // the unbounded wire payload the bounded detail exists to avoid.
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    // The main Claude folder: extra accounts link their `projects` back to it,
    // so their conversations are counted here too.
    const claudeMainProjects = path.join(
      yield* resolveClaudeMainConfigDir(settings.providers.claudeAgent, process.env),
      "projects",
    );
    const claudeDir = (yield* fileSystem
      .exists(claudeMainProjects)
      .pipe(Effect.catchCause(() => Effect.succeed(false))))
      ? claudeMainProjects
      : yield* resolveClaudeTranscriptDir(
          yield* resolveClaudeHomePath(settings.providers.claudeAgent),
        );
    // The shared home, not the shadow overlay: the overlay only isolates
    // `auth.json`, and `sessions` is a symlink back to the shared directory.
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);

    // The main Grok folder: extra accounts link their `sessions` back to it.
    // Grok is opt-in, so it is a source only once it has kept a conversation.
    const grokSessions = path.join(grokMainHome(process.env), "sessions");
    const grokUsed = yield* fileSystem
      .exists(grokSessions)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));

    // Pi's own folder, which Threadlines' Pi uses too. Its sessions are
    // counted once Pi has kept one.
    const piSessions = path.join(piAgentDir(process.env), "sessions");
    const piUsed = yield* fileSystem
      .exists(piSessions)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));

    const instances = Object.values(deriveProviderInstanceConfigMap(settings));
    const existing = (candidates: Iterable<string>) =>
      Effect.filter([...new Set(candidates)], (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.catchCause(() => Effect.succeed(false))),
      );

    // Muse's own folder, which the terminal and Threadlines' Muse share, plus
    // any folder an instance's own environment moves it to.
    const museFolders = yield* existing([
      museSessionsDir(process.env),
      ...instances
        .filter((instance) => String(instance.driver) === "muse")
        .map((instance) => museSessionsDir(museHostEnvironment(instance.environment))),
    ]);

    // Every OpenCode database: the terminal's own, and the one each instance
    // uses (an account folder gives it its own). A data folder holds one per
    // release channel. A server-URL instance keeps its data on that server.
    const openCodeLocations = [
      openCodeDatabaseLocation({ accountFolder: "", environment: process.env }),
      ...instances.flatMap((instance) => {
        if (String(instance.driver) !== "opencode") return [];
        const openCode = decodeOpenCodeSettings(instance.config ?? {});
        if (Option.isNone(openCode) || openCode.value.serverUrl.trim()) return [];
        const accountFolder = openCode.value.accountFolder.trim();
        return [
          openCodeDatabaseLocation({
            accountFolder: accountFolder ? path.resolve(expandHomePath(accountFolder)) : "",
            environment: mergeProviderInstanceEnvironment(instance.environment ?? []),
          }),
        ];
      }),
    ];
    const openCodeDatabases = yield* existing(
      (yield* Effect.forEach(openCodeLocations, (location) =>
        "file" in location
          ? Effect.succeed([location.file])
          : fileSystem.readDirectory(location.folder).pipe(
              Effect.map((names) =>
                names
                  .filter((name) => OPENCODE_DATABASE_FILE_NAME.test(name))
                  .map((name) => path.join(location.folder, name)),
              ),
              Effect.catchCause(() => Effect.succeed([])),
            ),
      )).flat(),
    );

    // The turn usage Threadlines records for agents that keep none on disk.
    const ledgerFolders = yield* Effect.filter(USAGE_LEDGER_PROVIDERS, (provider) =>
      fileSystem
        .exists(usageLedgerDir(config.stateDir, provider))
        .pipe(Effect.catchCause(() => Effect.succeed(false))),
    );

    const files = (provider: UsageProviderKind, dir: string, fileName?: string): UsageScanSource =>
      fileName === undefined
        ? { kind: "files", provider, dir }
        : { kind: "files", provider, dir, fileName };
    return [
      files("claude", claudeDir),
      files("codex", path.join(codexLayout.sharedHomePath, "sessions")),
      ...(grokUsed ? [files("grok", grokSessions, "updates.jsonl")] : []),
      ...(piUsed ? [files("pi", piSessions)] : []),
      ...museFolders.map((dir) => files("muse", dir)),
      ...openCodeDatabases.map((databasePath): UsageScanSource => ({
        kind: "database",
        provider: "opencode",
        path: databasePath,
        read: (sinceMs) => readOpenCodeUsage(databasePath, sinceMs),
      })),
      ...ledgerFolders.map((provider) =>
        files(provider, usageLedgerDir(config.stateDir, provider)),
      ),
    ];
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap(parseJsonFile),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [cachedPath, entry] of decodeScanCache(document)) fileCache.set(cachedPath, entry);
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on the
    // next scan instead of leaving disk permanently stale.
    const written = yield* writeCacheFile(
      scanCachePath,
      JSON.stringify(encodeScanCache(fileCache)),
    );
    if (written) cacheDirty = false;
  });

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, mtimeMs),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return [];
      // Stored already de-duplicated within the file, which is the bulk of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed);

      fileCache.set(filePath, { size, mtimeMs, provider, records });
      cacheDirty = true;
      return records;
    });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    const windowEnd = DateTime.make(`${input.untilDay}T00:00:00Z`);
    if (Option.isNone(windowStart) || Option.isNone(windowEnd)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `'${input.sinceDay}'..'${input.untilDay}' is not a valid date range`,
      });
    }

    const sinceMs = DateTime.toEpochMillis(windowStart.value);
    const spanDays = Math.round((DateTime.toEpochMillis(windowEnd.value) - sinceMs) / DAY_MS) + 1;
    // The scan cache only retains this far back, so a longer window would cold
    // scan every call. Reject it rather than silently taking minutes.
    if (spanDays > USAGE_MAX_WINDOW_DAYS) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `window of ${spanDays} days exceeds the ${USAGE_MAX_WINDOW_DAYS}-day maximum`,
      });
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    // Only the providers the client can show: one built before a provider
    // existed would fail to decode the whole summary over it.
    const shownProviders = new Set<string>(input.providers ?? USAGE_LEGACY_PROVIDER_KINDS);
    const scanSources = (yield* resolveSources().pipe(
      Effect.provideService(Path.Path, path),
    )).filter((source) => shownProviders.has(source.provider));
    const windowStartMs = sinceMs - MTIME_SLACK_MS;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      rates,
      // The current hour and the USAGE_RECENT_HOURS before it, which is one
      // hour of slack for a client whose clock trails this one.
      hourlySinceMs: hourStartOf(startedAtMs) - USAGE_RECENT_HOURS * HOUR_MS,
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const source of scanSources) {
      const { provider } = source;
      // The index this source's summary entry will have; buckets carry it.
      const sourceIndex = sources.length;
      const dir = source.kind === "files" ? source.dir : source.path;
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const scannedAt = yield* DateTime.now;

      if (exists && source.kind === "database") {
        const records = yield* Effect.sync(() => source.read(windowStartMs));
        const sessionIds = new Set<string>();
        for (const record of records ?? []) {
          if (aggregator.add(record, sourceIndex) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: records === null ? "failed" : "ok",
          lastScannedAt: DateTime.formatIso(scannedAt),
          scannedFiles: records === null ? 0 : 1,
          skippedFiles: records === null ? 1 : 0,
          distinctSessions: sessionIds.size,
          message: records === null ? "The database could not be read." : null,
        });
        continue;
      }

      if (!exists) {
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: "missing",
          lastScannedAt: DateTime.formatIso(scannedAt),
          scannedFiles: 0,
          skippedFiles: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      walkedRoots.push(dir);
      const files = yield* Effect.promise(() =>
        listTranscriptFiles(
          dir,
          windowStartMs,
          source.kind === "files" ? source.fileName : undefined,
        ),
      );
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of files) {
        livePaths.add(file.path);
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        if (records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record, sourceIndex) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: "ok",
        lastScannedAt: DateTime.formatIso(scannedAt),
        scannedFiles,
        skippedFiles,
        distinctSessions: sessionIds.size,
        message: null,
      });
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * DAY_MS,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      hourlyBuckets: aggregated.hourlyBuckets,
      sources,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return { readSummary } as const;
});

export const UsageServiceLive = Layer.effect(UsageService, make);
