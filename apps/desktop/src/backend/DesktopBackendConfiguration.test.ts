import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@threadlines/shared/Net";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

const PersistedServerObservabilitySettingsDocument = Schema.Struct({
  observability: Schema.Struct({
    otlpTracesUrl: Schema.String,
    otlpMetricsUrl: Schema.String,
  }),
});

const encodePersistedServerObservabilitySettingsDocument = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerObservabilitySettingsDocument),
);

/** An explicitly configured port: the backend must never move it. */
const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    portSelectedByScan: false,
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposureShape);

const makeNetLayer = (occupiedPorts: readonly number[] = []) => {
  const occupied = new Set(occupiedPorts);
  return Layer.succeed(NetService.NetService, {
    canListenOnHost: (port: number) => Effect.succeed(!occupied.has(port)),
    isPortAvailableOnLoopback: () => Effect.die("unexpected isPortAvailableOnLoopback"),
    reserveLoopbackPort: () => Effect.die("unexpected reserveLoopbackPort"),
    findAvailablePort: () => Effect.die("unexpected findAvailablePort"),
  } satisfies NetService.NetServiceShape);
};

// The exposure service constructs a spawner and an HTTP client for endpoint
// discovery, which these tests never reach.
const unusedSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
);

function makeEnvironmentLayer(
  baseDir: string,
  options?: {
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
  },
) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
        }),
      ),
    ),
  );
}

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
  options?: { readonly occupiedPorts?: readonly number[] },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(makeNetLayer(options?.occupiedPorts)),
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/**
 * The real exposure service, so a re-selected port has to travel through the
 * advertised state and the httpBaseUrl the window loads.
 */
const withLiveExposureHarness = <A, E, R>(
  input: { readonly occupiedPorts: readonly number[] },
  effect: Effect.Effect<
    A,
    E,
    | R
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
    | DesktopServerExposure.DesktopServerExposure
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-port-test-",
    });

    const exposureLayer = DesktopServerExposure.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(DesktopServerExposure.DesktopNetworkInterfacesService, {
          read: Effect.succeed({}),
        }),
      ),
      Layer.provideMerge(DesktopAppSettings.layerTest()),
      Layer.provideMerge(NodeHttpClient.layerUndici),
      Layer.provideMerge(unusedSpawnerLayer),
      Layer.provideMerge(DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    );

    return yield* effect.pipe(
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(exposureLayer),
          Layer.provideMerge(makeNetLayer(input.occupiedPorts)),
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it.effect("resolves backend start config with a stable scoped bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const first = yield* configuration.resolve;
        const second = yield* configuration.resolve;

        assert.equal(first.executablePath, process.execPath);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.equal(first.env.APP_VERSION, "1.2.3");
        assert.equal(first.env.THREADLINES_APP_VERSION, "1.2.3");
        assert.isUndefined(first.env.VITE_APP_VERSION);
        assert.isUndefined(first.env.THREADLINES_PORT);
        assert.isUndefined(first.env.THREADLINES_MODE);
        assert.isUndefined(first.env.THREADLINES_DESKTOP_LAN_HOST);
        assert.isUndefined(first.env.BADCODE_PORT);
        assert.isUndefined(first.env.BADCODE_MODE);
        assert.isUndefined(first.env.BADCODE_DESKTOP_LAN_HOST);
        assert.isUndefined(first.env.T3CODE_PORT);
        assert.isUndefined(first.env.T3CODE_MODE);
        assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);

        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.host, "0.0.0.0");
        assert.equal(first.bootstrap.threadlinesHome, environment.baseDir);
        assert.equal(first.bootstrap.appVersion, "1.2.3");
        assert.equal(first.bootstrap.tailscaleServeEnabled, true);
        assert.equal(first.bootstrap.tailscaleServePort, 8443);
        assert.match(first.bootstrap.desktopBootstrapToken, /^[0-9a-f]{48}$/i);
        assert.equal(second.bootstrap.desktopBootstrapToken, first.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("includes persisted backend observability endpoints when present", () =>
    withHarness(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
            },
          }),
        );

        const config = yield* configuration.resolve;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
      }),
    ),
  );

  it.effect("omits backend observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;

        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      }),
    ),
  );

  it.effect("keeps the selected backend port while it is still bindable", () =>
    withLiveExposureHarness(
      { occupiedPorts: [] },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        yield* serverExposure.configureFromSettings({ port: 3775, selectedByScan: true });

        const config = yield* configuration.resolve;

        assert.equal(config.bootstrap.port, 3775);
        assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:3775/");
        assert.equal((yield* serverExposure.backendConfig).port, 3775);
      }),
    ),
  );

  it.effect("re-selects a scanned backend port that was taken while the backend was down", () =>
    withLiveExposureHarness(
      { occupiedPorts: [3773, 3774] },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        yield* serverExposure.configureFromSettings({ port: 3774, selectedByScan: true });

        const config = yield* configuration.resolve;

        assert.equal(config.bootstrap.port, 3775);
        assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:3775/");
        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.port, 3775);
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:3775/");
      }),
    ),
  );

  it.effect("never moves an explicitly configured backend port, even when it is taken", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;

        assert.equal(config.bootstrap.port, 4888);
        assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:4888/");
      }),
      { occupiedPorts: [4888] },
    ),
  );

  it.effect("captures backend output in development so child process logs can be persisted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;
        assert.equal(config.captureOutput, true);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(makeNetLayer()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                isPackaged: false,
                devServerUrl: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
