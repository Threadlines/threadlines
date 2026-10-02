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
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@threadlines/contracts";
import { fromLenientJson } from "@threadlines/shared/schemaJson";
import { isThrowawayTelemetryRun } from "@threadlines/shared/telemetryConsent";
import { ServerConfig } from "../../config.ts";
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
  posthogKey: optionalTelemetryConfig(Config.string("THREADLINES_POSTHOG_KEY"), bundledPosthogKey),
  posthogHost: optionalTelemetryConfig(
    Config.string("THREADLINES_POSTHOG_HOST"),
    bundledPosthogHost,
  ),
  enabledOverride: Config.boolean("THREADLINES_TELEMETRY_ENABLED").pipe(Config.option),
  ci: Config.string("CI").pipe(Config.option),
  flushBatchSize: optionalTelemetryConfig(
    Config.number("THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE"),
    20,
  ),
  maxBufferedEvents: optionalTelemetryConfig(
    Config.number("THREADLINES_TELEMETRY_MAX_BUFFERED_EVENTS"),
    1_000,
  ),
});

const makeAnalyticsService = Effect.fnUntraced(function* (tempDir: string) {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const identifierRef = yield* Ref.make<string | null | undefined>(undefined);
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
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

  const isTelemetryEnabled = Effect.gen(function* () {
    if (Option.isSome(telemetryConfig.enabledOverride)) {
      return telemetryConfig.enabledOverride.value;
    }
    if (throwawayRun) {
      return false;
    }

    const rawSettings = yield* fileSystem
      .readFileString(serverConfig.settingsPath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    const decodedSettings = decodeServerSettingsJson(rawSettings);
    return Option.match(decodedSettings, {
      onNone: () => DEFAULT_SERVER_SETTINGS.usageAnalyticsEnabled,
      onSome: (settings) => settings.usageAnalyticsEnabled,
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("Failed to resolve telemetry settings", { cause }).pipe(Effect.as(false)),
    ),
  );

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

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

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
        return;
      }

      yield* sendBatch(batch).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }
  }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

  const record: AnalyticsServiceShape["record"] = Effect.fn("record")(
    function* (event, properties) {
      const enabled = yield* isTelemetryEnabled;
      if (!enabled) return;
      const identifier = yield* getIdentifier;
      if (!identifier) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return {
    record,
    flush,
  } satisfies AnalyticsServiceShape;
});

/**
 * `tempDir` is the system temp folder: a data folder inside it marks a
 * throwaway run (see `isThrowawayTelemetryRun`). Tests pass their own so
 * their scratch data folders can still exercise the settings opt-out.
 */
export const makeAnalyticsServiceLayer = (options: { readonly tempDir: string }) =>
  Layer.effect(AnalyticsService, makeAnalyticsService(options.tempDir));

export const AnalyticsServiceLayerLive = makeAnalyticsServiceLayer({ tempDir: OS.tmpdir() });
