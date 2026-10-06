// @effect-diagnostics nodeBuiltinImport:off - renames, leases and staging folders on disk
/**
 * ManagedRuntimeStore — the folder of versions behind a program Threadlines
 * installs itself (Antigravity's ACP server, the Node.js for npm agents). It
 * activates a version, leases it to running processes and prunes versions
 * nobody uses. How a version's files get there (download, unpack, `npm
 * install`) is the caller's `build`.
 *
 * Layout under `root` (short names keep Windows paths under MAX_PATH):
 *
 *     active.json                    { releaseId, version } of the version to run
 *     versions/<releaseId>/          the version's files and .install-complete.json
 *     versions/<releaseId>/.leases/  one `<pid>-<random>` file per user
 *     versions/.staging-<random>     a build or file write in progress
 *     versions/.trash-<random>/      a retired version being deleted
 *
 * Invariants:
 * - A version directory appears only by renaming a fully built, validated
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
 * @module provider/managedRuntime/ManagedRuntimeStore
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export type ManagedRuntimeErrorReason =
  | "unsupportedPlatform"
  | "notInstalled"
  | "diskFull"
  | "download"
  | "checksum"
  | "archive"
  | "validate"
  | "io";

export class ManagedRuntimeError extends Data.TaggedError("ManagedRuntimeError")<{
  readonly reason: ManagedRuntimeErrorReason;
  /** Plain language, safe to show a user. */
  readonly message: string;
  /** What went wrong, for logs. */
  readonly detail?: string;
  readonly cause?: unknown;
}> {}

export const managedRuntimeError = (
  reason: ManagedRuntimeErrorReason,
  message: string,
  extra: { readonly detail?: string; readonly cause?: unknown } = {},
) => new ManagedRuntimeError({ reason, message, ...extra });

/** What every version's `.install-complete.json` records, whatever else the caller adds. */
export interface ManagedVersionMarker {
  readonly releaseId: string;
  readonly version: string;
}

/** A complete version on disk. */
export interface ManagedVersion<Marker extends ManagedVersionMarker> {
  readonly releaseId: string;
  readonly version: string;
  /** The version's folder. Holds its files, the marker and `.leases`. */
  readonly dir: string;
  readonly marker: Marker;
}

/** How far an install is, for a progress line. Byte counts come with `downloading`. */
export interface ManagedInstallProgress {
  readonly phase: "downloading" | "extracting" | "validating" | "activating";
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
}

/** Where a build puts a version's files. */
export interface ManagedStaging {
  /** Scratch space (a downloaded archive), deleted when the install ends. */
  readonly dir: string;
  /** New and empty; becomes the version's folder. */
  readonly unpackDir: string;
}

export interface ManagedInstallInput<Marker extends ManagedVersionMarker> {
  /** Sixteen lowercase hex digits: names the version's folder. */
  readonly releaseId: string;
  readonly version: string;
  /** Free disk space the build needs, checked (with a margin) before it starts. */
  readonly neededBytes: number;
  /**
   * Puts the version's files into `staging.unpackDir` and returns its marker.
   * Skipped when a complete copy is already on disk. When interrupted, it
   * must have stopped writing before it returns (see `abortable`).
   */
  readonly build: (staging: ManagedStaging) => Effect.Effect<Marker, ManagedRuntimeError>;
  /**
   * Proves a complete version works, before it is activated: the staged
   * copy, or the one already on disk. It must stop every process it starts
   * before it returns: Windows cannot move a directory holding a running
   * program.
   */
  readonly validate: (version: ManagedVersion<Marker>) => Effect.Effect<void, ManagedRuntimeError>;
  readonly onPhase?: (phase: "validating" | "activating") => void;
}

export interface ManagedRuntimeStoreOptions<Marker extends ManagedVersionMarker> {
  /** Directory the store owns, e.g. `<baseDir>/tools/agy/<assetKey>`. */
  readonly root: string;
  /** The program's name as users know it ("Antigravity"), for messages. */
  readonly label: string;
  /** How a marker is read and written. `decode` returns undefined for anything it doesn't recognise. */
  readonly marker: {
    readonly decode: (raw: string) => Marker | undefined;
    readonly encode: (marker: Marker) => string;
  };
  /** Whether the files a marker describes are still there. A version that fails this isn't installed. */
  readonly intact: (versionDir: string, marker: Marker) => Promise<boolean>;
  /** Test seam: runs in `acquire` after the active version is resolved, before its lease is written. */
  readonly beforeLeaseWritten?: (versionDir: string) => Effect.Effect<void>;
}

export interface ManagedRuntimeStore<Marker extends ManagedVersionMarker> {
  /** The active version, if it is complete on disk. Never fails. */
  readonly installed: Effect.Effect<ManagedVersion<Marker> | undefined>;
  /**
   * Installs and activates a version, then prunes. A complete copy already
   * on disk is validated again and reused. Interruptible until the final
   * activation.
   */
  readonly install: (
    input: ManagedInstallInput<Marker>,
  ) => Effect.Effect<{ readonly releaseId: string; readonly version: string }, ManagedRuntimeError>;
  /**
   * Leases the active version until the scope closes, so prune and remove
   * leave it alone. Launch from the returned folder.
   */
  readonly acquire: Effect.Effect<ManagedVersion<Marker>, ManagedRuntimeError, Scope.Scope>;
  /**
   * Deletes versions nobody leases, and leftovers. Best effort. Skipped while
   * an install runs, since the install prunes when it finishes.
   */
  readonly prune: Effect.Effect<void>;
  /** Deletes everything under `root`. Refuses while any version is leased; interrupt a running install first. */
  readonly remove: Effect.Effect<void, ManagedRuntimeError>;
}

const VERSIONS_DIR = "versions";
const ACTIVE_FILE = "active.json";
const MARKER_FILE = ".install-complete.json";
const LEASES_DIR = ".leases";
const STAGING_PREFIX = ".staging-";
const TRASH_PREFIX = ".trash-";
const UNPACK_DIR = "r";
const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const STALE_STAGING_MS = 60 * 60 * 1000;
const ACQUIRE_ATTEMPTS = 3;
const INSTALL_ATTEMPTS = 3;
export const MANAGED_RELEASE_ID_PATTERN = /^[0-9a-f]{16}$/u;
const LEASE_NAME_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]+$/u;

const ActivePointer = Schema.Struct({
  releaseId: Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN)),
  version: Schema.String,
});
const ActivePointerJson = Schema.fromJsonString(ActivePointer);
const decodeActivePointer = Schema.decodeUnknownOption(ActivePointerJson);
const encodeActivePointer = Schema.encodeSync(ActivePointerJson);

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
export const managedIoError = (label: string, action: string, cause: unknown) => {
  const code = errnoCode(cause);
  return code === "ENOSPC" || code === "EDQUOT"
    ? managedRuntimeError(
        "diskFull",
        `The disk filled up while installing ${label}. Free up some space and try again.`,
        { cause },
      )
    : managedRuntimeError("io", `Couldn't ${action} (${describeCause(cause)}).`, { cause });
};

/** Runs a filesystem step; `action` finishes the sentence "Couldn't …". */
export const managedFsTry = <A>(label: string, action: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => managedIoError(label, action, cause) });

/**
 * Runs `run` with an abort signal. Interrupting aborts it and waits for it to
 * settle, so no stream is still writing when cleanup deletes its files.
 */
export const abortable = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  onError: (cause: unknown) => ManagedRuntimeError,
): Effect.Effect<A, ManagedRuntimeError> =>
  Effect.callback<A, ManagedRuntimeError>((resume) => {
    const controller = new AbortController();
    const settled = run(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause) => resume(Effect.fail(cause instanceof ManagedRuntimeError ? cause : onError(cause))),
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

/** `stat`, or undefined when nothing is there. */
export async function statIfExists(path: string) {
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
 * Lease names this process holds, across every store in it. A lease named
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

/** Builds the store for one root. Cheap; holds no resources. */
export function makeManagedRuntimeStore<Marker extends ManagedVersionMarker>(
  options: ManagedRuntimeStoreOptions<Marker>,
): ManagedRuntimeStore<Marker> {
  const { root, label } = options;
  const versionsDir = NodePath.join(root, VERSIONS_DIR);
  // Whole install / prune / remove operations.
  const operationLock = Semaphore.makeUnsafe(1);
  // Short sections that read the layout and change it based on what they saw.
  const layoutLock = Semaphore.makeUnsafe(1);

  const MESSAGES = {
    notInstalled: `${label} isn't installed yet.`,
    inUse: `${label} is still running in an open session. Stop the session and try again.`,
    churn: `${label}'s files kept changing while Threadlines was using them. Try again.`,
  } as const;
  const fsTry = <A>(action: string, run: () => Promise<A>) => managedFsTry(label, action, run);

  /**
   * Atomic rename. Windows virus scanners and indexers briefly lock new files,
   * so a lock error is retried. Windows also reports a directory rename onto an
   * existing one as EPERM, so unless `to` is a file being replaced, that is
   * only retried while the target is still free.
   */
  const renamePath = (
    from: string,
    to: string,
    renameOptions?: { readonly replacesFile?: boolean },
  ) =>
    Effect.tryPromise({
      try: () => NodeFS.rename(from, to),
      catch: (cause) => managedIoError(label, `move ${label}'s files`, cause),
    }).pipe(
      Effect.retry({
        times: 10,
        schedule: Schedule.spaced("100 millis"),
        while: (error) =>
          isTransientRenameError(error.cause) &&
          (renameOptions?.replacesFile === true || !existsSync(to)),
      }),
    );

  /** The version in `versionDir` if its marker is there and its files are intact. */
  const readCompleteVersion = async (
    versionDir: string,
    releaseId: string,
  ): Promise<ManagedVersion<Marker> | undefined> => {
    const raw = await readFileIfExists(NodePath.join(versionDir, MARKER_FILE));
    const marker = raw === undefined ? undefined : options.marker.decode(raw);
    if (!marker || marker.releaseId !== releaseId) return undefined;
    return (await options.intact(versionDir, marker))
      ? { releaseId, version: marker.version, dir: versionDir, marker }
      : undefined;
  };

  const readActive = Effect.promise(() => readActivePointer(root).catch(() => undefined));
  const readComplete = (versionDir: string, id: string) =>
    Effect.promise(() => readCompleteVersion(versionDir, id).catch(() => undefined));
  const liveLeases = (versionDir: string) =>
    Effect.promise(() => countLiveLeases(versionDir).catch(() => 1));
  const releaseDirOf = (releaseId: string) => NodePath.join(versionsDir, releaseId);

  const installed: ManagedRuntimeStore<Marker>["installed"] = Effect.gen(function* () {
    const active = yield* readActive;
    if (!active) return undefined;
    return yield* readComplete(releaseDirOf(active.releaseId), active.releaseId);
  });

  /** Points `active.json` at a release: written beside it, then renamed over it. */
  const writeActive = (releaseId: string, version: string) =>
    Effect.gen(function* () {
      const temp = NodePath.join(versionsDir, `${STAGING_PREFIX}${randomSuffix()}`);
      const contents = encodeActivePointer({ releaseId, version });
      yield* fsTry(`save ${label}'s settings`, () =>
        NodeFS.writeFile(temp, `${contents}\n`, { flag: "wx" }),
      );
      yield* renamePath(temp, NodePath.join(root, ACTIVE_FILE), { replacesFile: true }).pipe(
        Effect.tapError(() => removeQuietly(temp)),
      );
    });

  const activate = (releaseId: string, version: string) =>
    layoutLock.withPermit(writeActive(releaseId, version)).pipe(Effect.uninterruptible);

  /** Moves `dir` into the trash and deletes it unless a live lease is inside. */
  const discard = (dir: string) =>
    Effect.gen(function* () {
      const trash = NodePath.join(versionsDir, `${TRASH_PREFIX}${randomSuffix()}`);
      yield* renamePath(dir, trash);
      if ((yield* liveLeases(trash)) === 0) yield* removeQuietly(trash);
    });

  /**
   * Renames the built directory to `versions/<releaseId>`. If a complete
   * copy is already there, another process won the race and theirs is kept;
   * an incomplete leftover is discarded first.
   */
  const placeRelease = (unpackedDir: string, releaseId: string) =>
    Effect.gen(function* () {
      const releaseDir = releaseDirOf(releaseId);
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
      return yield* managedRuntimeError("io", MESSAGES.churn, {
        detail: `${releaseDir} kept reappearing incomplete`,
      });
    });

  const checkFreeSpace = (neededBytes: number) =>
    Effect.gen(function* () {
      const needed = neededBytes + FREE_SPACE_MARGIN_BYTES;
      const stats = yield* Effect.tryPromise(() => NodeFS.statfs(versionsDir)).pipe(Effect.option);
      if (Option.isNone(stats)) return;
      const free = stats.value.bavail * stats.value.bsize;
      if (free < needed) {
        return yield* managedRuntimeError(
          "diskFull",
          `${label} needs about ${formatSize(needed)} of free disk space to install, and only ${formatSize(free)} is free. Free up some space and try again.`,
        );
      }
    });

  const freshInstall = (input: ManagedInstallInput<Marker>) =>
    Effect.gen(function* () {
      const { releaseId, version } = input;
      yield* fsTry(`create ${label}'s folder`, () =>
        NodeFS.mkdir(versionsDir, { recursive: true }),
      );
      yield* checkFreeSpace(input.neededBytes);
      const staging = yield* Effect.acquireRelease(
        Effect.sync(() => NodePath.join(versionsDir, `${STAGING_PREFIX}${randomSuffix()}`)).pipe(
          Effect.tap((dir) =>
            fsTry(`create ${label}'s folder`, () => NodeFS.mkdir(dir, { mode: 0o700 })),
          ),
        ),
        (dir) => removeQuietly(dir),
      );
      const unpackedDir = NodePath.join(staging, UNPACK_DIR);
      yield* fsTry(`create ${label}'s folder`, () => NodeFS.mkdir(unpackedDir, { mode: 0o700 }));

      const marker = yield* input.build({ dir: staging, unpackDir: unpackedDir });
      yield* fsTry(`save ${label}'s files`, () =>
        NodeFS.writeFile(
          NodePath.join(unpackedDir, MARKER_FILE),
          `${options.marker.encode(marker)}\n`,
          { flag: "wx" },
        ),
      );

      input.onPhase?.("validating");
      yield* input.validate({ releaseId, version, dir: unpackedDir, marker });

      input.onPhase?.("activating");
      const placed = yield* layoutLock
        .withPermit(
          Effect.gen(function* () {
            const placed = yield* placeRelease(unpackedDir, releaseId);
            if (placed === "ours") yield* writeActive(releaseId, version);
            return placed;
          }),
        )
        .pipe(Effect.uninterruptible);
      if (placed === "theirs") {
        const theirs = yield* readComplete(releaseDirOf(releaseId), releaseId);
        if (!theirs) return;
        yield* input.validate(theirs);
        yield* activate(releaseId, version);
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
    }).pipe(Effect.catchCause(logCause(`Couldn't prune a version of ${label}`, { id })));

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
      if (MANAGED_RELEASE_ID_PATTERN.test(name)) {
        if (pruneVersions) yield* pruneVersion(name);
      } else if (name.startsWith(TRASH_PREFIX)) {
        yield* deleteTrash(path, liveLeases(path));
      } else if (name.startsWith(STAGING_PREFIX)) {
        yield* deleteStaleStaging(path);
      }
    }
    yield* deleteRemovedRoots;
  }).pipe(Effect.catchCause(logCause(`Couldn't prune versions of ${label}`, { root })));

  const prune: ManagedRuntimeStore<Marker>["prune"] = operationLock
    .withPermitsIfAvailable(1)(pruneUnlocked)
    .pipe(Effect.asVoid);

  const install: ManagedRuntimeStore<Marker>["install"] = (input) => {
    const { releaseId, version } = input;
    const releaseDir = releaseDirOf(releaseId);
    return operationLock.withPermit(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < INSTALL_ATTEMPTS; attempt += 1) {
          const existing = yield* readComplete(releaseDir, releaseId);
          if (existing) {
            input.onPhase?.("validating");
            yield* input.validate(existing);
            input.onPhase?.("activating");
            yield* activate(releaseId, version);
          } else {
            yield* freshInstall(input);
          }
          // Another process may have pruned it in between; then go again.
          const active = yield* readActive;
          if (active?.releaseId === releaseId && (yield* readComplete(releaseDir, releaseId))) {
            yield* pruneUnlocked;
            return { releaseId, version };
          }
        }
        return yield* managedRuntimeError("io", MESSAGES.churn, {
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
    if (!active) return yield* managedRuntimeError("notInstalled", MESSAGES.notInstalled);
    const versionDir = active.dir;
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
    yield* fsTry(`start ${label}`, async () => {
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
    if (stillActive) return { version: active, leasePath };
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

  const acquire: ManagedRuntimeStore<Marker>["acquire"] = Effect.acquireRelease(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
        const lease = yield* layoutLock.withPermit(placeLease);
        if (lease) return lease;
      }
      return yield* managedRuntimeError("io", MESSAGES.churn, {
        detail: "the active version moved during every lease attempt",
      });
    }),
    (lease) =>
      Effect.promise(async () => {
        await NodeFS.rm(lease.leasePath, { force: true }).catch(() => {});
        heldLeaseNames.delete(NodePath.basename(lease.leasePath));
      }),
  ).pipe(Effect.map((lease) => lease.version));

  /** Renames the whole root aside (the same protocol as pruning a version), then deletes it. */
  const remove: ManagedRuntimeStore<Marker>["remove"] = operationLock.withPermit(
    Effect.gen(function* () {
      const leasedIn = (dir: string) =>
        Effect.promise(() => countLiveLeasesInRoot(dir).catch(() => 1));
      const trash = yield* layoutLock.withPermit(
        Effect.gen(function* () {
          if (!existsSync(root)) return undefined;
          if ((yield* leasedIn(root)) > 0) return yield* managedRuntimeError("io", MESSAGES.inUse);
          const trash = `${root}${TRASH_PREFIX}${randomSuffix()}`;
          yield* renamePath(root, trash);
          if ((yield* leasedIn(trash)) > 0) {
            yield* renamePath(trash, root);
            return yield* managedRuntimeError("io", MESSAGES.inUse);
          }
          return trash;
        }),
      );
      if (trash && !(yield* removeQuietly(trash))) {
        return yield* managedRuntimeError(
          "io",
          `${label} was removed, but some of its files couldn't be deleted.`,
          { detail: trash },
        );
      }
      yield* deleteRemovedRoots;
    }),
  );

  return { installed, install, acquire, prune, remove };
}
