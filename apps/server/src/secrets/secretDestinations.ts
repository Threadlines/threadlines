/**
 * Where a key an agent asked for lands (docs/design/secret-requests.md,
 * "Uses"): a `NAME=value` line in a git-ignored env file in the thread's
 * folder, or a private file for the agent's commands under
 * `<state>/agent-secrets/<threadKey>/<requestId>/value`. Threadlines keeps no
 * other copy. Every error here is fixed text or names a path, never a value.
 *
 * The env file is bound to real paths when the agent asks and checked again
 * at the write, and always replaced by rename, so a link is never written
 * through and the file is never half-written. The `commands` folders are
 * created owner-only (an ACL on Windows, where `chmod` does nothing) and every
 * create and remove is checked to stay inside `agent-secrets`.
 */
import { constants as FsConstants } from "node:fs";
import * as Crypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type { OrchestrationSecretRequest, ThreadId } from "@threadlines/contracts";
import {
  COMMANDS_SECRET_TTL_MS,
  envFilePathProblem,
  scanEnvFile,
  writeEnvLine,
} from "@threadlines/shared/secretRequests";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** Runs git in a folder: its exit code and output, or null when git couldn't run. */
export type RunGit = (
  cwd: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
} | null>;

/** A destination that can't take the key, said for the agent or the card. */
export class SecretDestinationError extends Data.TaggedError("SecretDestinationError")<{
  readonly detail: string;
}> {}

/** A file system call that failed; its cause names paths, never a value. */
class FsCallError extends Data.TaggedError("FsCallError")<{ readonly cause: unknown }> {}

const fail = (detail: string) => Effect.fail(new SecretDestinationError({ detail }));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS_FILE_NAME = "value";
/** Under git's own folder: where an env save's temp file goes in a repository. */
const GIT_TEMP_DIR = "threadlines-secret-saves";

/** The folder name for a thread's keys: a hash, since a thread id can be any text. */
export const threadKeyOf = (threadId: ThreadId | string): string =>
  Crypto.createHash("sha256").update(String(threadId)).digest("hex").slice(0, 32);

/** Inside `root` (or root itself is not allowed), by real path. */
const isInside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const isInsideOrSame = (root: string, candidate: string): boolean =>
  candidate === root || isInside(root, candidate);

const tryPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FsCallError({ cause }) });

const realPath = (path: string) => tryPromise(() => NodeFs.realpath(path)).pipe(Effect.option);

const lstatOrNull = (path: string) =>
  tryPromise(() => NodeFs.lstat(path)).pipe(Effect.orElseSucceed(() => null));

/**
 * What is at `path` without following a link there: its stat, `null` when
 * nothing is (ENOENT), or a failure for anything else, so "can't look" is
 * never read as "gone".
 */
const lstatStrict = (path: string) =>
  tryPromise(() => NodeFs.lstat(path)).pipe(
    Effect.map((stat): Awaited<ReturnType<typeof NodeFs.lstat>> | null => stat),
    Effect.catch((error) =>
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? Effect.succeed(null)
        : Effect.fail(error),
    ),
  );

/** A real folder, not a link to one. */
const isPlainFolder = (stat: Awaited<ReturnType<typeof NodeFs.lstat>> | null) =>
  stat !== null && stat.isDirectory() && !stat.isSymbolicLink();

/** What an env request is bound to when the agent asks. */
export interface CheckedEnvFile {
  readonly folder: string;
  readonly parent: string;
  /** The file already sets this name, so Save replaces it. */
  readonly replaces: boolean;
}

/** The env file's text, or why it can't be read as text. */
const readEnvText = (target: string, path: string) =>
  Effect.gen(function* () {
    const bytes = yield* tryPromise(() => NodeFs.readFile(target)).pipe(
      Effect.catch((error) =>
        (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
          ? Effect.succeed(null)
          : fail(`${path} couldn't be read on this computer.`),
      ),
    );
    if (bytes === null) return "";
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return yield* fail(`${path} isn't UTF-8 text, so Threadlines can't edit it safely.`);
    }
  });

export interface SecretDestinationsOptions {
  readonly agentSecretsDir: string;
  readonly runGit: RunGit;
  readonly platform?: NodeJS.Platform;
}

export function makeSecretDestinations(options: SecretDestinationsOptions) {
  const platform = options.platform ?? process.platform;
  const root = options.agentSecretsDir;
  let readyRoot: string | undefined;

  /** The env file's path, its parent and folder as real paths, checked against `bound` when given. */
  const resolveEnv = (
    threadFolder: string,
    path: string,
    bound?: { readonly folder: string; readonly parent: string },
  ) =>
    Effect.gen(function* () {
      const problem = envFilePathProblem(path);
      if (problem !== null) return yield* fail(problem);
      const folder = yield* realPath(threadFolder);
      if (folder._tag === "None") {
        return yield* fail("This thread's folder isn't on this computer anymore.");
      }
      if (bound !== undefined && folder.value !== bound.folder) {
        return yield* fail("This thread's folder changed since the agent asked.");
      }
      const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
      const base = segments.at(-1) ?? path;
      const parent = yield* realPath(NodePath.join(folder.value, ...segments.slice(0, -1)));
      if (parent._tag === "None") {
        return yield* fail(`The folder for ${path} doesn't exist in this thread's folder.`);
      }
      if (!isInsideOrSame(folder.value, parent.value)) {
        return yield* fail(`${path} isn't inside this thread's folder.`);
      }
      if (bound !== undefined && parent.value !== bound.parent) {
        return yield* fail(`The folder for ${path} changed since the agent asked.`);
      }
      const target = NodePath.join(parent.value, base);
      const stat = yield* lstatOrNull(target);
      if (stat !== null && !stat.isFile()) {
        return yield* fail(
          `${path} isn't a plain file (it's a link or a folder), so nothing was saved.`,
        );
      }
      return { folder: folder.value, parent: parent.value, base, target };
    });

  /**
   * In a repository the file must be ignored and not tracked; outside one,
   * anything goes. Asked in the file's own folder, so a repository nested in
   * the thread's folder counts; any answer but "not a repository" refuses.
   * Says whether the file is in a repository.
   */
  const checkGit = (folder: string, parent: string, base: string, path: string) =>
    Effect.gen(function* () {
      // A repository around the thread's folder may track the file even when
      // a repository nested inside it ignores it.
      const outer = yield* options.runGit(folder, ["ls-files", "--error-unmatch", "--", path]);
      if (outer !== null && outer.code === 0) {
        return yield* fail(
          `${path} is tracked by git here, so a key in it would be committed. Use an ignored file like .env.local.`,
        );
      }
      const inside = yield* options.runGit(parent, ["rev-parse", "--is-inside-work-tree"]);
      if (inside === null) return yield* fail("Git didn't answer on this computer.");
      if (inside.code !== 0) {
        // Only git's plain "no repository anywhere up from here"; a broken
        // checkout (a .git file pointing nowhere) refuses instead.
        if (/not a git repository \(or any of the parent directories\)/i.test(inside.stderr)) {
          return false;
        }
        return yield* fail(
          `Git couldn't check whether ${path} is in a repository, so nothing was saved.`,
        );
      }
      if (inside.stdout.trim() !== "true") {
        return yield* fail(`${path} isn't in a working folder git can check.`);
      }
      const tracked = yield* options.runGit(parent, ["ls-files", "--error-unmatch", "--", base]);
      if (tracked === null) return yield* fail("Git didn't answer on this computer.");
      if (tracked.code === 0) {
        return yield* fail(
          `${path} is tracked by git here, so a key in it would be committed. Use an ignored file like .env.local.`,
        );
      }
      const ignored = yield* options.runGit(parent, ["check-ignore", "-q", "--", base]);
      if (ignored === null) return yield* fail("Git didn't answer on this computer.");
      if (ignored.code !== 0) {
        return yield* fail(
          `${path} isn't ignored by git here. Add it to .gitignore, then ask again.`,
        );
      }
      return true;
    });

  /** Checks an env request when the agent asks, and binds it to the real folders. */
  const checkEnvFile = (input: {
    readonly threadFolder: string;
    readonly path: string;
    readonly name: string;
  }): Effect.Effect<CheckedEnvFile, SecretDestinationError> =>
    Effect.gen(function* () {
      const resolved = yield* resolveEnv(input.threadFolder, input.path);
      yield* checkGit(resolved.folder, resolved.parent, resolved.base, input.path);
      const text = yield* readEnvText(resolved.target, input.path);
      const scan = scanEnvFile(text, input.name, input.path);
      if (!scan.ok) return yield* fail(scan.detail);
      return { folder: resolved.folder, parent: resolved.parent, replaces: scan.line !== null };
    });

  /**
   * Where a save of this request writes its temp file. In a repository it is
   * inside git's own folder, which no `git add` (a checkpoint's included)
   * ever picks up, whatever `.gitignore` says; outside one, beside the file.
   * Either way on the file's own volume, so the rename stays atomic.
   */
  const envTempPath = (request: OrchestrationSecretRequest, inRepo: boolean) =>
    Effect.gen(function* () {
      if (request.use.kind !== "env_file" || request.parent === undefined) return null;
      const parent = request.parent;
      const base = request.use.path.split(/[\\/]/).findLast((segment) => segment.length > 0);
      if (base === undefined) return null;
      if (!inRepo) return NodePath.join(parent, `.${base}.${request.requestId}.tmp`);
      const gitPath = yield* options.runGit(parent, ["rev-parse", "--git-path", GIT_TEMP_DIR]);
      if (gitPath === null || gitPath.code !== 0 || gitPath.stdout.trim().length === 0) {
        return null;
      }
      return NodePath.join(
        NodePath.resolve(parent, gitPath.stdout.trim()),
        `${request.requestId}.tmp`,
      );
    });

  const sameFile = (
    a: Awaited<ReturnType<typeof NodeFs.stat>> | null,
    b: Awaited<ReturnType<typeof NodeFs.stat>> | null,
  ) =>
    a === null || b === null
      ? a === b
      : a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;

  /** One attempt: read, build, write the temp file, check nothing moved, rename. */
  const writeEnvOnce = (
    target: string,
    tempPath: string,
    name: string,
    written: string,
    path: string,
  ) =>
    Effect.gen(function* () {
      const before = yield* lstatOrNull(target);
      if (before !== null && !before.isFile()) {
        return yield* fail(
          `${path} isn't a plain file (it's a link or a folder), so nothing was saved.`,
        );
      }
      const text = yield* readEnvText(target, path);
      const next = writeEnvLine(text, name, written, path);
      if (!next.ok) return yield* fail(next.detail);
      yield* tryPromise(async () => {
        const handle = await NodeFs.open(
          tempPath,
          FsConstants.O_CREAT | FsConstants.O_EXCL | FsConstants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(next.text, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }).pipe(
        Effect.mapError(
          () => new SecretDestinationError({ detail: `${path} couldn't be written.` }),
        ),
      );
      const after = yield* lstatOrNull(target);
      if (!sameFile(before, after)) return "changed" as const;
      // The folder it lands in is still the one the request is bound to.
      const parentNow = yield* realPath(NodePath.dirname(target));
      if (parentNow._tag === "None" || parentNow.value !== NodePath.dirname(target)) {
        return yield* fail(`The folder for ${path} changed while saving. Nothing was saved.`);
      }
      yield* tryPromise(() => NodeFs.rename(tempPath, target)).pipe(
        Effect.mapError(
          () => new SecretDestinationError({ detail: `${path} couldn't be written.` }),
        ),
      );
      // The new file keeps the old one's mode: it already held the project's
      // other secrets that way, and the user's tools may rely on it.
      const mode = before === null ? 0o600 : before.mode & 0o777;
      yield* tryPromise(() => NodeFs.chmod(target, mode)).pipe(Effect.ignore);
      return "written" as const;
    }).pipe(
      Effect.ensuring(tryPromise(() => NodeFs.rm(tempPath, { force: true })).pipe(Effect.ignore)),
    );

  /**
   * Writes `written` (checkSecretValue's form) as the request's env line,
   * after checking every binding again. Starts over once if the file changed
   * while saving.
   */
  const writeEnvFile = (input: {
    readonly request: OrchestrationSecretRequest;
    readonly threadFolder: string;
    readonly written: string;
  }): Effect.Effect<void, SecretDestinationError> =>
    Effect.gen(function* () {
      const { request } = input;
      if (
        request.use.kind !== "env_file" ||
        request.folder === undefined ||
        request.parent === undefined
      ) {
        return yield* fail("This request isn't for an env file.");
      }
      const path = request.use.path;
      const resolved = yield* resolveEnv(input.threadFolder, path, {
        folder: request.folder,
        parent: request.parent,
      });
      const inRepo = yield* checkGit(resolved.folder, resolved.parent, resolved.base, path);
      const tempPath = yield* envTempPath(request, inRepo);
      if (tempPath === null) return yield* fail(`${path} couldn't be written.`);
      yield* tryPromise(() =>
        NodeFs.mkdir(NodePath.dirname(tempPath), { recursive: true, mode: 0o700 }),
      ).pipe(
        Effect.mapError(
          () => new SecretDestinationError({ detail: `${path} couldn't be written.` }),
        ),
      );
      // Not a link to somewhere a checkpoint could stage the copy from.
      if (!isPlainFolder(yield* lstatOrNull(NodePath.dirname(tempPath)))) {
        return yield* fail(`${path} couldn't be written safely here, so nothing was saved.`);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* writeEnvOnce(
          resolved.target,
          tempPath,
          request.name,
          input.written,
          path,
        );
        if (result === "written") return;
      }
      return yield* fail("The file changed while saving. Nothing was saved.");
    });

  /** Removes a save's leftover temp file, wherever it was written (startup recovery). */
  const removeEnvTemp = (request: OrchestrationSecretRequest) =>
    Effect.gen(function* () {
      for (const inRepo of [false, true]) {
        const tempPath = yield* envTempPath(request, inRepo);
        if (tempPath !== null) {
          yield* tryPromise(() => NodeFs.rm(tempPath, { force: true })).pipe(Effect.ignore);
        }
      }
    });

  /** Owner-only on every platform; on Windows an ACL, and if that fails, refused. */
  const secureFolder = (folder: string) =>
    Effect.gen(function* () {
      yield* tryPromise(() => NodeFs.mkdir(folder, { recursive: true, mode: 0o700 })).pipe(
        Effect.mapError(
          () =>
            new SecretDestinationError({ detail: "The private folder for keys couldn't be made." }),
        ),
      );
      if (platform !== "win32") {
        yield* tryPromise(() => NodeFs.chmod(folder, 0o700)).pipe(
          Effect.mapError(
            () =>
              new SecretDestinationError({
                detail: "The private folder for keys couldn't be made private.",
              }),
          ),
        );
        return;
      }
      const user = NodeOs.userInfo().username;
      const acl = yield* tryPromise(async () => {
        const { execFile } = await import("node:child_process");
        return new Promise<number | null>((resolve) => {
          execFile(
            "icacls",
            [folder, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
            { windowsHide: true, timeout: 10_000 },
            (error) => resolve(error === null ? 0 : 1),
          );
        });
      }).pipe(Effect.orElseSucceed(() => 1));
      if (acl !== 0) {
        return yield* fail(
          "Threadlines couldn't make a private folder for keys on this computer, so it can't keep one for commands. Ask for an env file instead.",
        );
      }
    });

  /**
   * The `agent-secrets` folder's real path, made owner-only the first time it
   * works. Callers run one at a time (the answer service's lock).
   */
  const ensureRoot = (): Effect.Effect<string, SecretDestinationError> =>
    readyRoot !== undefined
      ? Effect.succeed(readyRoot)
      : Effect.gen(function* () {
          const existing = yield* lstatOrNull(root);
          if (existing !== null && !isPlainFolder(existing)) {
            return yield* fail(
              "The private folder for keys isn't a plain folder, so it isn't used.",
            );
          }
          yield* secureFolder(root);
          const real = yield* realPath(root);
          if (real._tag === "None") {
            return yield* fail("The private folder for keys couldn't be made.");
          }
          readyRoot = real.value;
          return real.value;
        });

  /** Why `commands` keys can't be kept on this computer now, or null. */
  const commandsUnavailable = Effect.suspend(ensureRoot).pipe(
    Effect.as(null),
    Effect.catch((error) => Effect.succeed(error.detail)),
  );

  const requestFolder = (threadId: ThreadId, requestId: string) =>
    NodePath.join(root, threadKeyOf(threadId), requestId);

  /** Where a `commands` key's file is: the path the agent is given. */
  const commandsFilePath = (threadId: ThreadId, requestId: string) =>
    NodePath.join(requestFolder(threadId, requestId), COMMANDS_FILE_NAME);

  /**
   * The real path of `agent-secrets`, only while it is a real folder: a link
   * there would turn every cleanup into deletions somewhere else.
   */
  const trustedRoot = Effect.gen(function* () {
    if (!isPlainFolder(yield* lstatOrNull(root))) return null;
    const real = yield* realPath(root);
    return real._tag === "Some" ? real.value : null;
  });

  /** A folder under `agent-secrets` checked by real path, for a remove. */
  const checkedInsideRoot = (folder: string) =>
    Effect.gen(function* () {
      const realRoot = yield* trustedRoot;
      const real = yield* realPath(folder);
      if (realRoot === null || real._tag === "None") return null;
      return isInside(realRoot, real.value) ? real.value : null;
    });

  /** Writes a `commands` key as typed to its own owner-only file and returns its path. */
  const writeCommandsFile = (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly written: string;
  }): Effect.Effect<string, SecretDestinationError> =>
    Effect.gen(function* () {
      if (!UUID_PATTERN.test(input.requestId)) return yield* fail("This request's id isn't valid.");
      const realRoot = yield* ensureRoot();
      const threadFolder = NodePath.join(realRoot, threadKeyOf(input.threadId));
      // Nothing here may be a link: a chmod or a remove would follow it out.
      const threadStat = yield* lstatOrNull(threadFolder);
      if (threadStat !== null && !threadStat.isDirectory()) {
        return yield* fail("The private folder for this key isn't where it should be.");
      }
      yield* secureFolder(threadFolder);
      const folder = NodePath.join(threadFolder, input.requestId);
      // A save the server stopped in the middle of may have left a partial file.
      if (!(yield* removeFolder(folder))) {
        return yield* fail("The private folder for this key couldn't be cleared.");
      }
      yield* secureFolder(folder);
      const realFolder = yield* realPath(folder);
      if (realFolder._tag === "None" || !isInside(realRoot, realFolder.value)) {
        return yield* fail("The private folder for this key isn't where it should be.");
      }
      const file = NodePath.join(realFolder.value, COMMANDS_FILE_NAME);
      yield* tryPromise(async () => {
        const handle = await NodeFs.open(
          file,
          FsConstants.O_CREAT | FsConstants.O_EXCL | FsConstants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(input.written, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }).pipe(
        // A write that failed partway must not leave part of the key behind.
        Effect.tapError(() => removeFolder(folder)),
        Effect.mapError(
          () => new SecretDestinationError({ detail: "The private file couldn't be written." }),
        ),
      );
      return commandsFilePath(input.threadId, input.requestId);
    });

  /**
   * Removes a folder under `agent-secrets`; true once it is gone. A link is
   * removed itself, never followed; a folder whose real path leads outside
   * `agent-secrets` is left alone and reported as not removed.
   */
  function removeFolder(folder: string): Effect.Effect<boolean> {
    return Effect.gen(function* () {
      const stat = yield* lstatStrict(folder);
      if (stat === null) return true;
      // Whatever is removed sits directly in a real folder inside (or at)
      // `agent-secrets`, never at the end of a link.
      const realRoot = yield* trustedRoot;
      const realParent = yield* realPath(NodePath.dirname(folder));
      if (
        realRoot === null ||
        realParent._tag === "None" ||
        !isInsideOrSame(realRoot, realParent.value) ||
        !isPlainFolder(yield* lstatOrNull(NodePath.dirname(folder)))
      ) {
        return false;
      }
      if (stat.isSymbolicLink()) {
        yield* tryPromise(() => NodeFs.unlink(folder));
      } else {
        const checked = yield* checkedInsideRoot(folder);
        if (checked === null) return false;
        yield* tryPromise(() => NodeFs.rm(checked, { recursive: true, force: true }));
      }
      return (yield* lstatStrict(folder)) === null;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("couldn't remove a private key folder", { cause }).pipe(Effect.as(false)),
      ),
    );
  }

  /** Removes one `commands` key's folder; true once it is gone. */
  const removeCommandsFile = (threadId: ThreadId, requestId: string) =>
    UUID_PATTERN.test(requestId)
      ? removeFolder(requestFolder(threadId, requestId))
      : Effect.succeed(true);

  /** Removes every `commands` key a thread has (archive, delete, the start of a move). */
  const removeThreadFolder = (threadId: ThreadId) =>
    removeFolder(NodePath.join(root, threadKeyOf(threadId)));

  /**
   * Removes every thread's folder but those named (startup): a thread
   * deleted, archived or moved while the server was down, or one it never
   * finished cleaning up, loses its keys now, not a day later.
   */
  const removeThreadFoldersExcept = (keep: ReadonlySet<ThreadId>) =>
    Effect.gen(function* () {
      const kept = new Set([...keep].map((threadId) => threadKeyOf(threadId)));
      if ((yield* trustedRoot) === null) return;
      const threads = yield* tryPromise(() => NodeFs.readdir(root)).pipe(
        Effect.orElseSucceed((): string[] => []),
      );
      for (const threadKey of threads) {
        if (!kept.has(threadKey)) yield* removeFolder(NodePath.join(root, threadKey));
      }
    });

  /**
   * The backstop for orphans: removes every `commands` file older than its
   * lifetime by its own time, and empty folders. Timers set from the
   * threads' state do the on-time removals.
   */
  const sweep = (nowMs: number) =>
    Effect.gen(function* () {
      if ((yield* trustedRoot) === null) return;
      const threads = yield* tryPromise(() => NodeFs.readdir(root)).pipe(
        Effect.orElseSucceed((): string[] => []),
      );
      for (const threadKey of threads) {
        const threadFolder = NodePath.join(root, threadKey);
        // A link in place of a thread's folder is removed, never walked into.
        if (!isPlainFolder(yield* lstatOrNull(threadFolder))) {
          yield* removeFolder(threadFolder);
          continue;
        }
        const requests = yield* tryPromise(() => NodeFs.readdir(threadFolder)).pipe(
          Effect.orElseSucceed((): string[] => []),
        );
        let kept = 0;
        for (const requestId of requests) {
          const folder = NodePath.join(threadFolder, requestId);
          const stat = yield* lstatOrNull(NodePath.join(folder, COMMANDS_FILE_NAME));
          if (stat !== null && nowMs - stat.mtimeMs <= COMMANDS_SECRET_TTL_MS) {
            kept += 1;
            continue;
          }
          yield* removeFolder(folder);
        }
        if (kept === 0) yield* removeFolder(threadFolder);
      }
    });

  return {
    checkEnvFile,
    writeEnvFile,
    removeEnvTemp,
    commandsUnavailable,
    commandsFilePath,
    writeCommandsFile,
    removeCommandsFile,
    removeThreadFolder,
    removeThreadFoldersExcept,
    sweep,
  };
}

export type SecretDestinations = ReturnType<typeof makeSecretDestinations>;
