/**
 * AnalyticsServiceLive - Anonymous PostHog telemetry layer.
 *
 * Persists a random installation-scoped anonymous id to state dir, buffers
 * events in memory, and flushes batches to PostHog over Effect HttpClient.
 *
 * @module AnalyticsServiceLive
 */

import * as OS from "node:os";

import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@threadlines/contracts";
import { fromLenientJson } from "@threadlines/shared/schemaJson";
import { isThrowawayTelemetryRun } from "@threadlines/shared/telemetryConsent";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService, type AnalyticsServiceShape } from "../Services/AnalyticsService.ts";
import { getTelemetryIdentifier } from "../Identify.ts";

declare const __THREADLINES_BUNDLED_POSTHOG_KEY__: string | undefined;
declare const __THREADLINES_BUNDLED_POSTHOG_HOST__: string | undefined;

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

const bundledPosthogKey =
  typeof __THREADLINES_BUNDLED_POSTHOG_KEY__ === "string"
    ? __THREADLINES_BUNDLED_POSTHOG_KEY__
    : "";

const bundledPosthogHost =
  typeof __THREADLINES_BUNDLED_POSTHOG_HOST__ === "string"
    ? __THREADLINES_BUNDLED_POSTHOG_HOST__
    : "https://us.i.posthog.com";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

const optionalTelemetryConfig = <A>(config: Config.Config<A>, defaultValue: A) =>
  config.pipe(
    Config.option,
    Config.map((value) => Option.getOrElse(value, () => defaultValue)),
  );

const TelemetryEnvConfig = Config.all({
  posthogKey: optionalTelemetryConfig(Config.String("THREADLINES_POSTHOG_KEY"), bundledPosthogKey),
  posthogHost: optionalTelemetryConfig(
    Config.String("THREADLINES_POSTHOG_HOST"),
    bundledPosthogHost,
  ),
  enabledOverride: Config.Boolean("THREADLINES_TELEMETRY_ENABLED").pipe(Config.option),
  ci: Config.String("CI").pipe(Config.option),
  flushBatchSize: optionalTelemetryConfig(
    Config.Number("THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE"),
    20,
  ),
  maxBufferedEvents: optionalTelemetryConfig(
    Config.Number("THREADLINES_TELEMETRY_MAX_BUFFERED_EVENTS"),
    1_000,
  ),
});

const DEFAULT_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_MAX_FLUSH_BACKOFF_MS = 300_000;

export interface AnalyticsServiceLayerOptions {
  readonly tempDir: string;
  readonly flushIntervalMs?: number;
  readonly maxFlushBackoffMs?: number;
}

const makeAnalyticsService = Effect.fnUntraced(function* (options: AnalyticsServiceLayerOptions) {
  const { tempDir } = options;
  const flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  const maxFlushBackoffMs = Math.max(
    flushIntervalMs,
    options.maxFlushBackoffMs ?? DEFAULT_MAX_FLUSH_BACKOFF_MS,
  );
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  const identifierRef = yield* Ref.make<string | null | undefined>(undefined);
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const consecutiveFailuresRef = yield* Ref.make(0);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const telemetryIdentifier = getTelemetryIdentifier.pipe(
    Effect.provideService(ServerConfig, serverConfig),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  // Fixed for the life of the process, so worked out once.
  const realPathOrSelf = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const throwawayRun = isThrowawayTelemetryRun({
    baseDirs: [serverConfig.baseDir, yield* realPathOrSelf(serverConfig.baseDir)],
    tempDirs: [tempDir, yield* realPathOrSelf(tempDir)],
    ciEnv: Option.getOrUndefined(telemetryConfig.ci),
  });

  const getIdentifier = Effect.gen(function* () {
    const cachedIdentifier = yield* Ref.get(identifierRef);
    if (cachedIdentifier !== undefined) {
      return cachedIdentifier;
    }

    const identifier = yield* telemetryIdentifier;
    yield* Ref.set(identifierRef, identifier);
    return identifier;
  });

  const hasPosthogKey = telemetryConfig.posthogKey.trim().length > 0;
  let enabledCache = false;
  let clearGeneration = 0;
  const disabledListeners = new Set<() => void>();

  const applyEnabled = (next: boolean) =>
    Effect.suspend(() => {
      const effective = hasPosthogKey && next;
      const wasEnabled = enabledCache;
      enabledCache = effective;
      if (!effective) {
        clearGeneration += 1;
      }
      if (wasEnabled && !effective) {
        for (const listener of disabledListeners) {
          listener();
        }
      }
      return effective ? Effect.void : Ref.set(bufferRef, []);
    });

  const readSettingsFileConsent = Effect.gen(function* () {
    const fileResult = yield* fileSystem
      .readFileString(serverConfig.settingsPath)
      .pipe(Effect.result);
    if (fileResult._tag === "Failure") {
      // Missing settings file means a fresh install using the default preference; any other read error fails closed.
      const error = fileResult.failure;
      const isMissing =
        typeof error === "object" &&
        error !== null &&
        "reason" in error &&
        (error as { readonly reason?: { readonly _tag?: string } }).reason?._tag === "NotFound";
      return isMissing ? null : false;
    }
    const decodedSettings = decodeServerSettingsJson(fileResult.success);
    return Option.match(decodedSettings, {
      onNone: () => false,
      onSome: (settings) => settings.usageAnalyticsEnabled,
    });
  }).pipe(Effect.catch(() => Effect.succeed(false)));

  const isTelemetryEnabled = Effect.gen(function* () {
    if (Option.isSome(telemetryConfig.enabledOverride)) {
      return telemetryConfig.enabledOverride.value;
    }
    if (throwawayRun) {
      return false;
    }
    if (Option.isSome(serverSettings)) {
      return yield* serverSettings.value.readStored.pipe(
        Effect.map((settings) => settings.usageAnalyticsEnabled),
        // Fail closed when stored settings cannot be read so an unreadable file never opts a user in.
        Effect.catch(() => Effect.succeed(false)),
      );
    }

    const fromDisk = yield* readSettingsFileConsent;
    return fromDisk === null ? DEFAULT_SERVER_SETTINGS.usageAnalyticsEnabled : fromDisk;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("Failed to resolve telemetry settings", { cause }).pipe(Effect.as(false)),
    ),
    Effect.tap((enabled) => applyEnabled(enabled)),
  );

  // Seed live consent state before returning so synchronous counters reflect current preference.
  yield* isTelemetryEnabled;
  if (
    hasPosthogKey &&
    Option.isSome(serverSettings) &&
    Option.isNone(telemetryConfig.enabledOverride) &&
    !throwawayRun
  ) {
    yield* serverSettings.value.subscribeChanges.pipe(
      Effect.flatMap((changes) =>
        Stream.runForEach(changes, (settings) => applyEnabled(settings.usageAnalyticsEnabled)),
      ),
      Effect.catch(() => Effect.void),
      Effect.forkScoped,
    );
  }

  const clampBufferedEvents = (events: ReadonlyArray<BufferedAnalyticsEvent>) =>
    events.length > telemetryConfig.maxBufferedEvents
      ? events.slice(events.length - telemetryConfig.maxBufferedEvents)
      : events;

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next = clampBufferedEvents(appended);

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    const posthogKey = telemetryConfig.posthogKey.trim();
    if (!posthogKey) return;
    const enabled = yield* isTelemetryEnabled;
    if (!enabled) return;
    // Double-check settings.json on disk once per outgoing HTTP batch so an external
    // opt-out or corrupt file is still honored even if the settings file watcher died.
    if (
      Option.isSome(serverSettings) &&
      Option.isNone(telemetryConfig.enabledOverride) &&
      !throwawayRun
    ) {
      const diskConsent = yield* readSettingsFileConsent;
      if (diskConsent === false) {
        yield* applyEnabled(false);
        return;
      }
    }
    const identifier = yield* getIdentifier;
    if (!identifier) return;

    const payload = {
      api_key: posthogKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: identifier,
        properties: {
          ...event.properties,
          $process_person_profile: false,
          platform: process.platform,
          wsl: process.env.WSL_DISTRO_NAME,
          arch: process.arch,
          threadlinesVersion: serverConfig.appVersion,
          clientType,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const flush: AnalyticsServiceShape["flush"] = Effect.gen(function* () {
    while (true) {
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        yield* Ref.set(consecutiveFailuresRef, 0);
        return;
      }

      const generation = clearGeneration;
      yield* sendBatch(batch).pipe(
        Effect.catch((error) =>
          (enabledCache && clearGeneration === generation
            ? Ref.update(bufferRef, (current) => clampBufferedEvents([...batch, ...current]))
            : Effect.void
          ).pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );
      yield* Ref.set(consecutiveFailuresRef, 0);
    }
  }).pipe(
    Effect.catch((cause) =>
      Ref.updateAndGet(consecutiveFailuresRef, (failures) => failures + 1).pipe(
        Effect.flatMap((failures) =>
          failures === 1
            ? Effect.logWarning("Failed to flush telemetry; retrying with backoff", { cause })
            : Effect.logDebug("Failed to flush telemetry", {
                cause,
                consecutiveFailures: failures,
              }),
        ),
      ),
    ),
  );

  const record: AnalyticsServiceShape["record"] = Effect.fn("record")(
    function* (event, properties) {
      if (!telemetryConfig.posthogKey.trim()) return;
      const enabled = yield* isTelemetryEnabled;
      if (!enabled) return;
      const generation = clearGeneration;
      const identifier = yield* getIdentifier;
      if (!identifier || !enabledCache || clearGeneration !== generation) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  const nextFlushDelayMs = Ref.get(consecutiveFailuresRef).pipe(
    Effect.map((failures) =>
      Math.min(maxFlushBackoffMs, flushIntervalMs * 2 ** Math.min(failures, 10)),
    ),
  );

  yield* Effect.forever(
    nextFlushDelayMs.pipe(
      Effect.flatMap((delayMs) => Effect.sleep(delayMs)),
      Effect.tap(() => isTelemetryEnabled),
      Effect.flatMap(() => flush),
    ),
    {
      disableYield: true,
    },
  ).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return {
    record,
    flush,
    consent: {
      isEnabledSync: () => enabledCache,
      onDisabled: (listener) => {
        disabledListeners.add(listener);
        return () => {
          disabledListeners.delete(listener);
        };
      },
    },
  } satisfies AnalyticsServiceShape;
});

/**
 * `tempDir` is the system temp folder: a data folder inside it marks a
 * throwaway run (see `isThrowawayTelemetryRun`). Tests pass their own so
 * their scratch data folders can still exercise the settings opt-out.
 */
export const makeAnalyticsServiceLayer = (options: AnalyticsServiceLayerOptions) =>
  Layer.effect(AnalyticsService, makeAnalyticsService(options));

export const AnalyticsServiceLayerLive = makeAnalyticsServiceLayer({ tempDir: OS.tmpdir() });
