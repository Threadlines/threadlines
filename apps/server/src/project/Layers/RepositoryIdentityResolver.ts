import type { RepositoryIdentity } from "@threadlines/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@threadlines/shared/git";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";

import * as ProcessRunner from "../../processRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

export function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["origin", "upstream"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
/**
 * How long a remembered repository root is reused before git is asked again,
 * even while its `.git` check still passes. A safety net for the changes the
 * check can't see, such as a folder's owner changing or `core.worktree`
 * being set.
 */
const DEFAULT_ROOT_RECHECK_INTERVAL = Duration.minutes(10);

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly rootRecheckInterval?: Duration.Input;
}

/**
 * The entries on disk that decided git's answer for one folder: a `.git` in
 * the top level, and no repository in any folder below it (no `.git`, and no
 * `HEAD`, which marks a bare repository). While each is still as recorded, git
 * would give the same answer, so the answer is reused without starting git.
 */
interface RepositoryRootCheck {
  /** The folder with symlinks resolved, as it was when git was asked. */
  readonly realCwd: string;
  /** The folder and its parents, up to the top level, that held no repository. */
  readonly withoutGit: ReadonlyArray<string>;
  /** The top level, whose `.git` must still exist; null outside a repository. */
  readonly withGit: string | null;
}

/**
 * Which repository root a folder belongs to. `root` keys the identity cache:
 * git's top level, or the folder itself outside a repository. `check` is null
 * when the answer must not be reused: git didn't finish, or the `.git` entries
 * on disk don't explain its answer.
 */
interface RepositoryRootLookup {
  readonly root: string;
  readonly check: RepositoryRootCheck | null;
}

const makeRepositoryRootChecks = Effect.fn("makeRepositoryRootChecks")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Null when the disk can't be read, which counts as a change. */
  const hasEntry = (directory: string, name: ".git" | "HEAD") =>
    fileSystem.exists(path.join(directory, name)).pipe(Effect.orElseSucceed(() => null));

  /** Whether the entries recorded in `check` are all as they were. */
  const stillHolds = Effect.fn("RepositoryRootCheck.stillHolds")(function* (
    cwd: string,
    check: RepositoryRootCheck,
  ) {
    const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
    if (realCwd !== check.realCwd) {
      return false;
    }
    for (const directory of check.withoutGit) {
      if (
        (yield* hasEntry(directory, ".git")) !== false ||
        (yield* hasEntry(directory, "HEAD")) !== false
      ) {
        return false;
      }
    }
    return check.withGit === null || (yield* hasEntry(check.withGit, ".git")) === true;
  });

  /**
   * Records the folders between `cwd` and git's top level, or every parent of
   * `cwd` when git found no repository. Null when the top level is not one of
   * those folders (a symlink git resolved differently) or when the disk
   * disagrees with git right now (a `.git` git skipped, as in a clone still
   * being written), since such an answer can't be confirmed later.
   */
  const record = Effect.fn("RepositoryRootCheck.record")(function* (
    cwd: string,
    topLevel: string | null,
  ) {
    const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
    if (realCwd === null) {
      return null;
    }
    // Git prints `/` on Windows, `C:/repo` and `//server/share/repo`.
    const topLevelHere = topLevel?.replaceAll("/", path.sep) ?? null;
    const withoutGit: Array<string> = [];
    let withGit: string | null = null;
    let directory = realCwd;
    while (true) {
      if (topLevelHere !== null && areFilesystemPathsEqual(directory, topLevelHere)) {
        withGit = directory;
        break;
      }
      withoutGit.push(directory);
      const parent = path.dirname(directory);
      if (parent === directory) {
        if (topLevelHere !== null) {
          return null;
        }
        break;
      }
      directory = parent;
    }
    const check: RepositoryRootCheck = { realCwd, withoutGit, withGit };
    return (yield* stillHolds(cwd, check)) ? check : null;
  });

  return { record, stillHolds };
});

const resolveRepositoryRoot = Effect.fn("resolveRepositoryIdentityCacheKey")(function* (
  cwd: string,
  checks: Effect.Success<ReturnType<typeof makeRepositoryRootChecks>>,
): Effect.fn.Return<RepositoryRootLookup, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const topLevelResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (topLevelResult._tag === "None" || topLevelResult.value.timedOut) {
    return { root: cwd, check: null };
  }
  if (topLevelResult.value.code !== 0) {
    return { root: cwd, check: yield* checks.record(cwd, null) };
  }
  const topLevel = topLevelResult.value.stdout.trim();
  if (topLevel.length === 0) {
    return { root: cwd, check: null };
  }
  return { root: topLevel, check: yield* checks.record(cwd, topLevel) };
});

const resolveRepositoryIdentityFromCacheKey = Effect.fn("resolveRepositoryIdentityFromCacheKey")(
  function* (
    cacheKey: string,
  ): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const remoteResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cacheKey, "remote", "-v"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
      return null;
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
  },
);

/**
 * Resolves a folder to the repository identity of the git repository it sits
 * in, in two cached steps.
 *
 * 1. Folder to repository root. Git is asked once; after that the answer is
 *    confirmed by checking the same `.git` entries on disk, so a folder that
 *    is re-resolved every sweep starts no process. A new repository between
 *    the folder and its root (a nested repo, bare or not, or `git init`), or
 *    the root's `.git` disappearing, sends the next resolve back to git at
 *    once. Remembered
 *    roots are re-asked at least every `rootRecheckInterval`.
 * 2. Root to identity, from `git remote -v`, kept for the positive or negative
 *    TTL. A changed remote URL shows up once that TTL runs out.
 *
 * Concurrent resolves of one folder share one git run in each step.
 */
export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const checks = yield* makeRepositoryRootChecks();
    const capacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;

    const repositoryRootCache = yield* Cache.makeWith<string, RepositoryRootLookup>(
      (cwd) =>
        resolveRepositoryRoot(cwd, checks).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      {
        capacity,
        timeToLive: Exit.match({
          onSuccess: (lookup) =>
            lookup.check === null
              ? Duration.zero
              : (options.rootRecheckInterval ?? DEFAULT_ROOT_RECHECK_INTERVAL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) =>
        resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      {
        capacity,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const resolveRoot = Effect.fn("RepositoryIdentityResolver.resolveRoot")(function* (
      cwd: string,
    ) {
      const remembered = yield* Cache.get(repositoryRootCache, cwd);
      if (remembered.check === null || (yield* checks.stillHolds(cwd, remembered.check))) {
        return remembered.root;
      }
      // Drops only the entry just checked, so callers that found the same
      // stale entry together share the one git run that replaces it.
      yield* Cache.invalidateWhen(repositoryRootCache, cwd, (current) => current === remembered);
      return (yield* Cache.get(repositoryRootCache, cwd)).root;
    });

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (cwd) {
      const cacheKey = yield* resolveRoot(cwd);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
).pipe(Layer.provide(ProcessRunner.layer));
