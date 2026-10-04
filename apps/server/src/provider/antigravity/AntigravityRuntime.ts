// @effect-diagnostics nodeBuiltinImport:off - streams the download and zip entries to disk
/**
 * AntigravityRuntime — Threadlines' own copy of the Antigravity ACP server.
 * It downloads the pinned release, verifies and unpacks it, activates it,
 * leases it to running processes and prunes versions nobody uses.
 *
 * Layout under `root` (short names keep Windows paths under MAX_PATH):
 *
 *     active.json                    { releaseId, version } of the version to run
 *     versions/<releaseId>/          the two files and .install-complete.json
 *     versions/<releaseId>/.leases/  one `<pid>-<random>` file per user
 *     versions/.staging-<random>     a download or file write in progress
 *     versions/.trash-<random>/      a retired version being deleted
 *
 * Invariants:
 * - A version directory appears only by renaming a fully unpacked, validated
 *   staging directory into place, so `.install-complete.json` means complete.
 * - `active.json` is replaced atomically and only names a complete version.
 * - A directory is deleted only after it has been renamed out of
 *   `versions/<releaseId>` and a scan of it then finds no live lease. A lease
 *   written after the rename lands in a stray directory and its owner's
 *   re-check fails, so it retries; one written before is found by the scan,
 *   and prune moves the version back.
 * - A lease is live while its pid is. A reused pid keeps a version on disk
 *   longer; it never lets one in use be deleted.
 * - Pruning never touches the active version, nor any version while
 *   `active.json` is unreadable. `remove` retires the whole root the same way.
 *
 * In one process, a semaphore serializes install, prune and remove, and a
 * second keeps lease placement from interleaving with activation and the
 * prune rename. Across processes, the atomic renames and the lease re-check
 * are what keep it safe.
 *
 * @module provider/antigravity/AntigravityRuntime
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { pipeline } from "node:stream/promises";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import yauzl from "yauzl";

import {
  type AntigravityPlatformRelease,
  type AntigravityReleaseAsset,
  type AntigravityReleaseFile,
  antigravityReleaseId,
} from "./AntigravityRelease.ts";

export type AntigravityRuntimeErrorReason =
  | "unsupportedPlatform"
  | "notInstalled"
  | "diskFull"
  | "download"
  | "checksum"
  | "archive"
  | "validate"
  | "io";

export class AntigravityRuntimeError extends Data.TaggedError("AntigravityRuntimeError")<{
  readonly reason: AntigravityRuntimeErrorReason;
  /** Plain language, safe to show a user. */
  readonly message: string;
  /** What went wrong, for logs. */
  readonly detail?: string;
  readonly cause?: unknown;
}> {}

export interface AntigravityRuntimePaths {
  readonly executable: string;
  readonly harness: string;
}

export interface AntigravityInstalledRuntime extends AntigravityRuntimePaths {
  readonly releaseId: string;
  readonly version: string;
}

export interface AntigravityInstallProgress {
  readonly phase: "downloading" | "extracting" | "validating" | "activating";
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
}

/** The part of `fetch` the runtime uses; tests pass a stub. */
export type AntigravityFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AntigravityRuntimeOptions<ValidateError = never> {
  /** Directory the runtime owns, e.g. `<baseDir>/tools/agy/<assetKey>`. */
  readonly root: string;
  readonly release: AntigravityPlatformRelease;
  /**
   * Proves unpacked files work (the ACP `initialize` handshake). It must stop
   * every process it starts before it returns: Windows cannot move a
   * directory holding a running program.
   */
  readonly validate: (paths: AntigravityRuntimePaths) => Effect.Effect<void, ValidateError>;
  readonly fetch?: AntigravityFetch;
  /** Test seam: runs in `acquire` after the active version is resolved, before its lease is written. */
  readonly beforeLeaseWritten?: (versionDir: string) => Effect.Effect<void>;
}

export interface AntigravityRuntime {
  /** The active version, if it is complete on disk. Never fails. */
  readonly installed: Effect.Effect<AntigravityInstalledRuntime | undefined>;
  /**
   * Installs and activates `options.release`, then prunes. A complete copy
   * already on disk is validated again and reused. Interruptible until the
   * final activation.
   */
  readonly install: (
    onProgress?: (progress: AntigravityInstallProgress) => void,
  ) => Effect.Effect<
    { readonly releaseId: string; readonly version: string },
    AntigravityRuntimeError
  >;
  /**
   * Leases the active version until the scope closes, so prune and remove
   * leave it alone. Launch from the returned paths.
   */
  readonly acquire: Effect.Effect<
    AntigravityInstalledRuntime,
    AntigravityRuntimeError,
    Scope.Scope
  >;
  /**
   * Deletes versions nobody leases, and leftovers. Best effort. Skipped while
   * an install runs, since the install prunes when it finishes.
   */
  readonly prune: Effect.Effect<void>;
  /** Deletes everything under `root`. Refuses while any version is leased; interrupt a running install first. */
  readonly remove: Effect.Effect<void, AntigravityRuntimeError>;
}

const VERSIONS_DIR = "versions";
const ACTIVE_FILE = "active.json";
const MARKER_FILE = ".install-complete.json";
const LEASES_DIR = ".leases";
const STAGING_PREFIX = ".staging-";
const TRASH_PREFIX = ".trash-";
const ARCHIVE_FILE = "a.zip";
const UNPACK_DIR = "r";
const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const STALE_STAGING_MS = 60 * 60 * 1000;
const ACQUIRE_ATTEMPTS = 3;
const INSTALL_ATTEMPTS = 3;
const RELEASE_ID_PATTERN = /^[0-9a-f]{16}$/u;
const LEASE_NAME_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]+$/u;

const ReleaseId = Schema.String.check(Schema.isPattern(RELEASE_ID_PATTERN));
/** A flat file name: no separators, not `.` or `..`. */
const FlatFileName = Schema.String.check(Schema.isPattern(/^(?!\.\.?$)[\w.-]+$/u));
const ReleaseFileSchema = Schema.Struct({ name: FlatFileName, bytes: Schema.Int });
const ActivePointer = Schema.Struct({ releaseId: ReleaseId, version: Schema.String });
const InstallMarker = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: ReleaseFileSchema,
  harness: ReleaseFileSchema,
});
const ActivePointerJson = Schema.fromJsonString(ActivePointer);
const InstallMarkerJson = Schema.fromJsonString(InstallMarker);
const decodeActivePointer = Schema.decodeUnknownOption(ActivePointerJson);
const encodeActivePointer = Schema.encodeSync(ActivePointerJson);
const decodeInstallMarker = Schema.decodeUnknownOption(InstallMarkerJson);
const encodeInstallMarker = Schema.encodeSync(InstallMarkerJson);

const MESSAGES = {
  notInstalled: "Antigravity isn't installed yet.",
  download: "Couldn't download Antigravity. Check your internet connection and try again.",
  checksum:
    "The Antigravity download didn't match the expected release, so nothing was installed. Try again in a few minutes.",
  archive: "The Antigravity download wasn't in the expected format, so nothing was installed.",
  validate: "Antigravity was downloaded but didn't start correctly.",
  diskFilled: "The disk filled up while installing Antigravity. Free up some space and try again.",
  inUse: "Antigravity is still running in an open session. Stop the session and try again.",
  churn: "Antigravity's files kept changing while Threadlines was using them. Try again.",
} as const;

const runtimeError = (
  reason: AntigravityRuntimeErrorReason,
  message: string,
  extra: { readonly detail?: string; readonly cause?: unknown } = {},
) => new AntigravityRuntimeError({ reason, message, ...extra });

/** The error for a machine with no Antigravity build. */
export const unsupportedAntigravityPlatform = (platform: NodeJS.Platform, arch: string) =>
  runtimeError("unsupportedPlatform", `Antigravity isn't available for ${platform} on ${arch}.`);

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const isMissing = (cause: unknown) => {
  const code = errnoCode(cause);
  return code === "ENOENT" || code === "ENOTDIR";
};

const describeCause = (cause: unknown): string => {
  switch (errnoCode(cause)) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EBUSY":
      return "a file is in use";
    case "ENOENT":
      return "a file is missing";
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
};

/** A filesystem failure: disk full gets its own reason, everything else is `io`. */
const ioError = (action: string, cause: unknown) => {
  const code = errnoCode(cause);
  return code === "ENOSPC" || code === "EDQUOT"
    ? runtimeError("diskFull", MESSAGES.diskFilled, { cause })
    : runtimeError("io", `Couldn't ${action} (${describeCause(cause)}).`, { cause });
};

const fsTry = <A>(action: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => ioError(action, cause) });

/**
 * Runs `run` with an abort signal. Interrupting aborts it and waits for it to
 * settle, so no stream is still writing when cleanup deletes its files.
 */
const abortable = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  onError: (cause: unknown) => AntigravityRuntimeError,
): Effect.Effect<A, AntigravityRuntimeError> =>
  Effect.callback<A, AntigravityRuntimeError>((resume) => {
    const controller = new AbortController();
    const settled = run(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause) =>
        resume(Effect.fail(cause instanceof AntigravityRuntimeError ? cause : onError(cause))),
    );
    return Effect.promise(() => {
      controller.abort();
      return settled;
    });
  });

const randomSuffix = () => randomBytes(4).toString("hex");

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.ceil(bytes / 1024 ** 2))} MB`;

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await NodeFS.readFile(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
}

async function statIfExists(path: string) {
  try {
    return await NodeFS.stat(path);
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
}

async function readDirIfExists(path: string): Promise<ReadonlyArray<string>> {
  try {
    return await NodeFS.readdir(path);
  } catch (cause) {
    if (isMissing(cause)) return [];
    throw cause;
  }
}

async function readActivePointer(root: string) {
  const raw = await readFileIfExists(NodePath.join(root, ACTIVE_FILE));
  return raw === undefined ? undefined : Option.getOrUndefined(decodeActivePointer(raw));
}

/** The version in `versionDir` if its marker is there and both files have the recorded sizes. */
async function readCompleteVersion(
  versionDir: string,
  releaseId: string,
): Promise<AntigravityInstalledRuntime | undefined> {
  const raw = await readFileIfExists(NodePath.join(versionDir, MARKER_FILE));
  const marker = raw === undefined ? undefined : Option.getOrUndefined(decodeInstallMarker(raw));
  if (!marker || marker.releaseId !== releaseId) return undefined;
  const executable = NodePath.join(versionDir, marker.executable.name);
  const harness = NodePath.join(versionDir, marker.harness.name);
  const [executableStat, harnessStat] = await Promise.all([
    statIfExists(executable),
    statIfExists(harness),
  ]);
  const intact =
    executableStat?.isFile() === true &&
    executableStat.size === marker.executable.bytes &&
    harnessStat?.isFile() === true &&
    harnessStat.size === marker.harness.bytes;
  return intact ? { releaseId, version: marker.version, executable, harness } : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: it exists but belongs to someone else.
    return errnoCode(cause) === "EPERM";
  }
}

/**
 * Lease names this process holds, across every runtime in it. A lease named
 * for this process but not held here (one an acquire gave up on, which
 * another server's prune or remove may have carried off and put back) is
 * dead wherever it turns up.
 */
const heldLeaseNames = new Set<string>();

/**
 * Leases an acquire here gave up on, by path, with when. Another server's
 * prune or remove may have had one renamed aside when it was deleted, and
 * puts it back; to that server it looks live while this process runs. Later
 * lease attempts delete it once it is back, and stop looking after a while.
 */
const rejectedLeases = new Map<string, number>();
const REJECTED_LEASE_WATCH_MS = 10 * 60 * 1000;

/**
 * Live leases in `versionDir`, deleting those whose process is gone. A lease
 * directory that cannot be read counts as leased, so nothing is deleted blind.
 */
async function countLiveLeases(versionDir: string): Promise<number> {
  const leasesDir = NodePath.join(versionDir, LEASES_DIR);
  let names: ReadonlyArray<string>;
  try {
    names = await NodeFS.readdir(leasesDir);
  } catch (cause) {
    return isMissing(cause) ? 0 : 1;
  }
  let live = 0;
  for (const name of names) {
    const match = LEASE_NAME_PATTERN.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid ? heldLeaseNames.has(name) : isProcessAlive(pid)) {
      live += 1;
    } else {
      await NodeFS.rm(NodePath.join(leasesDir, name), { force: true }).catch(() => undefined);
    }
  }
  return live;
}

/** Live leases in every directory under `<rootDir>/versions`. */
async function countLiveLeasesInRoot(rootDir: string): Promise<number> {
  const versionsDir = NodePath.join(rootDir, VERSIONS_DIR);
  let live = 0;
  for (const name of await readDirIfExists(versionsDir)) {
    live += await countLiveLeases(NodePath.join(versionsDir, name));
  }
  return live;
}

/** Newest mtime of `path` and what is under it, `depth` levels down. */
async function newestMtimeMs(path: string, depth: number): Promise<number> {
  const stats = await NodeFS.lstat(path);
  let newest = stats.mtimeMs;
  if (depth > 0 && stats.isDirectory()) {
    for (const name of await NodeFS.readdir(path)) {
      newest = Math.max(newest, await newestMtimeMs(NodePath.join(path, name), depth - 1));
    }
  }
  return newest;
}

const isTransientRenameError = (cause: unknown) => {
  const code = errnoCode(cause);
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
};

/**
 * Atomic rename. Windows virus scanners and indexers briefly lock new files,
 * so a lock error is retried. Windows also reports a directory rename onto an
 * existing one as EPERM, so unless `to` is a file being replaced, that is
 * only retried while the target is still free.
 */
const renamePath = (from: string, to: string, options?: { readonly replacesFile?: boolean }) =>
  Effect.tryPromise({
    try: () => NodeFS.rename(from, to),
    catch: (cause) => ioError("move Antigravity's files", cause),
  }).pipe(
    Effect.retry({
      times: 10,
      schedule: Schedule.spaced("100 millis"),
      while: (error) =>
        isTransientRenameError(error.cause) && (options?.replacesFile === true || !existsSync(to)),
    }),
  );

const removeQuietly = (path: string) =>
  Effect.promise(() =>
    NodeFS.rm(path, { recursive: true, force: true, maxRetries: 3 }).then(
      () => true,
      () => false,
    ),
  );

const logCause =
  (message: string, details: Record<string, unknown>) => (cause: Cause.Cause<unknown>) =>
    Effect.logWarning(message, { ...details, cause: Cause.pretty(cause) });

/**
 * Streams the archive to `archivePath`, hashing as it goes and stopping as
 * soon as it runs past the expected size.
 */
async function downloadArchive(input: {
  readonly fetch: AntigravityFetch;
  readonly asset: AntigravityReleaseAsset;
  readonly archivePath: string;
  readonly signal: AbortSignal;
  readonly onReceived: (receivedBytes: number) => void;
}): Promise<void> {
  const { asset } = input;
  const mismatch = (detail: string) => runtimeError("checksum", MESSAGES.checksum, { detail });
  let response: Response;
  try {
    // dl.google.com gzips when allowed, and then content-length is the
    // compressed size; ask for the bytes as published.
    response = await input.fetch(asset.url, {
      headers: { "accept-encoding": "identity" },
      redirect: "follow",
      signal: input.signal,
    });
  } catch (cause) {
    throw runtimeError("download", MESSAGES.download, { cause });
  }
  if (!response.ok || response.body === null) {
    throw runtimeError(
      "download",
      `The Antigravity download failed (HTTP ${response.status}). Try again in a few minutes.`,
      { detail: `${asset.url} returned ${response.status}` },
    );
  }
  const encoding = response.headers.get("content-encoding");
  const declaredLength = response.headers.get("content-length");
  if (
    (encoding === null || encoding === "identity") &&
    declaredLength !== null &&
    Number(declaredLength) !== asset.archiveBytes
  ) {
    await response.body.cancel().catch(() => undefined);
    throw mismatch(`server declared ${declaredLength} bytes, expected ${asset.archiveBytes}`);
  }

  const hash = createHash("sha256");
  let received = 0;
  await pipeline(
    response.body,
    async function* (source: AsyncIterable<Uint8Array>) {
      try {
        for await (const chunk of source) {
          received += chunk.byteLength;
          if (received > asset.archiveBytes) {
            throw mismatch(`received more than ${asset.archiveBytes} bytes`);
          }
          hash.update(chunk);
          input.onReceived(received);
          yield chunk;
        }
      } catch (cause) {
        if (cause instanceof AntigravityRuntimeError) throw cause;
        throw runtimeError("download", MESSAGES.download, { cause });
      }
    },
    createWriteStream(input.archivePath, { flags: "wx", mode: 0o600 }),
    { signal: input.signal },
  );
  const digest = hash.digest("hex");
  if (received !== asset.archiveBytes || digest !== asset.sha256.toLowerCase()) {
    throw mismatch(`received ${received} bytes with sha256 ${digest}`);
  }
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
      if (cause instanceof AntigravityRuntimeError) throw cause;
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

/** Builds the runtime for one root and release. Cheap; holds no resources. */
export function makeAntigravityRuntime<ValidateError = never>(
  options: AntigravityRuntimeOptions<ValidateError>,
): AntigravityRuntime {
  const { root, release } = options;
  const fetchArchive: AntigravityFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const versionsDir = NodePath.join(root, VERSIONS_DIR);
  const releaseId = antigravityReleaseId(release.asset);
  const releaseDir = NodePath.join(versionsDir, releaseId);
  // Whole install / prune / remove operations.
  const operationLock = Semaphore.makeUnsafe(1);
  // Short sections that read the layout and change it based on what they saw.
  const layoutLock = Semaphore.makeUnsafe(1);

  const readActive = Effect.promise(() => readActivePointer(root).catch(() => undefined));
  const readComplete = (versionDir: string, id: string) =>
    Effect.promise(() => readCompleteVersion(versionDir, id).catch(() => undefined));
  const liveLeases = (versionDir: string) =>
    Effect.promise(() => countLiveLeases(versionDir).catch(() => 1));

  const installed: AntigravityRuntime["installed"] = Effect.gen(function* () {
    const active = yield* readActive;
    if (!active) return undefined;
    return yield* readComplete(NodePath.join(versionsDir, active.releaseId), active.releaseId);
  });

  const validatePaths = (paths: AntigravityRuntimePaths) =>
    options.validate(paths).pipe(
      Effect.mapError((cause) =>
        runtimeError("validate", MESSAGES.validate, {
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      ),
    );

  /** Points `active.json` at this release: written beside it, then renamed over it. */
  const writeActive = Effect.gen(function* () {
    const temp = NodePath.join(versionsDir, `${STAGING_PREFIX}${randomSuffix()}`);
    const contents = encodeActivePointer({ releaseId, version: release.version });
    yield* fsTry("save Antigravity's settings", () =>
      NodeFS.writeFile(temp, `${contents}\n`, { flag: "wx" }),
    );
    yield* renamePath(temp, NodePath.join(root, ACTIVE_FILE), { replacesFile: true }).pipe(
      Effect.tapError(() => removeQuietly(temp)),
    );
  });

  const activate = layoutLock.withPermit(writeActive).pipe(Effect.uninterruptible);

  /** Moves `dir` into the trash and deletes it unless a live lease is inside. */
  const discard = (dir: string) =>
    Effect.gen(function* () {
      const trash = NodePath.join(versionsDir, `${TRASH_PREFIX}${randomSuffix()}`);
      yield* renamePath(dir, trash);
      if ((yield* liveLeases(trash)) === 0) yield* removeQuietly(trash);
    });

  /**
   * Renames the unpacked directory to `versions/<releaseId>`. If a complete
   * copy is already there, another process won the race and theirs is kept;
   * an incomplete leftover is discarded first.
   */
  const placeRelease = (unpackedDir: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const renamed = yield* renamePath(unpackedDir, releaseDir).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            existsSync(releaseDir) ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (renamed) return "ours" as const;
        if (yield* readComplete(releaseDir, releaseId)) return "theirs" as const;
        yield* discard(releaseDir);
      }
      return yield* runtimeError("io", MESSAGES.churn, {
        detail: `${releaseDir} kept reappearing incomplete`,
      });
    });

  const checkFreeSpace = Effect.gen(function* () {
    const { asset } = release;
    const needed =
      asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + FREE_SPACE_MARGIN_BYTES;
    const stats = yield* Effect.tryPromise(() => NodeFS.statfs(versionsDir)).pipe(Effect.option);
    if (Option.isNone(stats)) return;
    const free = stats.value.bavail * stats.value.bsize;
    if (free < needed) {
      return yield* runtimeError(
        "diskFull",
        `Antigravity needs about ${formatSize(needed)} of free disk space to install, and only ${formatSize(free)} is free. Free up some space and try again.`,
      );
    }
  });

  const freshInstall = (report: (progress: AntigravityInstallProgress) => void) =>
    Effect.gen(function* () {
      const { asset } = release;
      yield* fsTry("create Antigravity's folder", () =>
        NodeFS.mkdir(versionsDir, { recursive: true }),
      );
      yield* checkFreeSpace;
      const staging = yield* Effect.acquireRelease(
        Effect.sync(() => NodePath.join(versionsDir, `${STAGING_PREFIX}${randomSuffix()}`)).pipe(
          Effect.tap((dir) =>
            fsTry("create Antigravity's folder", () => NodeFS.mkdir(dir, { mode: 0o700 })),
          ),
        ),
        (dir) => removeQuietly(dir),
      );
      const archivePath = NodePath.join(staging, ARCHIVE_FILE);
      const unpackedDir = NodePath.join(staging, UNPACK_DIR);

      report({ phase: "downloading", receivedBytes: 0, totalBytes: asset.archiveBytes });
      let reportedPercent = 0;
      yield* abortable(
        (signal) =>
          downloadArchive({
            fetch: fetchArchive,
            asset,
            archivePath,
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
      yield* fsTry("create Antigravity's folder", () => NodeFS.mkdir(unpackedDir, { mode: 0o700 }));
      yield* abortable(
        (signal) => extractArchive({ archivePath, outDir: unpackedDir, asset, signal }),
        (cause) => ioError("save Antigravity's files", cause),
      );
      yield* fsTry("save Antigravity's files", () => NodeFS.rm(archivePath, { force: true }));
      const marker = encodeInstallMarker({
        releaseId,
        version: release.version,
        executable: { name: asset.executable.name, bytes: asset.executable.bytes },
        harness: { name: asset.harness.name, bytes: asset.harness.bytes },
      });
      yield* fsTry("save Antigravity's files", () =>
        NodeFS.writeFile(NodePath.join(unpackedDir, MARKER_FILE), `${marker}\n`, { flag: "wx" }),
      );

      report({ phase: "validating" });
      yield* validatePaths({
        executable: NodePath.join(unpackedDir, asset.executable.name),
        harness: NodePath.join(unpackedDir, asset.harness.name),
      });

      report({ phase: "activating" });
      const placed = yield* layoutLock
        .withPermit(
          Effect.gen(function* () {
            const placed = yield* placeRelease(unpackedDir);
            if (placed === "ours") yield* writeActive;
            return placed;
          }),
        )
        .pipe(Effect.uninterruptible);
      if (placed === "theirs") {
        const theirs = yield* readComplete(releaseDir, releaseId);
        if (!theirs) return;
        yield* validatePaths(theirs);
        yield* activate;
      }
    }).pipe(Effect.scoped);

  const deleteStaleStaging = (path: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const newest = yield* Effect.promise(() => newestMtimeMs(path, 2).catch(() => now));
      if (now - newest > STALE_STAGING_MS) yield* removeQuietly(path);
    });

  /** Trash is deleted once nothing leases it, wherever it came from. */
  const deleteTrash = (path: string, leases: Effect.Effect<number>) =>
    Effect.gen(function* () {
      if ((yield* leases) === 0) yield* removeQuietly(path);
    });

  const pruneVersion = (id: string) =>
    Effect.gen(function* () {
      const versionDir = NodePath.join(versionsDir, id);
      const trash = yield* layoutLock.withPermit(
        Effect.gen(function* () {
          // An unreadable pointer (a Windows lock, a half-written file) never
          // makes a version look unused.
          const active = yield* readActive;
          if (active === undefined || active.releaseId === id) return undefined;
          if ((yield* liveLeases(versionDir)) > 0) return undefined;
          const trash = NodePath.join(versionsDir, `${TRASH_PREFIX}${randomSuffix()}`);
          yield* renamePath(versionDir, trash);
          // A lease written just before the rename is inside `trash` now, and
          // its owner may already be using the paths: put the version back.
          const activeAfter = yield* readActive;
          const reclaimed =
            activeAfter === undefined ||
            activeAfter.releaseId === id ||
            (yield* liveLeases(trash)) > 0;
          if (!reclaimed) return trash;
          yield* renamePath(trash, versionDir);
          return undefined;
        }),
      );
      if (trash) yield* removeQuietly(trash);
    }).pipe(Effect.catchCause(logCause("Couldn't prune an Antigravity version", { id })));

  /** Roots renamed aside by a `remove` whose delete was cut short. */
  const deleteRemovedRoots = Effect.gen(function* () {
    const parent = NodePath.dirname(root);
    const prefix = `${NodePath.basename(root)}${TRASH_PREFIX}`;
    for (const name of yield* Effect.promise(() => readDirIfExists(parent).catch(() => []))) {
      if (!name.startsWith(prefix)) continue;
      const path = NodePath.join(parent, name);
      yield* deleteTrash(
        path,
        Effect.promise(() => countLiveLeasesInRoot(path).catch(() => 1)),
      );
    }
  });

  const pruneUnlocked = Effect.gen(function* () {
    // Without a readable active version, no version is known to be unused.
    const pruneVersions = (yield* readActive) !== undefined;
    const names = yield* Effect.promise(() => readDirIfExists(versionsDir).catch(() => []));
    for (const name of names) {
      const path = NodePath.join(versionsDir, name);
      if (RELEASE_ID_PATTERN.test(name)) {
        if (pruneVersions) yield* pruneVersion(name);
      } else if (name.startsWith(TRASH_PREFIX)) {
        yield* deleteTrash(path, liveLeases(path));
      } else if (name.startsWith(STAGING_PREFIX)) {
        yield* deleteStaleStaging(path);
      }
    }
    yield* deleteRemovedRoots;
  }).pipe(Effect.catchCause(logCause("Couldn't prune Antigravity versions", { root })));

  const prune: AntigravityRuntime["prune"] = operationLock
    .withPermitsIfAvailable(1)(pruneUnlocked)
    .pipe(Effect.asVoid);

  const install: AntigravityRuntime["install"] = (onProgress) => {
    const report = (progress: AntigravityInstallProgress) => {
      try {
        onProgress?.(progress);
      } catch {
        // Progress reporting never fails an install.
      }
    };
    return operationLock.withPermit(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < INSTALL_ATTEMPTS; attempt += 1) {
          const existing = yield* readComplete(releaseDir, releaseId);
          if (existing) {
            report({ phase: "validating" });
            yield* validatePaths(existing);
            report({ phase: "activating" });
            yield* activate;
          } else {
            yield* freshInstall(report);
          }
          // Another process may have pruned it in between; then go again.
          const active = yield* readActive;
          if (active?.releaseId === releaseId && (yield* readComplete(releaseDir, releaseId))) {
            yield* pruneUnlocked;
            return { releaseId, version: release.version };
          }
        }
        return yield* runtimeError("io", MESSAGES.churn, {
          detail: `${releaseDir} did not stay active after install`,
        });
      }),
    );
  };

  /**
   * Writes a lease on the active version and checks it held. Undefined means
   * retry. The name counts as held from before the file exists until the
   * attempt gives it up, so no sweep in this process takes it for dead.
   */
  const placeLease = Effect.gen(function* () {
    const active = yield* installed;
    if (!active) return yield* runtimeError("notInstalled", MESSAGES.notInstalled);
    const versionDir = NodePath.join(versionsDir, active.releaseId);
    if (options.beforeLeaseWritten) yield* options.beforeLeaseWritten(versionDir);
    const leasesDir = NodePath.join(versionDir, LEASES_DIR);
    const leaseName = `${process.pid}-${randomSuffix()}`;
    const leasePath = NodePath.join(leasesDir, leaseName);
    heldLeaseNames.add(leaseName);
    yield* Effect.promise(async () => {
      for (const [path, rejectedAt] of rejectedLeases) {
        // A failed delete keeps watching until the window closes.
        if (await statIfExists(path).catch(() => undefined)) {
          const removed = await NodeFS.rm(path, { force: true }).then(
            () => true,
            () => false,
          );
          if (removed) {
            rejectedLeases.delete(path);
            continue;
          }
        }
        if (Date.now() - rejectedAt > REJECTED_LEASE_WATCH_MS) rejectedLeases.delete(path);
      }
    });
    yield* fsTry("start Antigravity", async () => {
      await NodeFS.mkdir(leasesDir, { recursive: true });
      await NodeFS.writeFile(leasePath, "", { flag: "wx" });
    }).pipe(Effect.onError(() => Effect.sync(() => heldLeaseNames.delete(leaseName))));
    // A prune may have moved the version away before the lease landed; then
    // the lease sits in a stray directory and the marker is gone.
    const held = yield* Effect.promise(() =>
      Promise.all([
        statIfExists(NodePath.join(versionDir, MARKER_FILE)),
        statIfExists(leasePath),
      ]).then(
        ([marker, lease]) => marker !== undefined && lease !== undefined,
        () => false,
      ),
    );
    // Prune only takes a version that is no longer active, and reads the
    // pointer after the switch. If the pointer still names this version now,
    // after the lease landed, any prune that could target it sees the lease;
    // across server processes too, where the locks here don't reach.
    const stillActive = held && (yield* readActive)?.releaseId === active.releaseId;
    if (stillActive) return { runtime: active, leasePath };
    // If another server's prune or remove has the lease renamed aside right
    // now, it is dead to this process wherever it ends up (`heldLeaseNames`).
    heldLeaseNames.delete(leaseName);
    rejectedLeases.set(leasePath, Date.now());
    yield* Effect.promise(() => NodeFS.rm(leasePath, { force: true }).catch(() => undefined));
    yield* Effect.promise(async () => {
      // Only empty directories go: the stray this lease created.
      await NodeFS.rmdir(leasesDir).catch(() => undefined);
      await NodeFS.rmdir(versionDir).catch(() => undefined);
    });
    return undefined;
  });

  const acquire: AntigravityRuntime["acquire"] = Effect.acquireRelease(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
        const lease = yield* layoutLock.withPermit(placeLease);
        if (lease) return lease;
      }
      return yield* runtimeError("io", MESSAGES.churn, {
        detail: "the active version moved during every lease attempt",
      });
    }),
    (lease) =>
      Effect.promise(async () => {
        await NodeFS.rm(lease.leasePath, { force: true }).catch(() => {});
        heldLeaseNames.delete(NodePath.basename(lease.leasePath));
      }),
  ).pipe(Effect.map((lease) => lease.runtime));

  /** Renames the whole root aside (the same protocol as pruning a version), then deletes it. */
  const remove: AntigravityRuntime["remove"] = operationLock.withPermit(
    Effect.gen(function* () {
      const leasedIn = (dir: string) =>
        Effect.promise(() => countLiveLeasesInRoot(dir).catch(() => 1));
      const trash = yield* layoutLock.withPermit(
        Effect.gen(function* () {
          if (!existsSync(root)) return undefined;
          if ((yield* leasedIn(root)) > 0) return yield* runtimeError("io", MESSAGES.inUse);
          const trash = `${root}${TRASH_PREFIX}${randomSuffix()}`;
          yield* renamePath(root, trash);
          if ((yield* leasedIn(trash)) > 0) {
            yield* renamePath(trash, root);
            return yield* runtimeError("io", MESSAGES.inUse);
          }
          return trash;
        }),
      );
      if (trash && !(yield* removeQuietly(trash))) {
        return yield* runtimeError(
          "io",
          "Antigravity was removed, but some of its files couldn't be deleted.",
          { detail: trash },
        );
      }
      yield* deleteRemovedRoots;
    }),
  );

  return { installed, install, acquire, prune, remove };
}
