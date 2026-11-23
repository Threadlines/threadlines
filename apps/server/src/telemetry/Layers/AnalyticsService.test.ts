import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsLive, ServerSettingsService } from "../../serverSettings.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive, makeAnalyticsServiceLayer } from "./AnalyticsService.ts";

// The scratch data folders below live in the real temp folder, which marks a
// throwaway run. Tests about the settings opt-out point the temp check at a
// folder that holds nothing, so their installs count as real ones.
const notTheTempDir = makeAnalyticsServiceLayer({ tempDir: "/threadlines-test-no-temp-dir" });

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly api_key?: string;
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly threadlinesVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly api_key?: string;
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly threadlinesVersion?: string;
    };
  }>;
}

function makeBatchServerLayer(capturedRequests: Array<RecordedBatchRequest>) {
  return HttpServer.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method !== "POST") {
        return HttpServerResponse.empty({ status: 404 });
      }

      const payload = yield* request.json.pipe(
        Effect.map((body) => body as RecordedBatchRequest["body"]),
        Effect.catch(() => Effect.succeed(null)),
      );

      capturedRequests.push({ path: request.url, body: payload });

      return HttpServerResponse.jsonUnsafe({});
    }),
  );
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-base-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_TELEMETRY_ENABLED: true,
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          // "." keeps the batch URL relative so it resolves to the in-process
          // test server; Config treats "" as unset since effect 4.0.0-beta.97.
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.path === "/batch/" || request.path === "/batch"),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) => request.body.api_key === "phc_test_key"),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              typeof event.properties?.threadlinesVersion === "string" &&
              event.properties.threadlinesVersion.length > 0,
          ),
        ),
        true,
      );
    }),
  );

  it.effect("does not send telemetry without a Threadlines PostHog key", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-no-key-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_TELEMETRY_ENABLED: true,
          // "." keeps the batch URL relative so it resolves to the in-process
          // test server; Config treats "" as unset since effect 4.0.0-beta.97.
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.no_key", { index: 0 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 0);
    }),
  );

  it.effect("does not send telemetry from a data folder inside the temp folder", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-throwaway-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          // "." keeps the batch URL relative so it resolves to the in-process
          // test server; Config treats "" as unset since effect 4.0.0-beta.97.
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.throwaway", { index: 0 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 0);
    }),
  );

  it.effect("does not send telemetry when usage analytics are disabled in settings", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-disabled-",
      });

      const telemetryLayer = notTheTempDir.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          // "." keeps the batch URL relative so it resolves to the in-process
          // test server; Config treats "" as unset since effect 4.0.0-beta.97.
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          JSON.stringify({ usageAnalyticsEnabled: false }),
        );
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.disabled", { index: 0 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 0);
    }),
  );

  it.effect("sends telemetry when usage analytics are enabled in settings", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-settings-enabled-",
      });

      const telemetryLayer = notTheTempDir.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          // "." keeps the batch URL relative so it resolves to the in-process
          // test server; Config treats "" as unset since effect 4.0.0-beta.97.
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          JSON.stringify({ usageAnalyticsEnabled: true }),
        );
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.settings_enabled", { index: 0 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 1);
      assert.equal(batchRequests[0]?.body.batch[0]?.event, "test.flush.settings_enabled");
    }),
  );

  it.effect("reads usageAnalyticsEnabled from ServerSettingsService when provided", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-settings-service-",
      });

      const settingsLayer = ServerSettingsService.layerTest({ usageAnalyticsEnabled: false });
      const telemetryLayer = notTheTempDir.pipe(
        Layer.provideMerge(settingsLayer),
        Layer.provideMerge(serverConfigLayer),
      );
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.service_disabled", { index: 0 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 0);
    }),
  );

  it.effect("fails closed when settings.json is unreadable or corrupt", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-corrupt-settings-",
      });

      const telemetryLayer = notTheTempDir.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig;
        yield* fileSystem.writeFileString(serverConfig.settingsPath, "{ invalid json");
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.corrupt_settings", { index: 0 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 0);
    }),
  );

  it.effect("fails closed when settings.json is malformed behind live ServerSettingsLive", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-corrupt-live-settings-",
      });
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      );
      const batchServerLayer = makeBatchServerLayer(capturedRequests);

      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig;
        yield* fileSystem.writeFileString(serverConfig.settingsPath, "{ invalid json");

        const sharedServerConfig = Layer.succeed(ServerConfig, serverConfig);
        const runtimeLayer = notTheTempDir.pipe(
          Layer.provide(ServerSettingsLive),
          Layer.provideMerge(sharedServerConfig),
          Layer.provide(configLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        yield* Effect.gen(function* () {
          yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
          const analytics = yield* AnalyticsService;

          yield* analytics.record("test.flush.corrupt_live_settings", { index: 0 });
          yield* analytics.flush;
        }).pipe(Effect.provide(runtimeLayer));
      }).pipe(Effect.provide(serverConfigLayer));

      assert.equal(capturedRequests.length, 0);
    }),
  );

  it.effect("caps re-queued events at maxBufferedEvents when a flush fails", () =>
    Effect.gen(function* () {
      let failRequests = true;
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const flakyServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }
          if (failRequests) {
            return HttpServerResponse.empty({ status: 503 });
          }
          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );
          capturedRequests.push({ path: request.url, body: payload });
          return HttpServerResponse.jsonUnsafe({});
        }),
      );

      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-backoff-",
      });
      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          THREADLINES_TELEMETRY_ENABLED: true,
          THREADLINES_POSTHOG_KEY: "phc_test_key",
          THREADLINES_POSTHOG_HOST: ".",
          THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE: 2,
          THREADLINES_TELEMETRY_MAX_BUFFERED_EVENTS: 3,
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(flakyServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 3; index += 1) {
          yield* analytics.record("test.flush.retry", { index });
        }
        // Fails and re-queues events 0..1 ahead of event 2 (still capped at 3).
        yield* analytics.flush;
        // Recording 2 more while still offline drops the oldest (0, 1), keeping 2, 3, 4.
        yield* analytics.record("test.flush.retry", { index: 3 });
        yield* analytics.record("test.flush.retry", { index: 4 });

        failRequests = false;
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const deliveredIndexes = capturedRequests.flatMap((request) =>
        (request.body?.batch ?? [])
          .filter((event) => event.event === "test.flush.retry")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );
      assert.deepEqual(deliveredIndexes, [2, 3, 4]);
    }),
  );
});
