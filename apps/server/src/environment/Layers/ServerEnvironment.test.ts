// @effect-diagnostics nodeBuiltinImport:off
import * as nodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerSettingsLive, ServerSettingsService } from "../../serverSettings.ts";
import { ServerEnvironment } from "../Services/ServerEnvironment.ts";
import { ServerEnvironmentLive } from "./ServerEnvironment.ts";

const makeServerEnvironmentLayer = (baseDir: string) =>
  ServerEnvironmentLive.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(ServerSettingsService.layerTest()),
  );

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    appVersion: "0.0.0-test",
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "threadlines-server",
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    advertisedHost: undefined,
    desktopBootstrapToken: undefined,
    desktopLaunchId: undefined,
    shellEnvironmentPrepared: false,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    startupPresentation: "browser",
  } satisfies ServerConfigShape;
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(second.serverVersion).toBe("0.0.0-test");
      expect(second.capabilities.repositoryIdentity).toBe(true);
    }),
  );

  it.effect("is named as its settings say from the start, and follows a rename at once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-server-environment-name-test-",
      });
      const { settingsPath } = yield* deriveServerPaths(baseDir, undefined);
      yield* fileSystem.makeDirectory(nodePath.dirname(settingsPath), { recursive: true });
      yield* fileSystem.writeFileString(
        settingsPath,
        JSON.stringify({ computerName: "Studio Mac" }),
      );

      yield* Effect.gen(function* () {
        const environment = yield* ServerEnvironment;
        const settings = yield* ServerSettingsService;
        const named = yield* environment.getDescriptor;
        expect(named.label).toBe("Studio Mac");
        expect(named.systemLabel).toBeDefined();

        const renamed = yield* environment.labelChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* settings.updateSettings({ computerName: null });
        const [announced] = yield* Fiber.join(renamed);
        // Back to the name its system gives it, everywhere at once.
        expect(announced?.label).toBe(named.systemLabel);
        expect(environment.currentLabel()).toBe(named.systemLabel);
        expect((yield* environment.getDescriptor).label).toBe(named.systemLabel);
        expect(environment.describe("Windows PC").label).toBe("Windows PC");
      }).pipe(
        Effect.provide(
          // Wired as server.ts wires it: the settings layer given to the
          // environment is the very one the rest of the server writes to.
          Layer.mergeAll(
            ServerSettingsLive,
            ServerEnvironmentLive.pipe(Layer.provide(ServerSettingsLive)),
          ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir))),
        ),
      );
    }),
  );

  it.effect("fails instead of overwriting a persisted id when reading the file errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-server-environment-read-error-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      const environmentIdPath = serverConfig.environmentIdPath;
      yield* fileSystem.makeDirectory(nodePath.dirname(environmentIdPath), { recursive: true });
      yield* fileSystem.writeFileString(environmentIdPath, "persisted-environment-id\n");
      const writeAttempts: string[] = [];
      const failingFileSystemLayer = FileSystem.layerNoop({
        exists: (path) => Effect.succeed(path === environmentIdPath),
        readFileString: (path) =>
          path === environmentIdPath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "permission denied",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "not found",
                  pathOrDescriptor: path,
                }),
              ),
        writeFileString: (path) => {
          writeAttempts.push(path);
          return Effect.void;
        },
      });

      const exit = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironmentLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ServerConfig, serverConfig),
                failingFileSystemLayer,
                ServerSettingsService.layerTest(),
              ),
            ),
          ),
        ),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(writeAttempts).toEqual([]);
      expect(yield* fileSystem.readFileString(environmentIdPath)).toBe(
        "persisted-environment-id\n",
      );
    }),
  );
});
