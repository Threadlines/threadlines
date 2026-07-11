import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive } from "./AnalyticsService.ts";

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

  it.effect("does not send telemetry when usage analytics are disabled in settings", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "threadlines-telemetry-disabled-",
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
});
