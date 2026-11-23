// @effect-diagnostics nodeBuiltinImport:off - moves the download and its unpacked file on disk
/**
 * AntigravityRuntime — Threadlines' own copy of Google's Antigravity CLI.
 * It downloads a release, verifies and unpacks it, and keeps it in a
 * `ManagedRuntimeStore`, which activates it, leases it to running processes
 * and prunes versions nobody uses (the layout and its invariants are
 * described there).
 *
 * A version's folder holds one executable next to the store's marker, which
 * records its name and size. The executable is made read-only (on macOS and
 * Linux), so the CLI can't update itself in place; the folder stays
 * writable, since the store keeps its leases there.
 *
 * Installs from before the move to the CLI (Google's `agy_acp_server` and
 * its harness) are still recognized, as `legacy`: they show as installed so
 * the row offers Update, keep their leases while an old process runs, and
 * are pruned once the CLI is active and nothing runs on them. They never
 * start a session.
 *
 * @module provider/antigravity/AntigravityRuntime
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ArchiveError, extractArchive } from "../managedRuntime/ArchiveExtractor.ts";
import { makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import {
  abortable,
  type ManagedInstallProgress,
  MANAGED_RELEASE_ID_PATTERN,
  managedFsTry,
  managedIoError,
  type ManagedRuntimeError,
  managedRuntimeError,
  type ManagedVersion,
  makeManagedRuntimeStore,
  statIfExists,
} from "../managedRuntime/ManagedRuntimeStore.ts";
import { type DownloadFetch, downloadVerified } from "../managedRuntime/VerifiedDownload.ts";
import {
  ANTIGRAVITY_DOWNLOAD_HOST,
  type AntigravityPlatformRelease,
  antigravityReleaseId,
} from "./AntigravityRelease.ts";

export interface AntigravityRuntimePaths {
  readonly executable: string;
}

export interface AntigravityInstalledRuntime extends AntigravityRuntimePaths {
  readonly releaseId: string;
  readonly version: string;
  /** `legacy`: Google's old ACP server, installed before the move to the CLI. It never runs. */
  readonly kind: "cli" | "legacy";
}

export type AntigravityInstallProgress = ManagedInstallProgress;

/** The part of `fetch` the runtime uses; tests pass a stub. */
export type AntigravityFetch = DownloadFetch;

/**
 * Downloads from Google's storage host only, on every redirect hop too, so
 * a release can't be fetched from anywhere else whatever the server answers.
 */
export const makeAntigravityDownloadFetch = (): AntigravityFetch =>
  makeHttpsFetch({ publicAddressesOnly: true, allowedHosts: [ANTIGRAVITY_DOWNLOAD_HOST] });

export interface AntigravityRuntimeOptions<ValidateError = never> {
  /** Directory the runtime owns, e.g. `<baseDir>/tools/agy/<assetKey>`. */
  readonly root: string;
  /**
   * Proves an unpacked executable is `release` and works (the ACP
   * `initialize` handshake). It must stop every process it starts before it
   * returns: Windows cannot move a directory holding a running program.
   */
  readonly validate: (
    paths: AntigravityRuntimePaths,
    release: AntigravityPlatformRelease,
  ) => Effect.Effect<void, ValidateError>;
  readonly fetch?: AntigravityFetch;
  /** Test seam: the system the files are made read-only for. */
  readonly platform?: NodeJS.Platform;
  /** Test seam: runs in `acquire` after the active version is resolved, before its lease is written. */
  readonly beforeLeaseWritten?: (versionDir: string) => Effect.Effect<void>;
}

export interface AntigravityRuntime {
  /** The active version, if it is complete on disk. Never fails. */
  readonly installed: Effect.Effect<AntigravityInstalledRuntime | undefined>;
  /**
   * Installs and activates `release`, then prunes. A complete copy already
   * on disk is validated again and reused. Interruptible until the final
   * activation.
   */
  readonly install: (
    release: AntigravityPlatformRelease,
    onProgress?: (progress: AntigravityInstallProgress) => void,
  ) => Effect.Effect<{ readonly releaseId: string; readonly version: string }, ManagedRuntimeError>;
  /**
   * Leases the active version until the scope closes, so prune and remove
   * leave it alone. Launch from the returned path. A legacy install is
   * refused (`notInstalled`): it needs the update first.
   */
  readonly acquire: Effect.Effect<AntigravityInstalledRuntime, ManagedRuntimeError, Scope.Scope>;
  /**
   * Deletes versions nobody leases, and leftovers. Best effort. Skipped while
   * an install runs, since the install prunes when it finishes.
   */
  readonly prune: Effect.Effect<void>;
  /** Deletes everything under `root`. Refuses while any version is leased; interrupt a running install first. */
  readonly remove: Effect.Effect<void, ManagedRuntimeError>;
}

const LABEL = "Antigravity";
const ARCHIVE_FILE = "a.download";
const UNPACK_SCRATCH = "x";
/**
 * Caps for a release the feed lists without sizes, far above any real build
 * (1.5.14: the largest download is 239 MB, the largest executable 273 MB).
 */
export const MAX_ANTIGRAVITY_DOWNLOAD_BYTES = 768 * 1024 ** 2;
export const MAX_ANTIGRAVITY_EXECUTABLE_BYTES = 1024 ** 3;
/**
 * What the free-space check budgets for such a release: half again the
 * largest 1.5.14 build. The caps above still stop anything bigger, and a disk
 * that fills anyway fails the install cleanly.
 */
const ESTIMATED_DOWNLOAD_BYTES = 360 * 1024 ** 2;
const ESTIMATED_EXECUTABLE_BYTES = 420 * 1024 ** 2;

const ReleaseId = Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN));
/** A flat file name: no separators, not `.` or `..`. */
const FlatFileName = Schema.String.check(Schema.isPattern(/^(?!\.\.?$)[\w.-]+$/u));
const ReleaseFileSchema = Schema.Struct({ name: FlatFileName, bytes: Schema.Int });
const CliMarker = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  kind: Schema.Literal("cli"),
  executable: ReleaseFileSchema,
});
/** What an install of the old ACP server wrote. Read, never written. */
const LegacyMarker = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: ReleaseFileSchema,
  harness: ReleaseFileSchema,
});
type CliMarker = typeof CliMarker.Type;
type InstallMarker = CliMarker | (typeof LegacyMarker.Type & { readonly kind: "legacy" });
const decodeCliMarker = Schema.decodeUnknownOption(Schema.fromJsonString(CliMarker));
const decodeLegacyMarker = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyMarker));
const encodeCliMarker = Schema.encodeSync(Schema.fromJsonString(CliMarker));
const encodeLegacyMarker = Schema.encodeSync(Schema.fromJsonString(LegacyMarker));

const decodeInstallMarker = (raw: string): InstallMarker | undefined => {
  const cli = decodeCliMarker(raw);
  if (Option.isSome(cli)) return cli.value;
  const legacy = decodeLegacyMarker(raw);
  return Option.isSome(legacy) ? { ...legacy.value, kind: "legacy" } : undefined;
};

const encodeInstallMarker = (marker: InstallMarker): string => {
  if (marker.kind === "cli") return encodeCliMarker(marker);
  const { kind: _kind, ...legacy } = marker;
  return encodeLegacyMarker(legacy);
};

const MESSAGES = {
  archive: "The Antigravity download wasn't in the expected format, so nothing was installed.",
  validate: "Antigravity was downloaded but didn't start correctly.",
  legacy: "This Antigravity predates Google's CLI. Update it in Settings to keep using it.",
} as const;

const runtimeError = managedRuntimeError;

/** The error for a machine with no Antigravity build. */
export const unsupportedAntigravityPlatform = (platform: NodeJS.Platform, arch: string) =>
  runtimeError("unsupportedPlatform", `Antigravity isn't available for ${platform} on ${arch}.`);

const ioError = (action: string, cause: unknown) => managedIoError(LABEL, action, cause);
const fsTry = <A>(action: string, run: () => Promise<A>) => managedFsTry(LABEL, action, run);

const installedRuntimeOf = (
  version: ManagedVersion<InstallMarker>,
): AntigravityInstalledRuntime => ({
  releaseId: version.releaseId,
  version: version.version,
  executable: NodePath.join(version.dir, version.marker.executable.name),
  kind: version.marker.kind,
});

const fileIntact = async (path: string, bytes: number) => {
  const stat = await statIfExists(path);
  return stat?.isFile() === true && stat.size === bytes;
};

/** The files the marker names are there with the sizes it recorded. */
async function filesIntact(versionDir: string, marker: InstallMarker): Promise<boolean> {
  const checks = [
    fileIntact(NodePath.join(versionDir, marker.executable.name), marker.executable.bytes),
  ];
  if (marker.kind === "legacy") {
    checks.push(fileIntact(NodePath.join(versionDir, marker.harness.name), marker.harness.bytes));
  }
  return (await Promise.all(checks)).every(Boolean);
}

/**
 * Unpacks the tarball's one executable to `target`. The archive must hold
 * exactly one entry, a regular file named `name` within the size limit;
 * the shared extractor refuses links and paths that leave its folder.
 */
async function unpackTarball(input: {
  readonly archivePath: string;
  readonly scratchDir: string;
  readonly name: string;
  readonly expectedBytes: number | undefined;
  readonly target: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const malformed = (detail: string, cause?: unknown) =>
    runtimeError("archive", MESSAGES.archive, cause === undefined ? { detail } : { detail, cause });
  await NodeFS.mkdir(input.scratchDir, { mode: 0o700 });
  try {
    await extractArchive({
      archivePath: input.archivePath,
      kind: "tar.gz",
      outDir: input.scratchDir,
      signal: input.signal,
      limits: { maxBytes: input.expectedBytes ?? MAX_ANTIGRAVITY_EXECUTABLE_BYTES, maxEntries: 1 },
    });
  } catch (cause) {
    if (cause instanceof ArchiveError) throw malformed(cause.message, cause);
    throw cause;
  }
  const entries = await NodeFS.readdir(input.scratchDir);
  if (entries.length !== 1 || entries[0] !== input.name) {
    throw malformed(`holds ${entries.join(", ") || "nothing"}, expected ${input.name}`);
  }
  const unpacked = NodePath.join(input.scratchDir, input.name);
  const stat = await NodeFS.lstat(unpacked);
  if (!stat.isFile()) throw malformed(`${input.name} is not a regular file`);
  if (stat.size === 0) throw malformed(`${input.name} is empty`);
  if (input.expectedBytes !== undefined && stat.size !== input.expectedBytes) {
    throw malformed(`${input.name} is ${stat.size} bytes, expected ${input.expectedBytes}`);
  }
  await NodeFS.rename(unpacked, input.target);
  return stat.size;
}

/** Builds the runtime for one root. Cheap; holds no resources. */
export function makeAntigravityRuntime<ValidateError = never>(
  options: AntigravityRuntimeOptions<ValidateError>,
): AntigravityRuntime {
  const fetchArchive: AntigravityFetch = options.fetch ?? makeAntigravityDownloadFetch();
  const platform = options.platform ?? process.platform;
  const store = makeManagedRuntimeStore<InstallMarker>({
    root: options.root,
    label: LABEL,
    marker: { decode: decodeInstallMarker, encode: encodeInstallMarker },
    intact: filesIntact,
    ...(options.beforeLeaseWritten ? { beforeLeaseWritten: options.beforeLeaseWritten } : {}),
  });

  const validatePaths = (paths: AntigravityRuntimePaths, release: AntigravityPlatformRelease) =>
    options.validate(paths, release).pipe(
      Effect.mapError((cause) =>
        runtimeError("validate", MESSAGES.validate, {
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      ),
    );

  /** Downloads into the staging folder and puts the executable in place. */
  const build =
    (release: AntigravityPlatformRelease, report: (progress: AntigravityInstallProgress) => void) =>
    (staging: { readonly dir: string; readonly unpackDir: string }) =>
      Effect.gen(function* () {
        const { asset } = release;
        const archivePath = NodePath.join(staging.dir, ARCHIVE_FILE);
        const totalBytes = asset.archiveBytes;

        report({ phase: "downloading", receivedBytes: 0, ...(totalBytes ? { totalBytes } : {}) });
        let reported = 0;
        const receivedBytes = yield* abortable(
          (signal) =>
            downloadVerified({
              fetch: fetchArchive,
              label: LABEL,
              url: asset.url,
              sha512: asset.sha512,
              ...(asset.archiveBytes !== undefined
                ? { bytes: asset.archiveBytes }
                : { maxBytes: MAX_ANTIGRAVITY_DOWNLOAD_BYTES }),
              destination: archivePath,
              signal,
              onReceived: (received) => {
                // A percent when the size is known, else every 4 MB.
                const step = totalBytes
                  ? Math.floor((received * 100) / totalBytes)
                  : Math.floor(received / (4 * 1024 ** 2));
                if (step === reported) return;
                reported = step;
                report({
                  phase: "downloading",
                  receivedBytes: received,
                  ...(totalBytes ? { totalBytes } : {}),
                });
              },
            }),
          (cause) => ioError("save the Antigravity download", cause),
        );

        report({ phase: "extracting" });
        const target = NodePath.join(staging.unpackDir, asset.executable.name);
        const executableBytes =
          asset.format === "exe"
            ? yield* fsTry("save Antigravity's files", async () => {
                await NodeFS.rename(archivePath, target);
                return receivedBytes;
              })
            : yield* abortable(
                (signal) =>
                  unpackTarball({
                    archivePath,
                    scratchDir: NodePath.join(staging.dir, UNPACK_SCRATCH),
                    name: asset.executable.name,
                    expectedBytes: asset.executable.bytes,
                    target,
                    signal,
                  }),
                (cause) => ioError("save Antigravity's files", cause),
              );
        if (asset.format === "exe" && asset.executable.bytes !== undefined) {
          // The download's size was checked already; this names it as the executable's.
          if (executableBytes !== asset.executable.bytes) {
            return yield* runtimeError("archive", MESSAGES.archive, {
              detail: `${asset.executable.name} is ${executableBytes} bytes, expected ${asset.executable.bytes}`,
            });
          }
        }
        yield* fsTry("save Antigravity's files", async () => {
          await NodeFS.rm(archivePath, { force: true });
          // Read-only, so the CLI can't replace itself. Windows keeps the
          // default: a read-only file there can't be deleted by a prune.
          if (platform !== "win32") await NodeFS.chmod(target, 0o555);
        });
        return {
          releaseId: antigravityReleaseId(asset),
          version: release.version,
          kind: "cli" as const,
          executable: { name: asset.executable.name, bytes: executableBytes },
        } satisfies CliMarker;
      });

  const install: AntigravityRuntime["install"] = (release, onProgress) => {
    const { asset } = release;
    const report = (progress: AntigravityInstallProgress) => {
      try {
        onProgress?.(progress);
      } catch {
        // Progress reporting never fails an install.
      }
    };
    const downloadBytes = asset.archiveBytes ?? ESTIMATED_DOWNLOAD_BYTES;
    // A tarball sits beside what it unpacks to; the Windows download is the executable.
    const neededBytes =
      asset.format === "exe"
        ? downloadBytes
        : downloadBytes + (asset.executable.bytes ?? ESTIMATED_EXECUTABLE_BYTES);
    return store.install({
      releaseId: antigravityReleaseId(asset),
      version: release.version,
      neededBytes,
      build: build(release, report),
      validate: (version) => validatePaths(installedRuntimeOf(version), release),
      onPhase: (phase) => report({ phase }),
    });
  };

  return {
    installed: store.installed.pipe(
      Effect.map((version) => (version ? installedRuntimeOf(version) : undefined)),
    ),
    install,
    acquire: store.acquire.pipe(
      Effect.flatMap((version) =>
        version.marker.kind === "legacy"
          ? Effect.fail(runtimeError("notInstalled", MESSAGES.legacy))
          : Effect.succeed(installedRuntimeOf(version)),
      ),
    ),
    prune: store.prune,
    remove: store.remove,
  };
}
