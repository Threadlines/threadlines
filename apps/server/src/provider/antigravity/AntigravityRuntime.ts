// @effect-diagnostics nodeBuiltinImport:off - streams the download and zip entries to disk
/**
 * AntigravityRuntime — Threadlines' own copy of the Antigravity ACP server.
 * It downloads a release, verifies and unpacks it, and keeps it in a
 * `ManagedRuntimeStore`, which activates it, leases it to running processes
 * and prunes versions nobody uses (the layout and its invariants are
 * described there).
 *
 * A version's folder holds the release's two files next to the store's
 * marker, which also records their names and sizes.
 *
 * @module provider/antigravity/AntigravityRuntime
 */
import { createWriteStream } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import yauzl from "yauzl";

import {
  abortable,
  type ManagedInstallProgress,
  MANAGED_RELEASE_ID_PATTERN,
  managedFsTry,
  managedIoError,
  ManagedRuntimeError,
  managedRuntimeError,
  type ManagedVersion,
  makeManagedRuntimeStore,
  statIfExists,
} from "../managedRuntime/ManagedRuntimeStore.ts";
import { makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import { type DownloadFetch, downloadVerified } from "../managedRuntime/VerifiedDownload.ts";
import {
  ANTIGRAVITY_DOWNLOAD_HOST,
  type AntigravityListedRelease,
  type AntigravityPlatformRelease,
  type AntigravityReleaseAsset,
  type AntigravityReleaseFile,
  antigravityReleaseId,
} from "./AntigravityRelease.ts";

export interface AntigravityRuntimePaths {
  readonly executable: string;
  readonly harness: string;
}

export interface AntigravityInstalledRuntime extends AntigravityRuntimePaths {
  readonly releaseId: string;
  readonly version: string;
}

export type AntigravityInstallProgress = ManagedInstallProgress;

/** The part of `fetch` the runtime uses; tests pass a stub. */
export type AntigravityFetch = DownloadFetch;

/**
 * Downloads from Google's download host only, on every redirect hop too, so
 * a release can't be fetched from anywhere else whatever the server answers.
 */
export const makeAntigravityDownloadFetch = (): AntigravityFetch =>
  makeHttpsFetch({ publicAddressesOnly: true, allowedHosts: [ANTIGRAVITY_DOWNLOAD_HOST] });

export interface AntigravityRuntimeOptions<ValidateError = never> {
  /** Directory the runtime owns, e.g. `<baseDir>/tools/agy/<assetKey>`. */
  readonly root: string;
  /**
   * Proves unpacked files are `release` and work (the ACP `initialize`
   * handshake). It must stop every process it starts before it returns:
   * Windows cannot move a directory holding a running program.
   */
  readonly validate: (
    paths: AntigravityRuntimePaths,
    release: AntigravityPlatformRelease,
  ) => Effect.Effect<void, ValidateError>;
  readonly fetch?: AntigravityFetch;
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
   * leave it alone. Launch from the returned paths.
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
const ARCHIVE_FILE = "a.zip";

const ReleaseId = Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN));
/** A flat file name: no separators, not `.` or `..`. */
const FlatFileName = Schema.String.check(Schema.isPattern(/^(?!\.\.?$)[\w.-]+$/u));
const ReleaseFileSchema = Schema.Struct({ name: FlatFileName, bytes: Schema.Int });
const InstallMarker = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: ReleaseFileSchema,
  harness: ReleaseFileSchema,
});
type InstallMarker = typeof InstallMarker.Type;
const InstallMarkerJson = Schema.fromJsonString(InstallMarker);
const decodeInstallMarker = Schema.decodeUnknownOption(InstallMarkerJson);
const encodeInstallMarker = Schema.encodeSync(InstallMarkerJson);

const MESSAGES = {
  archive: "The Antigravity download wasn't in the expected format, so nothing was installed.",
  validate: "Antigravity was downloaded but didn't start correctly.",
} as const;

const runtimeError = managedRuntimeError;

/** The error for a machine with no Antigravity build. */
export const unsupportedAntigravityPlatform = (platform: NodeJS.Platform, arch: string) =>
  runtimeError("unsupportedPlatform", `Antigravity isn't available for ${platform} on ${arch}.`);

const ioError = (action: string, cause: unknown) => managedIoError(LABEL, action, cause);
const fsTry = <A>(action: string, run: () => Promise<A>) => managedFsTry(LABEL, action, run);

const pathsOf = (version: ManagedVersion<InstallMarker>): AntigravityRuntimePaths => ({
  executable: NodePath.join(version.dir, version.marker.executable.name),
  harness: NodePath.join(version.dir, version.marker.harness.name),
});

const installedRuntimeOf = (
  version: ManagedVersion<InstallMarker>,
): AntigravityInstalledRuntime => ({
  releaseId: version.releaseId,
  version: version.version,
  ...pathsOf(version),
});

/** Both files are there with the sizes the marker recorded. */
async function filesIntact(versionDir: string, marker: InstallMarker): Promise<boolean> {
  const [executableStat, harnessStat] = await Promise.all([
    statIfExists(NodePath.join(versionDir, marker.executable.name)),
    statIfExists(NodePath.join(versionDir, marker.harness.name)),
  ]);
  return (
    executableStat?.isFile() === true &&
    executableStat.size === marker.executable.bytes &&
    harnessStat?.isFile() === true &&
    harnessStat.size === marker.harness.bytes
  );
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const UNIX_HOSTS = new Set([3, 19]);

/** Why a zip entry is not the expected regular file, or undefined when it is. */
function entryProblem(
  entry: yauzl.Entry,
  file: AntigravityReleaseFile | undefined,
): string | undefined {
  if (!file) return `unexpected entry "${entry.fileName}"`;
  if (entry.isEncrypted()) return `${file.name} is encrypted`;
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    return `${file.name} uses compression method ${entry.compressionMethod}`;
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  const notRegular =
    (entry.externalFileAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0 ||
    (UNIX_HOSTS.has(entry.versionMadeBy >>> 8) &&
      unixMode !== 0 &&
      (unixMode & S_IFMT) !== S_IFREG);
  if (notRegular) return `${file.name} is not a regular file`;
  if (entry.uncompressedSize !== file.bytes) {
    return `${file.name} is ${entry.uncompressedSize} bytes, expected ${file.bytes}`;
  }
  return undefined;
}

/**
 * Unpacks the two expected files into `outDir`. The archive must hold exactly
 * those entries, by exact name, so nothing can land outside `outDir`.
 */
async function extractArchive(input: {
  readonly archivePath: string;
  readonly outDir: string;
  readonly asset: AntigravityReleaseAsset;
  readonly signal: AbortSignal;
}): Promise<void> {
  const malformed = (detail: string, cause?: unknown) =>
    runtimeError("archive", MESSAGES.archive, cause === undefined ? { detail } : { detail, cause });
  const expected = new Map(
    [input.asset.executable, input.asset.harness].map((file) => [file.name, file] as const),
  );
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(input.archivePath, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch (cause) {
    throw malformed("not a readable zip", cause);
  }
  try {
    if (zip.entryCount !== expected.size) {
      throw malformed(`${zip.entryCount} entries, expected ${expected.size}`);
    }
    const entries = new Map<string, yauzl.Entry>();
    try {
      for await (const entry of zip.eachEntry()) {
        const problem = entries.has(entry.fileName)
          ? `duplicate entry "${entry.fileName}"`
          : entryProblem(entry, expected.get(entry.fileName));
        if (problem) throw malformed(problem);
        entries.set(entry.fileName, entry);
      }
    } catch (cause) {
      if (cause instanceof ManagedRuntimeError) throw cause;
      throw malformed("unreadable entry list", cause);
    }
    for (const file of expected.values()) {
      const entry = entries.get(file.name);
      if (!entry) throw malformed(`missing ${file.name}`);
      const target = NodePath.join(input.outDir, file.name);
      const source = await zip.openReadStreamPromise(entry).catch((cause: unknown) => {
        throw malformed(`unreadable ${file.name}`, cause);
      });
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          try {
            for await (const chunk of chunks) yield chunk;
          } catch (cause) {
            throw malformed(`corrupt ${file.name}`, cause);
          }
        },
        createWriteStream(target, { flags: "wx", mode: 0o700 }),
        { signal: input.signal },
      );
      if (process.platform !== "win32") await NodeFS.chmod(target, 0o755);
      const written = await NodeFS.stat(target);
      if (written.size !== file.bytes) {
        throw malformed(`${file.name} unpacked to ${written.size} bytes, expected ${file.bytes}`);
      }
    }
  } finally {
    zip.close();
  }
}

// ── A listed release's sizes ─────────────────────────────────────────

/** Far above any real build (the largest 1.5.2 zip is 274 MB). */
const MAX_LISTED_ARCHIVE_BYTES = 2 * 1024 ** 3;
const MAX_LISTED_FILE_BYTES = 4 * 1024 ** 3;
const LISTED_INDEX_TIMEOUT_MS = 60_000;

/**
 * Bytes `start` to `end` (exclusive) of `url`, and the file's total size when
 * the server names it. Reads no more than asked for, whatever the server sends.
 */
async function readRange(
  fetchRange: AntigravityFetch,
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly total: number | undefined }> {
  const response = await fetchRange(url, {
    headers: { range: `bytes=${start}-${end - 1}`, "accept-encoding": "identity" },
    redirect: "follow",
    signal,
  });
  if (response.status !== 206 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${url} answered a range request with ${response.status}`);
  }
  const wanted = end - start;
  const bytes = new Uint8Array(wanted);
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > wanted) {
        throw new Error(`asked ${url} for ${wanted} bytes, got more`);
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (received !== wanted) throw new Error(`asked ${url} for ${wanted} bytes, got ${received}`);
  const total = /\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")?.[1];
  return { bytes, total: total === undefined ? undefined : Number(total) };
}

/** Reads byte ranges of a zip on a server, so its index can be read without the download. */
class RangeReader extends yauzl.RandomAccessReader {
  private readonly url: string;
  private readonly fetchRange: AntigravityFetch;
  private readonly signal: AbortSignal;

  constructor(url: string, fetchRange: AntigravityFetch, signal: AbortSignal) {
    super();
    this.url = url;
    this.fetchRange = fetchRange;
    this.signal = signal;
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    if (end <= start) {
      out.end();
      return out;
    }
    readRange(this.fetchRange, this.url, start, end, this.signal).then(
      (range) => out.end(range.bytes),
      (cause: unknown) => out.destroy(cause instanceof Error ? cause : new Error(String(cause))),
    );
    return out;
  }
}

/**
 * A listed release with its sizes, so its install is checked exactly like
 * the built-in release's: the zip's length from Google's server, and each
 * file's from the zip's own index, read with a few small range requests
 * rather than the whole download. What the sizes come from is checked again
 * by the install: the zip must hash to the sha256 the registry lists and
 * unpack to these sizes.
 */
export const resolveAntigravityListedRelease = (input: {
  readonly listed: AntigravityListedRelease;
  /** The two file names the zip must hold (`AntigravityReleaseAsset`). */
  readonly executableName: string;
  readonly harnessName: string;
  readonly fetch?: AntigravityFetch;
}): Effect.Effect<AntigravityPlatformRelease, ManagedRuntimeError> => {
  const fetchRange: AntigravityFetch = input.fetch ?? makeAntigravityDownloadFetch();
  const { listed } = input;
  const unreachable = runtimeError(
    "download",
    `Couldn't reach Google to download Antigravity ${listed.version}. Check your internet connection and try again.`,
  );
  const malformed = (detail: string) =>
    runtimeError("archive", MESSAGES.archive, { detail: `${listed.url}: ${detail}` });
  return abortable(
    async (signal) => {
      const timeout = AbortSignal.timeout(LISTED_INDEX_TIMEOUT_MS);
      const both = AbortSignal.any([signal, timeout]);
      // The first byte, for the zip's size (`Content-Range: bytes 0-0/<size>`).
      const first = await readRange(fetchRange, listed.url, 0, 1, both).catch((cause: unknown) => {
        throw runtimeError("download", unreachable.message, { cause });
      });
      const archiveBytes = first.total ?? Number.NaN;
      if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
        throw malformed("the server gave no size");
      }
      if (archiveBytes > MAX_LISTED_ARCHIVE_BYTES) throw malformed(`${archiveBytes} bytes`);
      const reader = new RangeReader(listed.url, fetchRange, both);
      let zip: yauzl.ZipFile;
      try {
        zip = await yauzl.fromRandomAccessReaderPromise(reader, archiveBytes, {
          autoClose: false,
          lazyEntries: true,
          strictFileNames: true,
          validateEntrySizes: true,
        });
      } catch (cause) {
        throw runtimeError("archive", MESSAGES.archive, {
          detail: `${listed.url}: unreadable index`,
          cause,
        });
      }
      try {
        const sizes = new Map<string, number>();
        for await (const entry of zip.eachEntry()) {
          if (sizes.has(entry.fileName)) throw malformed(`duplicate entry "${entry.fileName}"`);
          sizes.set(entry.fileName, entry.uncompressedSize);
        }
        const names = [input.executableName, input.harnessName];
        if (sizes.size !== 2 || names.some((name) => !sizes.has(name))) {
          throw malformed(`holds ${[...sizes.keys()].join(", ")}, expected ${names.join(", ")}`);
        }
        const fileOf = (name: string) => {
          const bytes = sizes.get(name)!;
          if (bytes <= 0 || bytes > MAX_LISTED_FILE_BYTES)
            throw malformed(`${name} is ${bytes} bytes`);
          return { name, bytes };
        };
        return {
          version: listed.version,
          asset: {
            url: listed.url,
            sha256: listed.sha256,
            archiveBytes,
            executable: fileOf(input.executableName),
            harness: fileOf(input.harnessName),
          },
        };
      } finally {
        zip.close();
        reader.close(() => undefined);
      }
    },
    (cause) => runtimeError("download", unreachable.message, { cause }),
  );
};

/** Builds the runtime for one root. Cheap; holds no resources. */
export function makeAntigravityRuntime<ValidateError = never>(
  options: AntigravityRuntimeOptions<ValidateError>,
): AntigravityRuntime {
  const fetchArchive: AntigravityFetch = options.fetch ?? makeAntigravityDownloadFetch();
  const store = makeManagedRuntimeStore<InstallMarker>({
    root: options.root,
    label: LABEL,
    marker: {
      decode: (raw) => Option.getOrUndefined(decodeInstallMarker(raw)),
      encode: encodeInstallMarker,
    },
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

  /** Downloads the zip into the staging folder and unpacks its two files. */
  const build =
    (release: AntigravityPlatformRelease, report: (progress: AntigravityInstallProgress) => void) =>
    (staging: { readonly dir: string; readonly unpackDir: string }) =>
      Effect.gen(function* () {
        const { asset } = release;
        const archivePath = NodePath.join(staging.dir, ARCHIVE_FILE);

        report({ phase: "downloading", receivedBytes: 0, totalBytes: asset.archiveBytes });
        let reportedPercent = 0;
        yield* abortable(
          (signal) =>
            downloadVerified({
              fetch: fetchArchive,
              label: LABEL,
              url: asset.url,
              sha256: asset.sha256,
              bytes: asset.archiveBytes,
              destination: archivePath,
              signal,
              onReceived: (receivedBytes) => {
                const percent = Math.floor((receivedBytes * 100) / asset.archiveBytes);
                if (percent === reportedPercent) return;
                reportedPercent = percent;
                report({ phase: "downloading", receivedBytes, totalBytes: asset.archiveBytes });
              },
            }),
          (cause) => ioError("save the Antigravity download", cause),
        );

        report({ phase: "extracting" });
        yield* abortable(
          (signal) => extractArchive({ archivePath, outDir: staging.unpackDir, asset, signal }),
          (cause) => ioError("save Antigravity's files", cause),
        );
        yield* fsTry("save Antigravity's files", () => NodeFS.rm(archivePath, { force: true }));
        return {
          releaseId: antigravityReleaseId(asset),
          version: release.version,
          executable: { name: asset.executable.name, bytes: asset.executable.bytes },
          harness: { name: asset.harness.name, bytes: asset.harness.bytes },
        };
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
    return store.install({
      releaseId: antigravityReleaseId(asset),
      version: release.version,
      neededBytes: asset.archiveBytes + asset.executable.bytes + asset.harness.bytes,
      build: build(release, report),
      validate: (version) => validatePaths(pathsOf(version), release),
      onPhase: (phase) => report({ phase }),
    });
  };

  return {
    installed: store.installed.pipe(
      Effect.map((version) => (version ? installedRuntimeOf(version) : undefined)),
    ),
    install,
    acquire: store.acquire.pipe(Effect.map(installedRuntimeOf)),
    prune: store.prune,
    remove: store.remove,
  };
}
