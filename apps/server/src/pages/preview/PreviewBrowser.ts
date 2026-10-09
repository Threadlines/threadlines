// @effect-diagnostics nodeBuiltinImport:off - checks the installed program and lists old versions on disk
/**
 * PreviewBrowser — the one browser page previews run in: a pinned Chrome for
 * Testing headless shell that Threadlines downloads the first time a preview
 * or a measurement needs it. Never a browser the user installed.
 *
 * It lives in a `ManagedRuntimeStore` of its own under
 * `<baseDir>/caches/preview-browser/<version>`, which dev and live servers
 * share. A running browser leases its version, so no server deletes it under
 * another. Once this server installs a version, it drops older ones nobody
 * leases; a server pinned to an older version never touches a newer one.
 *
 * Ported from T3 Code's `preview/PreviewBrowser.ts` (MIT), which shares this
 * repo's ancestry, onto Threadlines' own download, unpack and store modules.
 *
 * To bump the pin, pick a version from
 * https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
 * download each platform's chrome-headless-shell zip, and replace the version
 * and every byte count and SHA-256 below. `unpackedBytes` is the sum of the
 * archive's uncompressed entry sizes.
 *
 * @module pages/preview/PreviewBrowser
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ArchiveError, extractArchive } from "../../provider/managedRuntime/ArchiveExtractor.ts";
import { makeHttpsFetch } from "../../provider/managedRuntime/HttpsFetch.ts";
import {
  abortable,
  MANAGED_RELEASE_ID_PATTERN,
  managedFsTry,
  managedIoError,
  type ManagedRuntimeError,
  managedRuntimeError,
  type ManagedVersion,
  makeManagedRuntimeStore,
  statIfExists,
} from "../../provider/managedRuntime/ManagedRuntimeStore.ts";
import {
  type DownloadFetch,
  downloadVerified,
} from "../../provider/managedRuntime/VerifiedDownload.ts";

export const PREVIEW_BROWSER_VERSION = "154.0.8037.92";

const ARCHIVES = {
  linux64: {
    bytes: 120_477_194,
    sha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
    unpackedBytes: 273_953_147,
  },
  "linux-arm64": {
    bytes: 121_182_296,
    sha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
    unpackedBytes: 279_456_406,
  },
  "mac-arm64": {
    bytes: 99_221_129,
    sha256: "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929",
    unpackedBytes: 205_161_619,
  },
  "mac-x64": {
    bytes: 104_748_425,
    sha256: "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4",
    unpackedBytes: 209_388_579,
  },
  win32: {
    bytes: 114_295_943,
    sha256: "56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7",
    unpackedBytes: 255_498_223,
  },
  win64: {
    bytes: 120_822_223,
    sha256: "3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568",
    unpackedBytes: 284_904_014,
  },
} as const;

const chromePlatform = (platform: NodeJS.Platform, arch: string) => {
  switch (platform) {
    case "linux":
      return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : undefined;
    case "darwin":
      return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : undefined;
    case "win32":
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === "ia32" ? "win32" : arch === "x64" || arch === "arm64" ? "win64" : undefined;
    default:
      return undefined;
  }
};

export interface PreviewBrowserRelease {
  readonly version: string;
  /** Chrome for Testing's platform name, which also names the archive's top folder. */
  readonly platform: string;
  readonly url: string;
  readonly bytes: number;
  /** Lowercase hex. */
  readonly sha256: string;
  /** Size of the files once unpacked, for the free-space check. */
  readonly unpackedBytes: number;
}

/** The pinned release for a host, or undefined where Chrome for Testing builds none. */
export const previewBrowserRelease = (
  platform: NodeJS.Platform,
  arch: string,
): PreviewBrowserRelease | undefined => {
  const chrome = chromePlatform(platform, arch);
  return chrome === undefined
    ? undefined
    : {
        version: PREVIEW_BROWSER_VERSION,
        platform: chrome,
        url: `https://storage.googleapis.com/chrome-for-testing-public/${PREVIEW_BROWSER_VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip`,
        ...ARCHIVES[chrome],
      };
};

/** `<caches>/preview-browser`: one folder per pinned version under it. */
export const previewBrowserDir = (cachesDir: string) => NodePath.join(cachesDir, "preview-browser");

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

export class PagePreviewInstallingError extends Schema.TaggedError<PagePreviewInstallingError>()(
  "PagePreviewInstallingError",
  { downloadedBytes: Schema.Number, totalBytes: Schema.Number, unpacking: Schema.Boolean },
) {
  override get message(): string {
    const progress = this.unpacking
      ? "unpacking"
      : `${megabytes(this.downloadedBytes)} of ${megabytes(this.totalBytes)} MB downloaded`;
    return `Threadlines is installing the browser it previews pages in (${progress}). Try the preview again in about a minute.`;
  }
}

export class PagePreviewUnsupportedError extends Schema.TaggedError<PagePreviewUnsupportedError>()(
  "PagePreviewUnsupportedError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message(): string {
    return `Page previews are not available on ${this.platform}-${this.arch}: Chrome for Testing has no headless browser for it. Publish the page without a preview.`;
  }
}

export class PagePreviewInstallError extends Schema.TaggedError<PagePreviewInstallError>()(
  "PagePreviewInstallError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Threadlines could not install the browser it previews pages in. ${this.detail}`;
  }
}

export type PreviewBrowserError =
  | PagePreviewInstallingError
  | PagePreviewUnsupportedError
  | PagePreviewInstallError;

export interface PreviewBrowser {
  /**
   * Leases the installed browser until the scope closes and returns its
   * executable. Starts the install when there is none and waits for it up to
   * `wait`, then reports its progress instead while it keeps going. A failed
   * install is reported once; the next call tries again.
   */
  readonly acquire: Effect.Effect<string, PreviewBrowserError, Scope.Scope>;
  /**
   * Leases the installed browser until the scope closes, or none when it is
   * not installed. Then it starts the install in the background and never
   * waits for it; after a failure, not again until `retryAfter` has passed.
   */
  readonly acquireInstalled: Effect.Effect<Option.Option<string>, never, Scope.Scope>;
}

export interface PreviewBrowserOptions {
  /** `<baseDir>/caches`. */
  readonly cachesDir: string;
  /** Test seam. Default: this host's pinned release; `null` for a host without one. */
  readonly release?: PreviewBrowserRelease | null;
  /** Test seam. Default: `makeHttpsFetch()`, which honours the environment's proxy. */
  readonly fetch?: DownloadFetch;
  /** How long `acquire` waits on an install. Agents' tool calls give up near 60 seconds. */
  readonly wait?: Duration.Input;
  /** How long after a failed install a background install may start again. */
  readonly retryAfter?: Duration.Input;
  /** Test seam: the system whose names and file modes apply. Default: this one. */
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

const LABEL = "Chrome for Testing";
const ARCHIVE_FILE = "a";
const VERSION_FOLDER = /^(\d+\.\d+\.\d+\.\d+)(?:\.trash-[0-9a-f]+)?$/u;

const BrowserMarker = Schema.Struct({
  releaseId: Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN)),
  version: Schema.String,
  /** Size of the browser program, so a damaged copy isn't taken for installed. */
  executableBytes: Schema.Int,
});
type BrowserMarker = typeof BrowserMarker.Type;
const BrowserMarkerJson = Schema.fromJsonString(BrowserMarker);
const decodeBrowserMarker = Schema.decodeUnknownOption(BrowserMarkerJson);
const encodeBrowserMarker = Schema.encodeSync(BrowserMarkerJson);

/** How long `ManagedRuntimeStore` keeps another install's staging folder: longer than any install runs. */
const STALE_STAGING_MS = 60 * 60 * 1000;
/** The longest an install may run, download and unpack together. */
const INSTALL_TIMEOUT = Duration.minutes(15);

/**
 * Whether the store at `versionRoot` has a staging folder touched since
 * `sinceMs`, counting what is directly inside it: a download in progress
 * changes its file, not the folder.
 */
const installingSince = (versionRoot: string, sinceMs: number) =>
  Effect.promise(async () => {
    const modifiedMs = (path: string) =>
      statIfExists(path).then(
        (info) => info?.mtimeMs ?? Number.NEGATIVE_INFINITY,
        () => Number.NEGATIVE_INFINITY,
      );
    const versionsDir = NodePath.join(versionRoot, "versions");
    const names = await NodeFS.readdir(versionsDir).catch(() => [] as Array<string>);
    for (const name of names) {
      if (!name.startsWith(".staging-")) continue;
      const staging = NodePath.join(versionsDir, name);
      const inside = await NodeFS.readdir(staging).catch(() => [] as Array<string>);
      const times = await Promise.all(
        [staging, ...inside.map((entry) => NodePath.join(staging, entry))].map(modifiedMs),
      );
      if (Math.max(...times) >= sinceMs) return true;
    }
    return false;
  });

/** Negative when dotted version `left` is older than `right`. */
const compareVersions = (left: string, right: string) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const toInstallError = (error: ManagedRuntimeError) =>
  new PagePreviewInstallError({ detail: error.message, cause: error });

type InstallState =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "installing";
      readonly done: Deferred.Deferred<void, PagePreviewInstallError>;
    }
  | { readonly _tag: "failed"; readonly error: PagePreviewInstallError };

export const makePreviewBrowser = Effect.fn("PreviewBrowser.make")(function* (
  options: PreviewBrowserOptions,
) {
  // Installs belong to the service, so they finish even when no caller still waits.
  const serviceScope = yield* Effect.scope;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release =
    options.release === undefined ? previewBrowserRelease(platform, arch) : options.release;
  const wait = options.wait ?? "30 seconds";
  const retryAfterMs = Duration.toMillis(options.retryAfter ?? "15 minutes");
  const fetchArchive = options.fetch ?? makeHttpsFetch();
  const rootDir = previewBrowserDir(options.cachesDir);
  const executableName =
    platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";

  if (!release) {
    const unsupported = new PagePreviewUnsupportedError({ platform, arch });
    return {
      acquire: Effect.fail(unsupported),
      acquireInstalled: Effect.succeedNone,
    } satisfies PreviewBrowser;
  }

  const releaseId = release.sha256.slice(0, 16).toLowerCase();
  const executableIn = (dir: string) => NodePath.join(dir, executableName);
  /** A regular file, and on POSIX one this user may run. */
  const runnable = async (path: string) => {
    const info = await statIfExists(path);
    return info?.isFile() === true && (platform === "win32" || (info.mode & 0o111) !== 0)
      ? info
      : undefined;
  };

  const store = makeManagedRuntimeStore<BrowserMarker>({
    root: NodePath.join(rootDir, release.version),
    label: LABEL,
    marker: {
      decode: (raw) => Option.getOrUndefined(decodeBrowserMarker(raw)),
      encode: encodeBrowserMarker,
    },
    intact: async (dir, marker) =>
      (await runnable(executableIn(dir)).catch(() => undefined))?.size === marker.executableBytes,
  });

  const progress = { downloadedBytes: 0, unpacking: false };

  const build = (staging: { readonly dir: string; readonly unpackDir: string }) =>
    Effect.gen(function* () {
      const archivePath = NodePath.join(staging.dir, ARCHIVE_FILE);
      yield* abortable(
        (signal) =>
          downloadVerified({
            fetch: fetchArchive,
            label: LABEL,
            url: release.url,
            sha256: release.sha256,
            bytes: release.bytes,
            destination: archivePath,
            signal,
            onReceived: (receivedBytes) => {
              progress.downloadedBytes = receivedBytes;
            },
          }),
        (cause) => managedIoError(LABEL, `save the ${LABEL} download`, cause),
      );
      progress.unpacking = true;
      const unexpected = (detail: string, cause?: unknown) =>
        managedRuntimeError(
          "archive",
          `The ${LABEL} download wasn't in the expected format, so nothing was installed.`,
          { detail, cause },
        );
      yield* abortable(
        (signal) =>
          extractArchive({
            archivePath,
            kind: "zip",
            outDir: staging.unpackDir,
            // Everything sits in `chrome-headless-shell-<platform>/`.
            stripComponents: 1,
            platform,
            signal,
          }),
        (cause) =>
          cause instanceof ArchiveError
            ? unexpected(cause.message, cause)
            : managedIoError(LABEL, `save ${LABEL}'s files`, cause),
      );
      yield* managedFsTry(LABEL, `save ${LABEL}'s files`, () =>
        NodeFS.rm(archivePath, { force: true }),
      );
      const executable = yield* managedFsTry(LABEL, `save ${LABEL}'s files`, () =>
        runnable(executableIn(staging.unpackDir)),
      );
      if (!executable) {
        return yield* unexpected(`the archive holds no runnable ${executableName}`);
      }
      return { releaseId, version: release.version, executableBytes: executable.size };
    });

  /** Drops versions older than this one that no running browser leases. Best effort. */
  const dropOlderVersions = Effect.gen(function* () {
    const names = yield* Effect.promise(() =>
      NodeFS.readdir(rootDir).catch(() => [] as Array<string>),
    );
    const older = new Set(
      names.flatMap((name) => {
        const version = VERSION_FOLDER.exec(name)?.[1];
        return version !== undefined && compareVersions(version, release.version) < 0
          ? [version]
          : [];
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const version of older) {
      // Another server may be installing that version right now; an install
      // holds no lease, only its staging folder.
      if (yield* installingSince(NodePath.join(rootDir, version), now - STALE_STAGING_MS)) {
        yield* Effect.logInfo("Kept an older preview browser that is being installed.", {
          version,
        });
        continue;
      }
      // The store's own removal refuses while a browser leases the version,
      // and also clears what an earlier removal left half-deleted.
      yield* makeManagedRuntimeStore<never>({
        root: NodePath.join(rootDir, version),
        label: LABEL,
        marker: { decode: () => undefined, encode: () => "" },
        intact: () => Promise.resolve(false),
      }).remove.pipe(
        Effect.catch((error) =>
          Effect.logInfo("Kept an older preview browser.", { version, reason: error.message }),
        ),
      );
    }
  });

  const install = store
    .install({
      releaseId,
      version: release.version,
      neededBytes: release.bytes + release.unpackedBytes,
      build,
      // Running the browser here would fail on a host that lacks its
      // libraries or sandbox, and a fresh download cannot fix that; a launch
      // reports it instead.
      validate: (version: ManagedVersion<BrowserMarker>) =>
        Effect.promise(() => runnable(executableIn(version.dir)).catch(() => undefined)).pipe(
          Effect.flatMap((info) =>
            info?.size === version.marker.executableBytes
              ? Effect.void
              : Effect.fail(
                  managedRuntimeError("validate", `${LABEL} was downloaded but can't be run.`, {
                    detail: `${executableIn(version.dir)} is missing or not runnable`,
                  }),
                ),
          ),
        ),
    })
    .pipe(
      Effect.andThen(dropOlderVersions),
      Effect.mapError(toInstallError),
      // A download that stalls must not leave every later preview waiting on
      // the same attempt: past this, the install fails and the next call
      // starts over.
      Effect.timeoutOrElse({
        duration: INSTALL_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new PagePreviewInstallError({
              detail: "The download took too long and was stopped. Try again.",
            }),
          ),
      }),
    );

  const gate = yield* Semaphore.make(1);
  let state: InstallState = { _tag: "idle" };
  let lastFailureAt = Number.NEGATIVE_INFINITY;

  /**
   * Joins the install in progress or starts one. In the foreground a failure
   * is reported once and cleared, so the next call starts over; in the
   * background a recent failure holds off another attempt.
   */
  const join = (mode: "foreground" | "background") =>
    gate.withPermit(
      Effect.gen(function* () {
        if (state._tag === "installing") return state;
        const now = yield* Clock.currentTimeMillis;
        if (state._tag === "failed" && mode === "foreground") {
          const failed = state;
          state = { _tag: "idle" };
          return failed;
        }
        if (mode === "background" && now - lastFailureAt < retryAfterMs) return state;
        const done = yield* Deferred.make<void, PagePreviewInstallError>();
        progress.downloadedBytes = 0;
        progress.unpacking = false;
        const installing: InstallState = { _tag: "installing", done };
        state = installing;
        yield* install.pipe(
          Effect.onExit((exit) =>
            gate
              .withPermit(
                Effect.gen(function* () {
                  if (Exit.isSuccess(exit)) {
                    state = { _tag: "idle" };
                    return;
                  }
                  lastFailureAt = yield* Clock.currentTimeMillis;
                  state = {
                    _tag: "failed",
                    error: Option.getOrElse(
                      Cause.findErrorOption(exit.cause),
                      () =>
                        new PagePreviewInstallError({ detail: "The install stopped. Try again." }),
                    ),
                  };
                }),
              )
              .pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("Could not install the page preview browser.", {
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.ignoreCause,
          // Server shutdown closes the service scope and stops an install in progress.
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
        return installing;
      }),
    );

  // A waiter that saw the failure has reported it; the next call starts over.
  const clearFailure = (error: PagePreviewInstallError) =>
    gate.withPermit(
      Effect.sync(() => {
        if (state._tag === "failed" && state.error === error) state = { _tag: "idle" };
      }),
    );

  /** The installed browser, leased for the scope; none when there is none. */
  const lease = store.acquire.pipe(
    Effect.map((version) => Option.some(executableIn(version.dir))),
    Effect.catch((error) =>
      error.reason === "notInstalled" ? Effect.succeedNone : Effect.fail(toInstallError(error)),
    ),
  );

  const acquire: PreviewBrowser["acquire"] = Effect.gen(function* () {
    const installed = yield* lease;
    if (Option.isSome(installed)) return installed.value;
    const current = yield* join("foreground");
    if (current._tag === "failed") return yield* current.error;
    if (current._tag === "installing") {
      yield* Deferred.await(current.done).pipe(
        Effect.tapError(clearFailure),
        Effect.timeoutOrElse({
          duration: wait,
          orElse: () =>
            Effect.fail(
              new PagePreviewInstallingError({
                downloadedBytes: progress.downloadedBytes,
                totalBytes: release.bytes,
                unpacking: progress.unpacking,
              }),
            ),
        }),
      );
    }
    const after = yield* lease;
    if (Option.isSome(after)) return after.value;
    return yield* new PagePreviewInstallError({
      detail: `${LABEL} was installed, then went missing. Try again.`,
    });
  }).pipe(Effect.withSpan("PreviewBrowser.acquire"));

  const acquireInstalled: PreviewBrowser["acquireInstalled"] = Effect.gen(function* () {
    const installed = yield* lease;
    if (Option.isNone(installed)) yield* join("background");
    return installed;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not use the page preview browser.", { reason: error.message }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
    Effect.withSpan("PreviewBrowser.acquireInstalled"),
  );

  return { acquire, acquireInstalled } satisfies PreviewBrowser;
});
