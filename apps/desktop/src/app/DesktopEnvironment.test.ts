import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  DESKTOP_DEVELOPMENT_APP_ID,
  DESKTOP_RELEASE_APP_ID,
} from "@threadlines/shared/desktopIdentity";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Threadlines.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Threadlines.app/Contents/Resources",
  runningUnderArm64Translation: false,
  // Deterministic in tests: never consult the real checkout's git tags.
  resolveDevAppVersion: () => undefined,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    return yield* DesktopEnvironment.DesktopEnvironment;
  }).pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

const toPortablePath = (value: string) => value.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
const assertPathEqual = (actual: string, expected: string) =>
  assert.equal(toPortablePath(actual), expected);

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          THREADLINES_HOME: " /tmp/threadlines ",
          THREADLINES_COMMIT_HASH: " 0123456789abcdef ",
          THREADLINES_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          THREADLINES_DEV_REMOTE_THREADLINES_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          THREADLINES_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          THREADLINES_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assertPathEqual(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assertPathEqual(environment.baseDir, "/tmp/threadlines");
      assertPathEqual(environment.stateDir, "/tmp/threadlines/dev");
      assertPathEqual(
        environment.desktopSettingsPath,
        "/tmp/threadlines/dev/desktop-settings.json",
      );
      assertPathEqual(environment.clientSettingsPath, "/tmp/threadlines/dev/client-settings.json");
      assertPathEqual(
        environment.savedEnvironmentRegistryPath,
        "/tmp/threadlines/dev/saved-environments.json",
      );
      assertPathEqual(environment.serverSettingsPath, "/tmp/threadlines/dev/settings.json");
      assertPathEqual(environment.logDir, "/tmp/threadlines/dev/logs");
      assertPathEqual(environment.rootDir, "/repo");
      assertPathEqual(environment.appRoot, "/repo");
      assertPathEqual(environment.developmentDockIconPath, "/repo/apps/desktop/resources/icon.png");
      assertPathEqual(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assertPathEqual(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, DESKTOP_DEVELOPMENT_APP_ID);
      assert.equal(environment.linuxWmClass, "threadlines-dev");
      assert.equal(environment.displayName, "Threadlines (Dev)");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(
        Option.map(environment.devRemoteThreadlinesServerEntryPath, toPortablePath),
        Option.some("/remote/server.mjs"),
      );
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
      assert.equal(environment.openDevToolsInDevelopment, false);
    }),
  );

  it.effect("can opt into opening DevTools in development", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          THREADLINES_DESKTOP_OPEN_DEVTOOLS: "true",
        },
      );

      assert.equal(environment.openDevToolsInDevelopment, true);
    }),
  );

  it.effect("versions development runs from the checkout instead of the Electron binary", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {
          resolveDevAppVersion: (rootDir) =>
            toPortablePath(rootDir) === "/repo" ? "1.5.0-nightly.9" : undefined,
        },
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      assert.equal(environment.appVersion, "1.5.0-nightly.9");
      assert.equal(environment.branding.version, "1.5.0-nightly.9");
      assert.equal(environment.branding.stageLabel, "Dev");
    }),
  );

  it.effect("keeps the Electron-reported version when the checkout has no release tag", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { resolveDevAppVersion: () => undefined },
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      assert.equal(environment.appVersion, "0.0.22");
    }),
  );

  it.effect("never consults the checkout version for packaged builds", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {
          isPackaged: true,
          resolveDevAppVersion: () => "9.9.9",
        },
        {},
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.appVersion, "0.0.22");
      assert.equal(environment.branding.version, "0.0.22");
    }),
  );

  it.effect("derives production state paths under userdata", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          THREADLINES_HOME: "/tmp/threadlines",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.displayName, "Threadlines");
      assert.equal(environment.appUserModelId, DESKTOP_RELEASE_APP_ID);
      assertPathEqual(environment.stateDir, "/tmp/threadlines/userdata");
      assertPathEqual(environment.logDir, "/tmp/threadlines/userdata/logs");
      assertPathEqual(environment.serverSettingsPath, "/tmp/threadlines/userdata/settings.json");
    }),
  );

  it.effect("uses Threadlines data directory defaults and aliases", () =>
    Effect.gen(function* () {
      const defaultEnvironment = yield* makeEnvironment();
      assertPathEqual(defaultEnvironment.baseDir, "/Users/alice/.threadlines");
      assertPathEqual(defaultEnvironment.stateDir, "/Users/alice/.threadlines/userdata");

      const aliasedEnvironment = yield* makeEnvironment(
        {},
        {
          THREADLINES_HOME: "/tmp/threadlines-home",
          THREADLINES_PORT: "6888",
          THREADLINES_COMMIT_HASH: "threadlineshash",
          BADCODE_HOME: "/tmp/compat-home",
          BADCODE_PORT: "5888",
          BADCODE_COMMIT_HASH: "badcodehash",
          T3CODE_HOME: "/tmp/legacy-home",
          T3CODE_PORT: "4888",
          T3CODE_COMMIT_HASH: "legacyhash",
        },
      );
      assertPathEqual(aliasedEnvironment.baseDir, "/tmp/threadlines-home");
      assert.deepEqual(aliasedEnvironment.configuredBackendPort, Option.some(6888));
      assert.deepEqual(aliasedEnvironment.commitHashOverride, Option.some("threadlineshash"));
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        Option.map(environment.resolvePickFolderDefaultPath({ initialPath: "~" }), toPortablePath),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        Option.map(
          environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
          toPortablePath,
        ),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
