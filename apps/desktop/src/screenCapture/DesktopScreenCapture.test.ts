import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { beforeEach, vi } from "vitest";

const { createFromBufferMock, getMediaAccessStatusMock, readImageMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  getMediaAccessStatusMock: vi.fn(() => "granted"),
  readImageMock: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    readImage: readImageMock,
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock,
  },
  systemPreferences: {
    getMediaAccessStatus: getMediaAccessStatusMock,
  },
}));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopScreenCapture from "./DesktopScreenCapture.ts";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function makeNativeImage(input: {
  readonly png: Buffer;
  readonly width?: number;
  readonly height?: number;
  readonly empty?: boolean;
}) {
  return {
    isEmpty: () => input.empty === true,
    toPNG: () => input.png,
    getSize: () => ({
      width: input.width ?? 320,
      height: input.height ?? 200,
    }),
  };
}

function makeProcess(options?: {
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function environmentLayer(input: {
  readonly platform: NodeJS.Platform;
  readonly baseDir: string;
  readonly isDevelopment?: boolean;
}) {
  return DesktopEnvironment.layer({ ...environmentInput, platform: input.platform }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: input.baseDir,
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: input.isDevelopment === false ? undefined : "http://127.0.0.1:5733",
        }),
      ),
    ),
  );
}

function screenCaptureLayer(input: {
  readonly platform: NodeJS.Platform;
  readonly baseDir: string;
  readonly isDevelopment?: boolean;
  readonly openExternal?: ElectronShell.ElectronShellShape["openExternal"];
  readonly openScreenClip?: ElectronShell.ElectronShellShape["openScreenClip"];
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly captureOptions?: DesktopScreenCapture.DesktopScreenCaptureOptions;
}) {
  const shellLayer = Layer.succeed(ElectronShell.ElectronShell, {
    openExternal: input.openExternal ?? (() => Effect.succeed(true)),
    openScreenClip: input.openScreenClip ?? (() => Effect.succeed(true)),
    copyText: () => Effect.void,
  } satisfies ElectronShell.ElectronShellShape);
  const spawnerLayer =
    input.spawnerLayer ??
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(makeProcess())),
    );

  return DesktopScreenCapture.layerWithOptions({
    windowsClipboardPollInterval: Duration.millis(1),
    windowsClipboardTimeout: Duration.millis(25),
    ...input.captureOptions,
  }).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provideMerge(shellLayer),
    Layer.provideMerge(spawnerLayer),
    Layer.provideMerge(
      environmentLayer({
        platform: input.platform,
        baseDir: input.baseDir,
        ...(input.isDevelopment === undefined ? {} : { isDevelopment: input.isDevelopment }),
      }),
    ),
  );
}

describe("DesktopScreenCapture", () => {
  beforeEach(() => {
    createFromBufferMock.mockReset();
    getMediaAccessStatusMock.mockReset();
    getMediaAccessStatusMock.mockReturnValue("granted");
    readImageMock.mockReset();
  });

  it.effect("captures a new Windows clipboard image after opening screen clip", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-windows-",
      });
      const oldImage = makeNativeImage({ png: Buffer.from("old"), width: 12, height: 8 });
      const newImage = makeNativeImage({ png: Buffer.from("new"), width: 640, height: 480 });
      readImageMock.mockReturnValueOnce(oldImage).mockReturnValueOnce(newImage);
      const openScreenClip = vi.fn(() => Effect.succeed(true));

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "win32",
            baseDir,
            openScreenClip,
          }),
        ),
      );

      assert.equal(result.status, "captured");
      if (result.status !== "captured") return;
      assert.equal(openScreenClip.mock.calls.length, 1);
      assert.equal(result.image.source, "windows-snipping-tool-clipboard");
      assert.equal(result.image.mimeType, "image/png");
      assert.equal(result.image.width, 640);
      assert.equal(result.image.height, 480);
      assert.isTrue(result.image.dataUrl.startsWith("data:image/png;base64,"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("captures a macOS interactive screenshot from a temporary PNG file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-macos-",
      });
      createFromBufferMock.mockReturnValue(
        makeNativeImage({ png: PNG_BYTES, width: 800, height: 500 }),
      );
      const spawnedCommands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }> = [];
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag === "StandardCommand") {
              spawnedCommands.push({
                command: command.command,
                args: command.args,
              });
              const outputPath = command.args.at(-1);
              if (outputPath) {
                yield* fileSystem.writeFile(outputPath, PNG_BYTES);
              }
            }
            return makeProcess();
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "darwin",
            baseDir,
            spawnerLayer,
          }),
        ),
      );

      assert.equal(result.status, "captured");
      const spawnedCommand = spawnedCommands[0];
      assert.isNotNull(spawnedCommand);
      if (!spawnedCommand || result.status !== "captured") return;
      assert.equal(spawnedCommand.command, "/usr/sbin/screencapture");
      assert.deepEqual(spawnedCommand.args.slice(0, 3), ["-i", "-t", "png"]);
      assert.equal(result.image.source, "macos-screencapture");
      assert.equal(result.image.width, 800);
      assert.equal(result.image.height, 500);
      assert.isTrue(result.image.dataUrl.startsWith("data:image/png;base64,"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not preflight-block macOS development capture on a denied Electron status", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-macos-dev-permission-",
      });
      getMediaAccessStatusMock.mockReturnValue("denied");
      createFromBufferMock.mockReturnValue(
        makeNativeImage({ png: PNG_BYTES, width: 800, height: 500 }),
      );
      const spawn = vi.fn((command) =>
        Effect.gen(function* () {
          if (command._tag === "StandardCommand") {
            const outputPath = command.args.at(-1);
            if (outputPath) {
              yield* fileSystem.writeFile(outputPath, PNG_BYTES);
            }
          }
          return makeProcess();
        }),
      );
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(spawn),
      );

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "darwin",
            baseDir,
            spawnerLayer,
          }),
        ),
      );

      assert.equal(result.status, "captured");
      assert.equal(spawn.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("attempts macOS capture when preflight screen recording status is denied", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-macos-permission-",
      });
      getMediaAccessStatusMock.mockReturnValue("denied");
      createFromBufferMock.mockReturnValue(
        makeNativeImage({ png: PNG_BYTES, width: 800, height: 500 }),
      );
      const openExternal = vi.fn(() => Effect.succeed(true));
      const spawn = vi.fn((command) =>
        Effect.gen(function* () {
          if (command._tag === "StandardCommand") {
            const outputPath = command.args.at(-1);
            if (outputPath) {
              yield* fileSystem.writeFile(outputPath, PNG_BYTES);
            }
          }
          return makeProcess();
        }),
      );
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(spawn),
      );

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "darwin",
            baseDir,
            isDevelopment: false,
            openExternal,
            spawnerLayer,
          }),
        ),
      );

      assert.equal(result.status, "captured");
      assert.equal(spawn.mock.calls.length, 1);
      assert.equal(openExternal.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not start macOS capture while screen recording permission is restricted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-macos-permission-restricted-",
      });
      getMediaAccessStatusMock.mockReturnValue("restricted");
      const openExternal = vi.fn(() => Effect.succeed(true));
      const spawn = vi.fn(() => Effect.succeed(makeProcess()));
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(spawn),
      );

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "darwin",
            baseDir,
            isDevelopment: false,
            openExternal,
            spawnerLayer,
          }),
        ),
      );

      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.include(result.message, "Threadlines screen recording permission as restricted");
      assert.include(result.message, "Screen & System Audio Recording");
      assert.include(result.message, "quit and reopen Threadlines");
      assert.equal(spawn.mock.calls.length, 0);
      assert.deepEqual(openExternal.mock.calls, [
        ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports macOS permission loss when screencapture exits without a PNG", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-macos-permission-lost-",
      });
      getMediaAccessStatusMock.mockReturnValue("denied");
      const openExternal = vi.fn(() => Effect.succeed(true));
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "darwin",
            baseDir,
            openExternal,
            spawnerLayer,
          }),
        ),
      );

      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.include(
        result.message,
        "macOS reports Electron.app screen recording permission as denied",
      );
      assert.include(result.message, "System Settings may not show Threadlines (Dev)");
      assert.deepEqual(openExternal.mock.calls, [
        ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("cleans up stale macOS temporary capture files before capturing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-macos-cleanup-",
      });
      const environment = yield* Effect.gen(function* () {
        return yield* DesktopEnvironment.DesktopEnvironment;
      }).pipe(Effect.provide(environmentLayer({ platform: "darwin", baseDir })));
      const captureDir = path.join(environment.stateDir, "screen-captures");
      const stalePath = path.join(captureDir, "stale.png");
      const freshPath = path.join(captureDir, "fresh.png");
      const unrelatedPath = path.join(captureDir, "stale.txt");

      yield* fileSystem.makeDirectory(captureDir, { recursive: true });
      yield* fileSystem.writeFile(stalePath, PNG_BYTES);
      yield* fileSystem.writeFile(freshPath, PNG_BYTES);
      yield* fileSystem.writeFile(unrelatedPath, PNG_BYTES);
      const futureMtime = DateTime.toDate(DateTime.add(yield* DateTime.now, { minutes: 1 }));
      yield* fileSystem.utimes(stalePath, 0, 0);
      yield* fileSystem.utimes(freshPath, futureMtime, futureMtime);
      yield* fileSystem.utimes(unrelatedPath, 0, 0);

      createFromBufferMock.mockReturnValue(
        makeNativeImage({ png: PNG_BYTES, width: 800, height: 500 }),
      );
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag === "StandardCommand") {
              const outputPath = command.args.at(-1);
              if (outputPath) {
                yield* fileSystem.writeFile(outputPath, PNG_BYTES);
              }
            }
            return makeProcess();
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "darwin",
            baseDir,
            spawnerLayer,
            captureOptions: {
              macosStaleCaptureMaxAge: Duration.millis(0),
            },
          }),
        ),
      );

      assert.equal(result.status, "captured");
      assert.isFalse(yield* fileSystem.exists(stalePath));
      assert.isTrue(yield* fileSystem.exists(freshPath));
      assert.isTrue(yield* fileSystem.exists(unrelatedPath));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns unsupported on platforms without a capture adapter", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-capture-linux-",
      });
      const result = yield* Effect.gen(function* () {
        const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
        return yield* screenCapture.captureScreenshot({ mode: "interactive" });
      }).pipe(
        Effect.provide(
          screenCaptureLayer({
            platform: "linux",
            baseDir,
          }),
        ),
      );

      assert.equal(result.status, "unsupported");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
