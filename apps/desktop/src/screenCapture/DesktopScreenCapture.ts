import { createHash, randomUUID } from "node:crypto";

import type {
  DesktopCapturedScreenshot,
  DesktopCapturedScreenshotSource,
  DesktopCaptureScreenshotInput,
  DesktopCaptureScreenshotResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { clipboard, nativeImage } from "electron";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

const SCREENSHOT_MIME_TYPE = "image/png";
const WINDOWS_CLIPBOARD_TIMEOUT = Duration.seconds(60);
const WINDOWS_CLIPBOARD_POLL_INTERVAL = Duration.millis(350);
const MACOS_CAPTURE_TIMEOUT = Duration.minutes(5);
const MACOS_STALE_CAPTURE_MAX_AGE = Duration.minutes(15);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const currentEpochMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

type ChildProcessSpawnerService = ChildProcessSpawner.ChildProcessSpawner["Service"];

interface ClipboardPngSnapshot {
  readonly png: Buffer;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
}

export interface DesktopScreenCaptureOptions {
  readonly windowsClipboardTimeout?: Duration.Duration;
  readonly windowsClipboardPollInterval?: Duration.Duration;
  readonly macosCaptureTimeout?: Duration.Duration;
  readonly macosStaleCaptureMaxAge?: Duration.Duration;
}

export interface DesktopScreenCaptureShape {
  readonly captureScreenshot: (
    input: DesktopCaptureScreenshotInput,
  ) => Effect.Effect<DesktopCaptureScreenshotResult>;
}

export class DesktopScreenCapture extends Context.Service<
  DesktopScreenCapture,
  DesktopScreenCaptureShape
>()("t3/desktop/ScreenCapture") {}

function screenshotName(capturedAt: string): string {
  const compactTimestamp = capturedAt.replace(/\D/g, "").slice(0, 14);
  return `screenshot-${compactTimestamp || "capture"}.png`;
}

function hashPng(png: Buffer): string {
  return createHash("sha256").update(png).digest("hex");
}

function nativeImageToClipboardSnapshot(image: Electron.NativeImage): ClipboardPngSnapshot | null {
  if (image.isEmpty()) {
    return null;
  }

  const png = image.toPNG();
  if (png.byteLength === 0) {
    return null;
  }

  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }

  return {
    png,
    hash: hashPng(png),
    width: size.width,
    height: size.height,
  };
}

const readClipboardPngSnapshot: Effect.Effect<ClipboardPngSnapshot | null> = Effect.try({
  try: () => nativeImageToClipboardSnapshot(clipboard.readImage()),
  catch: () => null,
}).pipe(Effect.catch(() => Effect.succeed(null)));

function capturedScreenshotFromPng(input: {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly source: DesktopCapturedScreenshotSource;
  readonly capturedAt: string;
}): DesktopCapturedScreenshot {
  return {
    name: screenshotName(input.capturedAt),
    mimeType: SCREENSHOT_MIME_TYPE,
    sizeBytes: input.png.byteLength,
    dataUrl: `data:${SCREENSHOT_MIME_TYPE};base64,${input.png.toString("base64")}`,
    width: input.width,
    height: input.height,
    capturedAt: input.capturedAt,
    source: input.source,
  };
}

function capturedScreenshotFromNativePng(input: {
  readonly png: Buffer;
  readonly source: DesktopCapturedScreenshotSource;
  readonly capturedAt: string;
}): DesktopCapturedScreenshot | null {
  const image = nativeImage.createFromBuffer(input.png);
  if (image.isEmpty()) {
    return null;
  }

  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }

  return capturedScreenshotFromPng({
    png: input.png,
    width: size.width,
    height: size.height,
    source: input.source,
    capturedAt: input.capturedAt,
  });
}

const makeCapturedResult = (image: DesktopCapturedScreenshot): DesktopCaptureScreenshotResult => ({
  status: "captured",
  image,
});

const cancelled = (message?: string): DesktopCaptureScreenshotResult => ({
  status: "cancelled",
  ...(message ? { message } : {}),
});

const failed = (message: string): DesktopCaptureScreenshotResult => ({
  status: "failed",
  message,
});

const pollWindowsClipboardForCapture = Effect.fn("desktop.screenCapture.pollWindowsClipboard")(
  function* (
    previousHash: string | null,
    options: Required<
      Pick<DesktopScreenCaptureOptions, "windowsClipboardPollInterval" | "windowsClipboardTimeout">
    >,
  ): Effect.fn.Return<DesktopCaptureScreenshotResult> {
    const startedAt = yield* currentEpochMillis;
    const timeoutMs = Duration.toMillis(options.windowsClipboardTimeout);
    const deadline = startedAt + timeoutMs;

    while ((yield* currentEpochMillis) <= deadline) {
      const snapshot = yield* readClipboardPngSnapshot;
      if (snapshot && snapshot.hash !== previousHash) {
        const capturedAt = yield* currentIsoTimestamp;
        return makeCapturedResult(
          capturedScreenshotFromPng({
            png: snapshot.png,
            width: snapshot.width,
            height: snapshot.height,
            source: "windows-snipping-tool-clipboard",
            capturedAt,
          }),
        );
      }

      yield* Effect.sleep(options.windowsClipboardPollInterval);
    }

    return cancelled("No new screenshot was copied to the clipboard.");
  },
);

const captureWindowsInteractive = Effect.fn("desktop.screenCapture.windowsInteractive")(function* (
  shell: ElectronShell.ElectronShellShape,
  options: Required<
    Pick<DesktopScreenCaptureOptions, "windowsClipboardPollInterval" | "windowsClipboardTimeout">
  >,
): Effect.fn.Return<DesktopCaptureScreenshotResult> {
  const previousSnapshot = yield* readClipboardPngSnapshot;
  const opened = yield* shell.openScreenClip();
  if (!opened) {
    return failed("Windows screen clipping could not be opened.");
  }

  return yield* pollWindowsClipboardForCapture(previousSnapshot?.hash ?? null, options);
});

const runMacosScreencapture = Effect.fn("desktop.screenCapture.runMacosScreencapture")(function* (
  spawner: ChildProcessSpawnerService,
  filePath: string,
  timeout: Duration.Duration,
): Effect.fn.Return<{ readonly timedOut: boolean; readonly exitCode: number | null }> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make("/usr/sbin/screencapture", ["-i", "-t", "png", filePath], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            killSignal: "SIGTERM",
            forceKillAfter: PROCESS_TERMINATE_GRACE,
          }),
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!handle) {
        return { timedOut: false, exitCode: null };
      }

      const exitCode = yield* handle.exitCode.pipe(
        Effect.timeoutOption(timeout),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      if (Option.isNone(exitCode)) {
        yield* handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: PROCESS_TERMINATE_GRACE })
          .pipe(Effect.ignore);
        return { timedOut: true, exitCode: null };
      }

      return { timedOut: false, exitCode: Number(exitCode.value) };
    }),
  );
});

function resolveTopLevelPngCapturePath(input: {
  readonly captureDir: string;
  readonly entry: string;
  readonly path: Path.Path;
}): string | null {
  const resolvedCaptureDir = input.path.resolve(input.captureDir);
  const resolvedEntryPath = input.path.isAbsolute(input.entry)
    ? input.path.resolve(input.entry)
    : input.path.resolve(input.captureDir, input.entry);
  const relativePath = input.path.relative(resolvedCaptureDir, resolvedEntryPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    input.path.isAbsolute(relativePath) ||
    relativePath.includes("/") ||
    relativePath.includes("\\") ||
    !relativePath.toLowerCase().endsWith(".png")
  ) {
    return null;
  }

  return resolvedEntryPath;
}

const cleanupStaleMacosCaptureFiles = Effect.fn(
  "desktop.screenCapture.cleanupStaleMacosCaptureFiles",
)(function* (
  input: {
    readonly captureDir: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
  maxAge: Duration.Duration,
): Effect.fn.Return<void> {
  const entries = yield* input.fileSystem
    .readDirectory(input.captureDir)
    .pipe(Effect.catch(() => Effect.succeed([])));
  if (entries.length === 0) {
    return;
  }

  const staleBefore = (yield* currentEpochMillis) - Duration.toMillis(maxAge);
  for (const entry of entries) {
    const filePath = resolveTopLevelPngCapturePath({
      captureDir: input.captureDir,
      entry,
      path: input.path,
    });
    if (!filePath) {
      continue;
    }

    const stat = yield* input.fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") {
      continue;
    }

    const mtimeMs = Option.match(stat.mtime, {
      onNone: () => null,
      onSome: (mtime) => mtime.getTime(),
    });
    if (mtimeMs === null || mtimeMs > staleBefore) {
      continue;
    }

    yield* input.fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore);
  }
});

const captureMacosInteractive = Effect.fn("desktop.screenCapture.macosInteractive")(function* (
  input: {
    readonly environment: DesktopEnvironment.DesktopEnvironmentShape;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly spawner: ChildProcessSpawnerService;
  },
  timeout: Duration.Duration,
  staleCaptureMaxAge: Duration.Duration,
): Effect.fn.Return<DesktopCaptureScreenshotResult> {
  const captureDir = input.path.join(input.environment.stateDir, "screen-captures");
  const capturePath = input.path.join(captureDir, `${randomUUID()}.png`);

  yield* input.fileSystem
    .makeDirectory(captureDir, { recursive: true })
    .pipe(Effect.catch(() => Effect.void));

  yield* cleanupStaleMacosCaptureFiles(
    {
      captureDir,
      fileSystem: input.fileSystem,
      path: input.path,
    },
    staleCaptureMaxAge,
  );

  const result = yield* runMacosScreencapture(input.spawner, capturePath, timeout);
  const cleanup = input.fileSystem.remove(capturePath, { force: true }).pipe(Effect.ignore);

  if (result.timedOut) {
    yield* cleanup;
    return cancelled("Screen capture timed out.");
  }

  const maybePng = yield* input.fileSystem.readFile(capturePath).pipe(
    Effect.map((bytes) => Buffer.from(bytes)),
    Effect.catch(() => Effect.succeed(null)),
  );
  yield* cleanup;

  if (!maybePng || maybePng.byteLength === 0) {
    if (result.exitCode === null) {
      return failed("macOS screen capture could not be started.");
    }
    return cancelled("Screen capture was cancelled.");
  }

  const capturedAt = yield* currentIsoTimestamp;
  const image = capturedScreenshotFromNativePng({
    png: maybePng,
    source: "macos-screencapture",
    capturedAt,
  });
  if (!image) {
    const message =
      result.exitCode === null
        ? "macOS returned an unreadable screenshot."
        : `macOS returned an unreadable screenshot (exit code ${result.exitCode}).`;
    return failed(message);
  }

  return makeCapturedResult(image);
});

const make = Effect.fn("desktop.screenCapture.make")(function* (
  options: DesktopScreenCaptureOptions = {},
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shell = yield* ElectronShell.ElectronShell;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const windowsOptions = {
    windowsClipboardPollInterval:
      options.windowsClipboardPollInterval ?? WINDOWS_CLIPBOARD_POLL_INTERVAL,
    windowsClipboardTimeout: options.windowsClipboardTimeout ?? WINDOWS_CLIPBOARD_TIMEOUT,
  };
  const macosCaptureTimeout = options.macosCaptureTimeout ?? MACOS_CAPTURE_TIMEOUT;
  const macosStaleCaptureMaxAge = options.macosStaleCaptureMaxAge ?? MACOS_STALE_CAPTURE_MAX_AGE;

  return DesktopScreenCapture.of({
    captureScreenshot: (input) =>
      Effect.gen(function* () {
        if (input.mode !== "interactive") {
          return {
            status: "unsupported",
            message: `Screenshot capture mode '${input.mode}' is not supported.`,
          } satisfies DesktopCaptureScreenshotResult;
        }

        switch (environment.platform) {
          case "win32":
            return yield* captureWindowsInteractive(shell, windowsOptions);
          case "darwin":
            return yield* captureMacosInteractive(
              {
                environment,
                fileSystem,
                path,
                spawner,
              },
              macosCaptureTimeout,
              macosStaleCaptureMaxAge,
            );
          default:
            return {
              status: "unsupported",
              message: "Interactive screenshot capture is not supported on this platform yet.",
            } satisfies DesktopCaptureScreenshotResult;
        }
      }),
  });
});

export const layerWithOptions = (options?: DesktopScreenCaptureOptions) =>
  Layer.effect(DesktopScreenCapture, make(options));

export const layer = layerWithOptions();
