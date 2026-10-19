import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Private index files Threadlines stages into, by way of `GIT_INDEX_FILE`.
 *
 * Checkpoints, commit previews and working-tree diffs build their trees in a
 * scratch index inside the git common dir so they never touch the user's
 * staging area. The files are our own bookkeeping rather than repository
 * activity, so the status watcher has to recognize and ignore them; both sides
 * go through this module so the names cannot drift apart.
 */
const SCRATCH_INDEX_PURPOSES = ["checkpoint", "preview", "working-tree-diff"] as const;

export type ScratchIndexPurpose = (typeof SCRATCH_INDEX_PURPOSES)[number];

/**
 * Prefix of the last scratch index a checkout built, kept in the checkout's
 * own git dir (each linked worktree has one) so the next one starts warm. The
 * rest of the name fingerprints the rules it was built under.
 */
export const SCRATCH_INDEX_CACHE_PREFIX = "t3-scratch-index-cache-";

/** A fresh, unique file name for one scratch index. */
export const scratchIndexFileName = (purpose: ScratchIndexPurpose): string =>
  `t3-${purpose}-index-${randomUUID()}`;

/** True for a scratch index file name, a checkout's cached one, or its `.lock`. */
export const isScratchIndexFileName = (fileName: string): boolean =>
  fileName.startsWith(SCRATCH_INDEX_CACHE_PREFIX) ||
  SCRATCH_INDEX_PURPOSES.some((purpose) => fileName.startsWith(`t3-${purpose}-index-`));

/** Runs git in the checkout with `env`, failing on a non-zero exit. */
export type ScratchIndexGit<GitError> = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  options?: { readonly maxOutputBytes?: number },
) => Effect.Effect<{ readonly stdout: string; readonly stdoutTruncated?: boolean }, GitError>;

/** Output that must be complete to be used; a cut-off listing could leave out a rule. */
const completeOutput = (result: { readonly stdout: string; readonly stdoutTruncated?: boolean }) =>
  result.stdoutTruncated === true
    ? Effect.fail("truncated git output" as const)
    : Effect.succeed(result.stdout);

/** One line of git output, without its line ending; paths keep their own spaces. */
const withoutLineEnding = (line: string) => line.replace(/\r?\n$/, "");

export interface ScratchIndexInput<A, E, R, GitError> {
  readonly cwd: string;
  readonly purpose: ScratchIndexPurpose;
  /** What the index starts as: a tree-ish such as `HEAD` or a commit, or null for empty. */
  readonly tree: string | null;
  /** Environment for every git command; `GIT_INDEX_FILE` is added to it. */
  readonly env?: NodeJS.ProcessEnv;
  readonly git: ScratchIndexGit<GitError>;
  /** Works in the scratch index, through the environment that selects it. */
  readonly use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E, R>;
}

/** File listings of very large checkouts; past this the cache is not used. */
const LISTING_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Settings that change the blob git makes from a file's bytes, or the path it files it under. */
const CONVERSION_SETTING =
  /^(filter\..+|core\.(autocrlf|eol|safecrlf|attributesfile|checkroundtripencoding|symlinks|filemode|ignorecase|precomposeunicode))$/;

type ConfigEntry = readonly [key: string, value: string | undefined];

/** `git config -z --list` output as ordered pairs; a bare key has no value. */
const parseConfigList = (stdout: string): ReadonlyArray<ConfigEntry> =>
  stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return newline === -1
        ? ([entry, undefined] as const)
        : ([entry.slice(0, newline), entry.slice(newline + 1)] as const);
    });

/** A git boolean as git reads it, or undefined for a value git would reject. */
const parseGitBool = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", ""].includes(normalized)) {
    return false;
  }
  const integer = /^[-+]?(\d+)[kmg]?$/.exec(normalized);
  return integer ? Number(integer[1]) !== 0 : undefined;
};

const lastValue = (settings: ReadonlyArray<ConfigEntry>, key: string) =>
  settings.findLast(([entryKey]) => entryKey === key);

/**
 * Settings under which a cached index is not equivalent to a fresh one.
 * `ignoreStat` marks entries assume-unchanged and `trustctime`/`checkStat`
 * compare less of the stat data, so git would not re-read an edited file a
 * fresh index re-reads. `attr.tree` (or `GIT_ATTR_SOURCE`) takes attributes
 * from a tree that moves without any file changing.
 */
const cacheUnsafe = (settings: ReadonlyArray<ConfigEntry>, env: NodeJS.ProcessEnv) => {
  const ignoreStat = lastValue(settings, "core.ignorestat");
  const trustCtime = lastValue(settings, "core.trustctime");
  const checkStat = lastValue(settings, "core.checkstat");
  return (
    (ignoreStat !== undefined && parseGitBool(ignoreStat[1]) !== false) ||
    (trustCtime !== undefined && parseGitBool(trustCtime[1]) !== true) ||
    (checkStat !== undefined && checkStat[1]?.trim().toLowerCase() !== "default") ||
    lastValue(settings, "attr.tree") !== undefined ||
    Boolean(env.GIT_ATTR_SOURCE ?? process.env.GIT_ATTR_SOURCE)
  );
};

/** Every folder holding one of `files` (repository-relative), and the folders above it. */
const foldersOf = (files: Iterable<string>): ReadonlyArray<string> => {
  const parentOf = (entry: string) => {
    const trimmed = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/")) : "";
  };
  const folders = new Set<string>([""]);
  for (const file of files) {
    let folder = parentOf(file);
    while (folder.length > 0 && !folders.has(folder)) {
      folders.add(folder);
      folder = parentOf(folder);
    }
  }
  return [...folders].toSorted();
};

const splitNul = (stdout: string) => stdout.split("\0").filter((entry) => entry.length > 0);

/**
 * The attribute sources git consults for the files a scratch index can stage,
 * gathered once per operation. Their contents are read by `fingerprintRules`.
 */
interface RuleSources {
  readonly version: string;
  /** Candidate attributes files, present or not. */
  readonly attributeFiles: ReadonlyArray<string>;
  /**
   * The tree's own `.gitattributes` blobs by path. Git reads these when the
   * checkout's copy is missing.
   */
  readonly indexedAttributes: ReadonlyMap<string, string>;
}

/**
 * Builds scratch indexes that start warm.
 *
 * A scratch index loaded with a plain `git read-tree` has no stat data, so a
 * following `git add -A` reads and hashes every file in the checkout (most
 * of a second in a mid-size repository, on every checkpoint). Instead, each
 * scratch index starts as a hard link to the checkout's cached one, and
 * `read-tree -m -i` loads the tree over it: entries the tree still matches
 * keep their stat data, so git re-reads only files that changed. (`-i` skips
 * the merge's check that dropped entries still match the checkout, which
 * refuses as soon as a file that differed from the tree was edited again.)
 * Git replaces an index by renaming a new file over it, so the link never
 * changes the cache, and it carries the cache's exact modification time,
 * which git compares file times against to catch edits made in the instant
 * the index was written.
 *
 * Stat data says nothing about how git turns bytes into a blob, so a cache
 * only serves the rules it was built under. Its name fingerprints the git
 * version, the conversion settings, and every attributes file git reads for
 * the files it can stage (the tree's files and every file not ignored):
 * `.gitattributes` in each of their folders, ignored or not, or the tree's
 * copy where the checkout has none; `info/attributes`; and the global and
 * system files. The rules are read again after the work; if they changed
 * meanwhile, the work is redone cold and nothing is cached. Like git's own
 * index, the cache assumes a clean filter's output depends only on the file
 * and the settings, not on edits to the filter program itself. Anything
 * unexpected falls back to the cold path, so the index always ends up
 * identical to a cold one.
 */
export const makeScratchIndexes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hashFile = (filePath: string) =>
    fileSystem.readFile(filePath).pipe(
      Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")),
      Effect.orElseSucceed(() => null),
    );

  const readRuleSources = <GitError>(input: {
    readonly git: ScratchIndexGit<GitError>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly toplevel: string;
    readonly gitCommonDir: string;
    readonly tree: string | null;
  }) =>
    Effect.gen(function* () {
      // Pathspecs here are patterns, even under an agent's literal profile.
      const listingEnv: NodeJS.ProcessEnv = { ...input.env, GIT_LITERAL_PATHSPECS: "0" };
      // Attribute file paths as git itself resolves them, on git 2.42 and later.
      const gitVar = (variable: "GIT_ATTR_GLOBAL" | "GIT_ATTR_SYSTEM") =>
        input.git(["var", variable], input.env).pipe(
          Effect.flatMap(completeOutput),
          Effect.map(withoutLineEnding),
          Effect.orElseSucceed(() => ""),
        );
      const [version, globalVar, systemVar, treeListing, fileListing] = yield* Effect.all(
        [
          input.git(["version"], input.env),
          gitVar("GIT_ATTR_GLOBAL"),
          gitVar("GIT_ATTR_SYSTEM"),
          input.tree === null
            ? Effect.succeed({ stdout: "" })
            : input.git(["ls-tree", "-r", "-z", "--full-tree", input.tree], input.env, {
                maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
              }),
          // Against an index that does not exist: every file not ignored.
          input.git(
            ["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--", ":/"],
            {
              ...listingEnv,
              GIT_INDEX_FILE: path.join(input.gitCommonDir, scratchIndexFileName("preview")),
            },
            { maxOutputBytes: LISTING_MAX_OUTPUT_BYTES },
          ),
        ],
        { concurrency: "unbounded" },
      );

      const treeEntries = splitNul(yield* completeOutput(treeListing));
      const nonIgnoredFiles = splitNul(yield* completeOutput(fileListing));
      const treeFiles: Array<string> = [];
      const indexedAttributes = new Map<string, string>();
      for (const entry of treeEntries) {
        const tab = entry.indexOf("\t");
        const file = entry.slice(tab + 1);
        treeFiles.push(file);
        if (file === ".gitattributes" || file.endsWith("/.gitattributes")) {
          indexedAttributes.set(path.join(input.toplevel, file), entry.split(" ")[2] ?? "");
        }
      }
      const inTreeAttributes = foldersOf([...treeFiles, ...nonIgnoredFiles]).map((folder) =>
        path.join(input.toplevel, folder, ".gitattributes"),
      );

      // Git reads relative paths from its own working directory.
      const globalFiles =
        globalVar.length > 0
          ? [path.resolve(input.cwd, globalVar)]
          : yield* olderGitGlobalAttributes(input);
      const systemFiles =
        systemVar.length > 0
          ? [path.resolve(input.cwd, systemVar)]
          : yield* olderGitSystemAttributes(input);
      if (globalFiles === null) {
        return null;
      }
      return {
        version: (yield* completeOutput(version)).trim(),
        attributeFiles: [
          ...inTreeAttributes,
          path.join(input.gitCommonDir, "info", "attributes"),
          ...globalFiles,
          ...systemFiles,
        ],
        indexedAttributes,
      } satisfies RuleSources;
    }).pipe(Effect.orElseSucceed(() => null));

  /**
   * Where a git older than 2.42 reads the global attributes file, or null
   * when only git can expand the configured path (`~user/`, `%(prefix)/`).
   */
  const olderGitGlobalAttributes = <GitError>(input: {
    readonly git: ScratchIndexGit<GitError>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) =>
    input.git(["config", "-z", "--list"], input.env).pipe(
      Effect.flatMap(completeOutput),
      Effect.map((config) => {
        const configured = lastValue(parseConfigList(config), "core.attributesfile")?.[1];
        if (configured === undefined || configured.trim().length === 0) {
          const configHome =
            input.env.XDG_CONFIG_HOME ||
            process.env.XDG_CONFIG_HOME ||
            path.join(homedir(), ".config");
          return [path.join(configHome, "git", "attributes")];
        }
        if (/^~[^/\\]/.test(configured) || configured.includes("%(")) {
          return null;
        }
        return [path.resolve(input.cwd, configured.replace(/^~(?=$|[/\\])/, homedir()))];
      }),
    );

  /**
   * Where a git older than 2.42 may keep its system attributes file. It
   * cannot say, so every place a standard build looks is read.
   */
  const olderGitSystemAttributes = <GitError>(input: {
    readonly git: ScratchIndexGit<GitError>;
    readonly env: NodeJS.ProcessEnv;
  }) =>
    input.git(["--exec-path"], input.env).pipe(
      Effect.flatMap(completeOutput),
      Effect.map((execPath) => {
        // `<prefix>/libexec/git-core`
        const prefix = path.dirname(path.dirname(withoutLineEnding(execPath)));
        return [
          "/etc/gitattributes",
          path.join(prefix, "etc", "gitattributes"),
          path.join(prefix, "share", "git-core", "gitattributes"),
        ];
      }),
    );

  /**
   * A fingerprint of the rules git converts the checkout's files under, or
   * null when a cache must not be used. Reads the settings and the files
   * named by `sources` as they are now.
   */
  const fingerprintRules = <GitError>(
    input: { readonly git: ScratchIndexGit<GitError>; readonly env: NodeJS.ProcessEnv },
    sources: RuleSources,
  ) =>
    Effect.gen(function* () {
      const [config, hashes] = yield* Effect.all(
        [
          input.git(["config", "-z", "--list"], input.env),
          Effect.forEach(sources.attributeFiles, hashFile, { concurrency: 16 }),
        ],
        { concurrency: "unbounded" },
      );
      const settings = parseConfigList(yield* completeOutput(config));
      if (cacheUnsafe(settings, input.env)) {
        return null;
      }
      const attributes = sources.attributeFiles.flatMap((file, index) => {
        const hash = hashes[index] ?? null;
        if (hash !== null) {
          return [[file, hash]];
        }
        const indexed = sources.indexedAttributes.get(file);
        return indexed === undefined ? [] : [[file, `tree:${indexed}`]];
      });
      return createHash("sha256")
        .update(
          JSON.stringify([
            sources.version,
            settings.filter(([key]) => CONVERSION_SETTING.test(key)),
            attributes,
          ]),
        )
        .digest("hex")
        .slice(0, 16);
    }).pipe(Effect.orElseSucceed(() => null));

  /** Removes the checkout's caches built under other rules. */
  const removeOtherCaches = (gitDir: string, keep: string) =>
    fileSystem.readDirectory(gitDir).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(
          names.filter((name) => name.startsWith(SCRATCH_INDEX_CACHE_PREFIX) && name !== keep),
          (name) => fileSystem.remove(path.join(gitDir, name), { force: true }),
          { discard: true },
        ),
      ),
      Effect.ignore,
    );

  const withScratchIndex = <A, E, R, GitError>(
    input: ScratchIndexInput<A, E, R, GitError>,
  ): Effect.Effect<A, E | GitError, R> =>
    Effect.gen(function* () {
      const baseEnv = input.env ?? {};
      const dirs = yield* input.git(
        ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
        baseEnv,
      );
      const [toplevel, gitDir, gitCommonDir] = dirs.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0)
        .map((dir) => path.resolve(input.cwd, dir));
      if (toplevel === undefined || gitDir === undefined || gitCommonDir === undefined) {
        return yield* Effect.die(new Error("git rev-parse did not print the checkout's dirs."));
      }
      const indexPath = path.join(gitCommonDir, scratchIndexFileName(input.purpose));
      const env: NodeJS.ProcessEnv = { ...baseEnv, GIT_INDEX_FILE: indexPath };
      const removeIndex = fileSystem.remove(indexPath, { force: true }).pipe(Effect.ignore);
      const rulesInput = { git: input.git, env: baseEnv };
      const sources = yield* readRuleSources({
        ...rulesInput,
        cwd: input.cwd,
        toplevel,
        gitCommonDir,
        tree: input.tree,
      });
      const rules = sources === null ? null : yield* fingerprintRules(rulesInput, sources);
      const cacheName = rules === null ? null : `${SCRATCH_INDEX_CACHE_PREFIX}${rules}`;

      const loadTree = (warmFrom: string | null) =>
        Effect.gen(function* () {
          if (input.tree === null) {
            return false;
          }
          const tree = input.tree;
          const warm =
            warmFrom !== null &&
            (yield* fileSystem.link(warmFrom, indexPath).pipe(
              Effect.andThen(input.git(["read-tree", "-m", "-i", tree], env)),
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ));
          if (!warm) {
            yield* removeIndex;
            yield* input.git(["read-tree", tree], env);
          }
          return warm;
        });

      return yield* Effect.gen(function* () {
        const cachePath = cacheName === null ? null : path.join(gitDir, cacheName);
        const warm = yield* loadTree(cachePath);
        const result = yield* input.use(env);
        if (sources === null || cacheName === null || cachePath === null) {
          return result;
        }
        if ((yield* fingerprintRules(rulesInput, sources)) !== rules) {
          // The rules moved while git staged under them: a warm index may
          // hold blobs from the old ones. Only a cold index is trusted.
          if (!warm) {
            return result;
          }
          yield* loadTree(null);
          return yield* input.use(env);
        }
        // Last writer wins; any index built under these rules is a valid cache.
        yield* fileSystem.rename(indexPath, cachePath).pipe(Effect.ignore);
        if (!warm) {
          yield* removeOtherCaches(gitDir, cacheName);
        }
        return result;
      }).pipe(Effect.ensuring(removeIndex));
    });

  return { withScratchIndex } as const;
});
