// @effect-diagnostics nodeBuiltinImport:off
import * as OS from "node:os";
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  type FilesystemBrowseEntry,
  type FilesystemBrowseInput,
  type ProjectEntry,
} from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";

import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesBrowseError,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);
const WINDOWS_KNOWN_HOME_FOLDER_NAMES = [
  "Desktop",
  "Documents",
  "Downloads",
  "Pictures",
  "Music",
  "Videos",
] as const;
const WINDOWS_KNOWN_HOME_FOLDER_NAME_BY_LOWERCASE = new Map(
  WINDOWS_KNOWN_HOME_FOLDER_NAMES.map((name) => [name.toLowerCase(), name]),
);
const WINDOWS_LEGACY_PROFILE_JUNCTION_NAMES = new Set([
  "Application Data",
  "Cookies",
  "Local Settings",
  "My Documents",
  "NetHood",
  "PrintHood",
  "Recent",
  "SendTo",
  "Start Menu",
  "Templates",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

type RankedWorkspaceEntry = RankedSearchResult<SearchableWorkspaceEntry>;
type WindowsKnownHomeFolderName = (typeof WINDOWS_KNOWN_HOME_FOLDER_NAMES)[number];

interface BrowseHomePathOptions {
  readonly directoryExists?: (path: string) => Promise<boolean>;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isDirectoryEntry(dirent: Dirent, fullPath: string): Promise<boolean> {
  if (dirent.isDirectory()) {
    return true;
  }
  if (!dirent.isSymbolicLink()) {
    return false;
  }
  if (process.platform === "win32" && WINDOWS_LEGACY_PROFILE_JUNCTION_NAMES.has(dirent.name)) {
    return false;
  }

  try {
    const stat = await fsPromises.stat(fullPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalizedPath = path.toLowerCase();
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    unique.push(path);
  }
  return unique;
}

function parseHomeRelativeSegments(input: string): string[] | null {
  if (input === "~") {
    return [];
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return input
      .slice(2)
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0);
  }
  return null;
}

function canonicalWindowsKnownHomeFolderName(input: string): WindowsKnownHomeFolderName | null {
  return WINDOWS_KNOWN_HOME_FOLDER_NAME_BY_LOWERCASE.get(input.toLowerCase()) ?? null;
}

function oneDriveBasePaths(
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
  path: Path.Path,
): string[] {
  return uniquePaths(
    [
      env.OneDrive,
      env.OneDriveConsumer,
      env.OneDriveCommercial,
      path.join(homeDirectory, "OneDrive"),
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => path.resolve(value)),
  );
}

function windowsKnownHomeFolderCandidates(
  folderName: WindowsKnownHomeFolderName,
  path: Path.Path,
  options: BrowseHomePathOptions = {},
): string[] {
  const homeDirectory = path.resolve(options.homeDirectory ?? OS.homedir());
  const env = options.env ?? process.env;
  const homeCandidate = path.join(homeDirectory, folderName);
  const oneDriveCandidates = oneDriveBasePaths(homeDirectory, env, path).map((basePath) =>
    path.join(basePath, folderName),
  );

  if (folderName === "Desktop" || folderName === "Documents" || folderName === "Pictures") {
    return uniquePaths([...oneDriveCandidates, homeCandidate]);
  }

  return uniquePaths([homeCandidate, ...oneDriveCandidates]);
}

async function resolveWindowsKnownHomeFolder(
  folderName: string,
  path: Path.Path,
  options: BrowseHomePathOptions = {},
): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "win32") {
    return null;
  }

  const canonicalFolderName = canonicalWindowsKnownHomeFolderName(folderName);
  if (!canonicalFolderName) {
    return null;
  }

  const directoryExists = options.directoryExists ?? defaultDirectoryExists;
  for (const candidate of windowsKnownHomeFolderCandidates(canonicalFolderName, path, options)) {
    if (await directoryExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function expandHomePathForBrowse(
  input: string,
  path: Path.Path,
  options: BrowseHomePathOptions = {},
): Promise<string> {
  const homeSegments = parseHomeRelativeSegments(input);
  if (homeSegments === null) {
    return input;
  }

  const homeDirectory = path.resolve(options.homeDirectory ?? OS.homedir());
  if (homeSegments.length === 0) {
    return homeDirectory;
  }

  const [firstSegment, ...remainingSegments] = homeSegments;
  const knownHomeFolderPath = firstSegment
    ? await resolveWindowsKnownHomeFolder(firstSegment, path, {
        ...options,
        homeDirectory,
      })
    : null;

  if (knownHomeFolderPath) {
    return path.join(knownHomeFolderPath, ...remainingSegments);
  }

  return path.join(homeDirectory, ...homeSegments);
}

async function normalizeWindowsHomeBrowseEntries(
  input: {
    readonly parentPath: string;
    readonly entries: ReadonlyArray<FilesystemBrowseEntry>;
    readonly prefix: string;
  },
  path: Path.Path,
  options: BrowseHomePathOptions = {},
): Promise<FilesystemBrowseEntry[]> {
  if ((options.platform ?? process.platform) !== "win32") {
    return [...input.entries];
  }

  const homeDirectory = path.resolve(options.homeDirectory ?? OS.homedir());
  if (path.resolve(input.parentPath).toLowerCase() !== homeDirectory.toLowerCase()) {
    return [...input.entries];
  }

  const lowerPrefix = input.prefix.toLowerCase();
  const entries = [...input.entries];
  const entryIndexesByName = new Map<string, number>();
  entries.forEach((entry, index) => {
    entryIndexesByName.set(entry.name.toLowerCase(), index);
  });

  for (const folderName of WINDOWS_KNOWN_HOME_FOLDER_NAMES) {
    if (!folderName.toLowerCase().startsWith(lowerPrefix)) {
      continue;
    }

    const knownHomeFolderPath = await resolveWindowsKnownHomeFolder(folderName, path, options);
    if (!knownHomeFolderPath) {
      continue;
    }

    const existingIndex = entryIndexesByName.get(folderName.toLowerCase());
    const entry = { name: folderName, fullPath: knownHomeFolderPath };
    if (existingIndex === undefined) {
      entryIndexesByName.set(folderName.toLowerCase(), entries.length);
      entries.push(entry);
    } else {
      entries[existingIndex] = entry;
    }
  }

  return entries;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  const scores = [
    scoreQueryMatch({
      value: normalizedName,
      query,
      exactBase: 0,
      prefixBase: 2,
      includesBase: 5,
      fuzzyBase: 100,
    }),
    scoreQueryMatch({
      value: normalizedPath,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 200,
      boundaryMarkers: ["/"],
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];

  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

const resolveBrowseTarget = (
  input: FilesystemBrowseInput,
  pathService: Path.Path,
): Effect.Effect<string, WorkspaceEntriesBrowseError> =>
  Effect.gen(function* () {
    if (process.platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Windows-style paths are only supported on Windows.",
      });
    }

    if (!isExplicitRelativePath(input.partialPath)) {
      const expandedPath = yield* Effect.tryPromise({
        try: () => expandHomePathForBrowse(input.partialPath, pathService),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.resolveBrowseTarget",
            detail: `Unable to resolve '${input.partialPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
      return pathService.resolve(expandedPath);
    }

    if (!input.cwd) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Relative filesystem browse paths require a current project.",
      });
    }

    const cwd = input.cwd;
    const expandedCwd = yield* Effect.tryPromise({
      try: () => expandHomePathForBrowse(cwd, pathService),
      catch: (cause) =>
        new WorkspaceEntriesBrowseError({
          cwd,
          partialPath: input.partialPath,
          operation: "workspaceEntries.resolveBrowseTarget",
          detail: `Unable to resolve '${cwd}': ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    return pathService.resolve(expandedCwd, input.partialPath);
  });

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry;
  const workspacePaths = yield* WorkspacePaths;

  const isInsideVcsWorkTree = (cwd: string): Effect.Effect<boolean> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.map((handle) => handle !== null),
      Effect.catch(() => Effect.succeed(false)),
    );

  const filterVcsIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.flatMap((handle) =>
        handle
          ? handle.driver.filterIgnoredPaths(cwd, relativePaths).pipe(
              Effect.map((paths) => [...paths]),
              Effect.catch(() => Effect.succeed(relativePaths)),
            )
          : Effect.succeed(relativePaths),
      ),
      Effect.catch(() => Effect.succeed(relativePaths)),
    );

  const buildWorkspaceIndexFromVcs = Effect.fn("WorkspaceEntries.buildWorkspaceIndexFromVcs")(
    function* (cwd: string) {
      const vcs = yield* vcsRegistry.detect({ cwd }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!vcs) {
        return null;
      }

      const listedFiles = yield* vcs.driver
        .listWorkspaceFiles(cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!listedFiles) {
        return null;
      }

      const listedPaths = [...listedFiles.paths]
        .map((entry) => toPosixPath(entry))
        .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
      const filePaths = yield* vcs.driver.filterIgnoredPaths(cwd, listedPaths).pipe(
        Effect.map((paths) => [...paths]),
        Effect.catch(() => filterVcsIgnoredPaths(cwd, listedPaths)),
      );

      const directorySet = new Set<string>();
      for (const filePath of filePaths) {
        for (const directoryPath of directoryAncestorsOf(filePath)) {
          if (!isPathInIgnoredDirectory(directoryPath)) {
            directorySet.add(directoryPath);
          }
        }
      }

      const directoryEntries = [...directorySet]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (directoryPath): ProjectEntry => ({
            path: directoryPath,
            kind: "directory",
            parentPath: parentPathOf(directoryPath),
          }),
        )
        .map(toSearchableWorkspaceEntry);
      const fileEntries = [...new Set(filePaths)]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (filePath): ProjectEntry => ({
            path: filePath,
            kind: "file",
            parentPath: parentPathOf(filePath),
          }),
        )
        .map(toSearchableWorkspaceEntry);

      const now = yield* DateTime.now;
      const entries = [...directoryEntries, ...fileEntries];
      return {
        scannedAt: now.epochMilliseconds,
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: listedFiles.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    },
  );

  const readDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(function* (
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  });

  const buildWorkspaceIndexFromFilesystem = Effect.fn(
    "WorkspaceEntries.buildWorkspaceIndexFromFilesystem",
  )(function* (cwd: string): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const shouldFilterWithGitIgnore = yield* isInsideVcsWorkTree(cwd);

    let pendingDirectories: string[] = [""];
    const entries: SearchableWorkspaceEntry[] = [];
    let truncated = false;

    while (pendingDirectories.length > 0 && !truncated) {
      const currentDirectories = pendingDirectories;
      pendingDirectories = [];

      const directoryEntries = yield* Effect.forEach(
        currentDirectories,
        (relativeDir) => readDirectoryEntries(cwd, relativeDir),
        { concurrency: WORKSPACE_SCAN_READDIR_CONCURRENCY },
      );

      const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
        const { relativeDir, dirents } = directoryEntry;
        if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

        dirents.sort((left, right) => left.name.localeCompare(right.name));
        const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
        for (const dirent of dirents) {
          if (!dirent.name || dirent.name === "." || dirent.name === "..") {
            continue;
          }
          if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue;
          }
          if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
          }

          const relativePath = toPosixPath(
            relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
          );
          if (isPathInIgnoredDirectory(relativePath)) {
            continue;
          }
          candidates.push({ dirent, relativePath });
        }
        return candidates;
      });

      const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
        candidateEntries.map((entry) => entry.relativePath),
      );
      const allowedPathSet = shouldFilterWithGitIgnore
        ? new Set(yield* filterVcsIgnoredPaths(cwd, candidatePaths))
        : null;

      for (const candidateEntries of candidateEntriesByDirectory) {
        for (const candidate of candidateEntries) {
          if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
            continue;
          }

          const entry = toSearchableWorkspaceEntry({
            path: candidate.relativePath,
            kind: candidate.dirent.isDirectory() ? "directory" : "file",
            parentPath: parentPathOf(candidate.relativePath),
          });
          entries.push(entry);

          if (candidate.dirent.isDirectory()) {
            pendingDirectories.push(candidate.relativePath);
          }

          if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    const now = yield* DateTime.now;
    return {
      scannedAt: now.epochMilliseconds,
      entries,
      truncated,
    };
  });

  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const vcsIndexed = yield* buildWorkspaceIndexFromVcs(cwd);
    if (vcsIndexed) {
      return vcsIndexed;
    }
    return yield* buildWorkspaceIndexFromFilesystem(cwd);
  });

  const workspaceIndexCache = yield* Cache.makeWith<string, WorkspaceIndex, WorkspaceEntriesError>(
    buildWorkspaceIndex,
    {
      capacity: WORKSPACE_CACHE_MAX_KEYS,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.millis(WORKSPACE_CACHE_TTL_MS) : Duration.zero,
    },
  );

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const invalidate: WorkspaceEntriesShape["invalidate"] = Effect.fn("WorkspaceEntries.invalidate")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.catch(() => Effect.succeed(cwd)),
      );
      yield* Cache.invalidate(workspaceIndexCache, cwd);
      if (normalizedCwd !== cwd) {
        yield* Cache.invalidate(workspaceIndexCache, normalizedCwd);
      }
    },
  );

  const browse: WorkspaceEntriesShape["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => fsPromises.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.browse.readDirectory",
            detail: `Unable to browse '${parentPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const directoryEntries = yield* Effect.forEach(
        dirents,
        (dirent) =>
          Effect.tryPromise({
            try: async (): Promise<FilesystemBrowseEntry | null> => {
              const fullPath = path.join(parentPath, dirent.name);
              const matchesPrefix = dirent.name.toLowerCase().startsWith(lowerPrefix);
              const matchesVisibility = showHidden || !dirent.name.startsWith(".");
              if (
                !matchesPrefix ||
                !matchesVisibility ||
                !(await isDirectoryEntry(dirent, fullPath))
              ) {
                return null;
              }
              return {
                name: dirent.name,
                fullPath,
              };
            },
            catch: (cause) =>
              new WorkspaceEntriesBrowseError({
                cwd: input.cwd,
                partialPath: input.partialPath,
                operation: "workspaceEntries.browse.resolveDirectoryEntry",
                detail: `Unable to resolve '${dirent.name}': ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          }),
        { concurrency: 16 },
      );
      const entries = directoryEntries.filter(
        (entry): entry is FilesystemBrowseEntry => entry !== null,
      );
      const normalizedEntries = yield* Effect.tryPromise({
        try: () =>
          normalizeWindowsHomeBrowseEntries(
            {
              parentPath,
              entries,
              prefix,
            },
            path,
          ),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.browse.normalizeWindowsKnownFolders",
            detail: `Unable to resolve Windows user folders: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      return {
        parentPath,
        entries: normalizedEntries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Cache.get(workspaceIndexCache, normalizedCwd).pipe(
        Effect.map((index) => {
          const normalizedQuery = normalizeSearchQuery(input.query, {
            trimLeadingPattern: /^[@./]+/,
          });
          const limit = Math.max(0, Math.floor(input.limit));
          const rankedEntries: RankedWorkspaceEntry[] = [];
          let matchedEntryCount = 0;

          for (const entry of index.entries) {
            const score = scoreEntry(entry, normalizedQuery);
            if (score === null) {
              continue;
            }

            matchedEntryCount += 1;
            insertRankedSearchResult(
              rankedEntries,
              { item: entry, score, tieBreaker: entry.path },
              limit,
            );
          }

          return {
            entries: rankedEntries.map((candidate) => candidate.item),
            truncated: index.truncated || matchedEntryCount > limit,
          };
        }),
      );
    },
  );

  return {
    browse,
    invalidate,
    search,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
