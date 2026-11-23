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

/** Runs git in the checkout with `env`, failing on a non-zero exit unless allowed. */
export type ScratchIndexGit<GitError> = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  options?: {
    readonly maxOutputBytes?: number;
    readonly stdin?: string;
    readonly allowNonZeroExit?: boolean;
  },
) => Effect.Effect<
  { readonly stdout: string; readonly stdoutTruncated?: boolean; readonly exitCode?: number },
  GitError
>;

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
  /**
   * Stage the checkout's changes (`git add -A -- .` from `cwd`) before `use`.
   * Run from the checkout's top, the index may then start from the last one
   * as it is, files never committed included, so git re-reads only the files
   * that changed since.
   */
  readonly stageCheckout?: boolean;
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

/** The mode git records a symbolic link under. */
const SYMLINK_MODE = "120000";

/** Paths for git's `-z --stdin`. */
const joinNul = (paths: ReadonlyArray<string>) => paths.map((entry) => `${entry}\0`).join("");

/** How git compares paths under `core.ignorecase`: ASCII letters only. */
const foldAsciiCase = (file: string) => file.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

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
  /** Every entry the tree holds, repository-relative. */
  readonly treeEntries: ReadonlyArray<IndexEntry>;
  /**
   * Every file in the checkout that is neither ignored nor in the tree,
   * repository-relative, a nested repository by its folder.
   */
  readonly untrackedFiles: ReadonlyArray<string>;
}

/** A file as git's index or a tree records it: its mode, its object and its path. */
interface IndexEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

/** `<mode> <type-or-oid> <oid-or-stage>\t<path>`, as `ls-tree -z` and `ls-files -s -z` print. */
const parseEntries = (stdout: string, oidField: 1 | 2): ReadonlyArray<IndexEntry> =>
  splitNul(stdout).map((entry) => {
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab).split(" ");
    return { mode: fields[0] ?? "", oid: fields[oidField] ?? "", path: entry.slice(tab + 1) };
  });

/** A path git printed in bytes that are not UTF-8: decoded, it may equal another one. */
const hasUndecodablePath = (paths: Iterable<string>) => {
  for (const file of paths) {
    if (file.includes("\uFFFD")) {
      return true;
    }
  }
  return false;
};

/** The rules a cache is built under, and how git compares paths under them. */
interface Rules {
  readonly fingerprint: string;
  readonly ignoreCase: boolean;
  /** Sparse checkout: `add -A` leaves files outside the cone alone. */
  readonly sparse: boolean;
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
 * A checkpoint stages the whole checkout (`stageCheckout` from its top), so
 * its index need not start as the tree: it starts as the cache as it is, and
 * `add -A` re-reads only what changed, files never committed included
 * (`read-tree` drops those, so every checkpoint read them all again). The
 * cache is first brought in line with the tree and the ignore rules, so the
 * result is the tree a cold build stages; see `stageOverCache`. A path git
 * prints in bytes that are not UTF-8 takes the cold path, and a sparse
 * checkout loads the tree over the cache as other purposes do.
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

  /**
   * Every file neither ignored nor in `tree`. Listed against an index loaded
   * from the tree: against no index at all git checks every committed file
   * against the ignore rules too, over twice as slow in a large checkout.
   */
  const listUntracked = <GitError>(
    input: {
      readonly git: ScratchIndexGit<GitError>;
      readonly env: NodeJS.ProcessEnv;
      readonly gitCommonDir: string;
      readonly tree: string | null;
    },
    listingEnv: NodeJS.ProcessEnv,
  ) => {
    const listingIndex = path.join(input.gitCommonDir, scratchIndexFileName("preview"));
    const list = input.git(
      ["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--", ":/"],
      { ...listingEnv, GIT_INDEX_FILE: listingIndex },
      { maxOutputBytes: LISTING_MAX_OUTPUT_BYTES },
    );
    if (input.tree === null) {
      return list;
    }
    return input
      .git(["read-tree", input.tree], { ...input.env, GIT_INDEX_FILE: listingIndex })
      .pipe(
        Effect.andThen(list),
        Effect.ensuring(fileSystem.remove(listingIndex, { force: true }).pipe(Effect.ignore)),
      );
  };

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
          listUntracked(input, listingEnv),
        ],
        { concurrency: "unbounded" },
      );

      const treeEntries = parseEntries(yield* completeOutput(treeListing), 2);
      // `ls-files --others` names a nested repository by its folder, `sub/`.
      const untrackedFiles = splitNul(yield* completeOutput(fileListing)).map((file) =>
        file.replace(/\/$/, ""),
      );
      const indexedAttributes = new Map<string, string>();
      for (const entry of treeEntries) {
        if (entry.path === ".gitattributes" || entry.path.endsWith("/.gitattributes")) {
          indexedAttributes.set(path.join(input.toplevel, entry.path), entry.oid);
        }
      }
      const inTreeAttributes = foldersOf([
        ...treeEntries.map((entry) => entry.path),
        ...untrackedFiles,
      ]).map((folder) => path.join(input.toplevel, folder, ".gitattributes"));

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
        treeEntries,
        untrackedFiles,
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
      const ignoreCase = lastValue(settings, "core.ignorecase");
      const sparse = lastValue(settings, "core.sparsecheckout");
      const attributes = sources.attributeFiles.flatMap((file, index) => {
        const hash = hashes[index] ?? null;
        if (hash !== null) {
          return [[file, hash]];
        }
        const indexed = sources.indexedAttributes.get(file);
        return indexed === undefined ? [] : [[file, `tree:${indexed}`]];
      });
      return {
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify([
              sources.version,
              settings.filter(([key]) => CONVERSION_SETTING.test(key)),
              attributes,
            ]),
          )
          .digest("hex")
          .slice(0, 16),
        ignoreCase: ignoreCase !== undefined && parseGitBool(ignoreCase[1]) === true,
        sparse: sparse !== undefined && parseGitBool(sparse[1]) !== false,
      } satisfies Rules;
    }).pipe(Effect.orElseSucceed((): Rules | null => null));

  /** Removes the checkout's other caches: built under other rules, or over another tree. */
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
      // The tree's own id last: a cache names the tree it was staged over.
      const revParse = yield* input.git(
        [
          "rev-parse",
          "--show-toplevel",
          "--git-dir",
          "--git-common-dir",
          "--show-prefix",
          ...(input.tree !== null ? [`${input.tree}^{tree}`] : []),
        ],
        baseEnv,
      );
      const lines = revParse.stdout.split("\n").map((line) => line.replace(/\r$/, ""));
      const [toplevel, gitDir, gitCommonDir] = lines
        .slice(0, 3)
        .filter((line) => line.length > 0)
        .map((dir) => path.resolve(input.cwd, dir));
      if (toplevel === undefined || gitDir === undefined || gitCommonDir === undefined) {
        return yield* Effect.die(new Error("git rev-parse did not print the checkout's dirs."));
      }
      // Empty at the checkout's top: there `add -A -- .` stages all of it.
      const stagesWholeCheckout = input.stageCheckout === true && (lines[3] ?? "") === "";
      const treeId = input.tree === null ? null : lines[4] || null;
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
      const cachePrefix =
        rules === null ? null : `${SCRATCH_INDEX_CACHE_PREFIX}${rules.fingerprint}`;
      // A checkpoint's cache names the tree it was staged over: a file it
      // holds that is not in that tree went in as a new file.
      const cacheName =
        cachePrefix === null
          ? null
          : stagesWholeCheckout && treeId !== null
            ? `${cachePrefix}-${treeId}`
            : cachePrefix;

      /** The checkout's cache under these rules, and the tree it was staged over when known. */
      const findCache = Effect.gen(function* () {
        if (cachePrefix === null) {
          return null;
        }
        const names = yield* fileSystem
          .readDirectory(gitDir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const name =
          names.find((entry) => entry === cacheName) ??
          names.find((entry) => entry === cachePrefix || entry.startsWith(`${cachePrefix}-`));
        if (name === undefined) {
          return null;
        }
        const stagedOver = name.slice(cachePrefix.length + 1);
        return {
          path: path.join(gitDir, name),
          stagedOver: stagedOver.length > 0 ? stagedOver : null,
        };
      });

      const stage = input.git(["add", "-A", "--", "."], env);
      const listing = (args: ReadonlyArray<string>) =>
        input
          .git(args, env, { maxOutputBytes: LISTING_MAX_OUTPUT_BYTES })
          .pipe(Effect.flatMap(completeOutput));

      /**
       * Stages the whole checkout over the cache, keeping only what a cold
       * build would stage the same way, so files never committed keep their
       * stat data too. False when it could not be done and the index must
       * be built cold.
       *
       * A cold build stages over the tree's entries, so a tree path keeps
       * the cache's entry only when it is the tree's (as `read-tree -m`
       * keeps it): git reads a changed file's index blob to decide line
       * endings, and keeps a mode under `core.filemode=false` and a
       * submodule's commit while it is not checked out. A cold build stages
       * any other file as new, so the cache's entry for one stays only when
       * it went in as new and is still what git would stage: listed under
       * the same name (a nested repository that lost its .git lists its
       * files instead), not in the tree the cache was staged over, and not
       * under another spelling of a tree folder. Everything else git reads
       * again.
       */
      const stageOverCache = (
        cache: { readonly path: string; readonly stagedOver: string | null },
        tree: string,
        ruleSources: RuleSources,
        ruleSet: Rules,
      ) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.gen(function* () {
            yield* fileSystem.link(cache.path, indexPath);
            const cached = parseEntries(yield* listing(["ls-files", "-s", "-z"]), 1);
            if (
              hasUndecodablePath(cached.map((entry) => entry.path)) ||
              hasUndecodablePath(ruleSources.treeEntries.map((entry) => entry.path)) ||
              hasUndecodablePath(ruleSources.untrackedFiles)
            ) {
              return null;
            }
            const inTree = new Map(ruleSources.treeEntries.map((entry) => [entry.path, entry]));
            const untracked = new Set(ruleSources.untrackedFiles);
            const extras = cached.filter((entry) => !inTree.has(entry.path));
            // Unknown, or staged over another tree: what that tree held went in as tracked.
            const leftTree =
              extras.length === 0 || cache.stagedOver === tree
                ? new Set<string>()
                : cache.stagedOver === null
                  ? null
                  : new Set(
                      splitNul(
                        yield* listing([
                          "diff-tree",
                          "-r",
                          "-z",
                          "--name-only",
                          "--diff-filter=D",
                          cache.stagedOver,
                          tree,
                        ]),
                      ),
                    );
            // Under `core.ignorecase` git files a new file under the spelling
            // of its folder the index already has, which in a cold build is
            // the tree's or the first one staged: keep a cached file only
            // where its folders are spelled one way.
            const spellings = new Map<string, Set<string>>();
            if (ruleSet.ignoreCase) {
              for (const folder of foldersOf([...inTree.keys(), ...untracked])) {
                const folded = foldAsciiCase(folder);
                spellings.set(folded, (spellings.get(folded) ?? new Set()).add(folder));
              }
            }
            const respelledFolder = (file: string) =>
              ruleSet.ignoreCase &&
              foldersOf([file]).some((folder) => {
                const spelled = spellings.get(foldAsciiCase(folder));
                return spelled !== undefined && (spelled.size > 1 || !spelled.has(folder));
              });
            const drop = extras
              .filter(
                (entry) =>
                  leftTree === null ||
                  leftTree.has(entry.path) ||
                  !untracked.has(entry.path) ||
                  // Under `core.symlinks=false` git keeps a link's type for
                  // the file that replaces it.
                  entry.mode === SYMLINK_MODE ||
                  respelledFolder(entry.path),
              )
              .map((entry) => entry.path);
            const cachedByPath = new Map(cached.map((entry) => [entry.path, entry]));
            const fromTree = ruleSources.treeEntries.filter((entry) => {
              const inCache = cachedByPath.get(entry.path);
              return (
                inCache === undefined || inCache.mode !== entry.mode || inCache.oid !== entry.oid
              );
            });
            if (drop.length > 0) {
              yield* input.git(["update-index", "--force-remove", "-z", "--stdin"], env, {
                stdin: joinNul(drop),
              });
            }
            if (fromTree.length > 0) {
              yield* input.git(["update-index", "-z", "--index-info"], env, {
                stdin: fromTree
                  .map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`)
                  .join(""),
              });
            }
            const dropped = new Set(drop);
            return extras.map((entry) => entry.path).filter((file) => !dropped.has(file));
          }).pipe(Effect.orElseSucceed(() => null));
          if (prepared === null) {
            return false;
          }
          // A failure here is the checkout's, not the cache's: a cold build would meet it too.
          yield* stage;
          if (prepared.length === 0) {
            return true;
          }
          // An ignore rule added since the listing: a cold build would not stage the file now.
          return yield* Effect.gen(function* () {
            const result = yield* input.git(["check-ignore", "--no-index", "-z", "--stdin"], env, {
              stdin: joinNul(prepared),
              allowNonZeroExit: true,
            });
            // 1: none of them is ignored. Anything else is git failing.
            if (result.exitCode !== undefined && result.exitCode !== 0 && result.exitCode !== 1) {
              return false;
            }
            const ignored = splitNul(result.stdout);
            if (ignored.length > 0) {
              yield* input.git(["update-index", "--force-remove", "-z", "--stdin"], env, {
                stdin: joinNul(ignored),
              });
            }
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
        });

      /** Builds the index, from the cache when there is a usable one; true when it was. */
      const build = (
        warmFrom: { readonly path: string; readonly stagedOver: string | null } | null,
      ) =>
        Effect.gen(function* () {
          if (warmFrom !== null && input.tree !== null) {
            if (stagesWholeCheckout && sources !== null && rules !== null && !rules.sparse) {
              if (treeId !== null && (yield* stageOverCache(warmFrom, treeId, sources, rules))) {
                return true;
              }
            } else {
              const loaded = yield* fileSystem.link(warmFrom.path, indexPath).pipe(
                Effect.andThen(input.git(["read-tree", "-m", "-i", input.tree], env)),
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              if (loaded) {
                if (input.stageCheckout === true) {
                  yield* stage;
                }
                return true;
              }
            }
          }
          yield* removeIndex;
          if (input.tree !== null) {
            yield* input.git(["read-tree", input.tree], env);
          }
          if (input.stageCheckout === true) {
            yield* stage;
          }
          return false;
        });

      return yield* Effect.gen(function* () {
        const warm = yield* build(yield* findCache);
        // A cached entry may name an object git has since pruned (a snapshot
        // of a deleted thread, a diff never committed): only a cold build
        // writes every object again.
        const result = yield* warm && stagesWholeCheckout
          ? input
              .use(env)
              .pipe(Effect.catch(() => build(null).pipe(Effect.andThen(input.use(env)))))
          : input.use(env);
        if (sources === null || rules === null || cacheName === null) {
          return result;
        }
        if ((yield* fingerprintRules(rulesInput, sources))?.fingerprint !== rules.fingerprint) {
          // The rules moved while git staged under them: a warm index may
          // hold blobs from the old ones. Only a cold index is trusted.
          if (!warm) {
            return result;
          }
          yield* build(null);
          return yield* input.use(env);
        }
        // Last writer wins; any index built under these rules is a valid cache.
        yield* fileSystem.rename(indexPath, path.join(gitDir, cacheName)).pipe(Effect.ignore);
        yield* removeOtherCaches(gitDir, cacheName);
        return result;
      }).pipe(Effect.ensuring(removeIndex));
    });

  return { withScratchIndex } as const;
});
