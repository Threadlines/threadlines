import type { EnvironmentId } from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import type { MarkdownFileLinkMeta } from "../markdown-links";

const DIRECTORY_LISTING_CACHE_TTL_MS = 60_000;

export type MarkdownFileLinkKind = "file" | "directory";

interface DirectoryListingCacheEntry {
  directoryPaths: ReadonlySet<string>;
  expiresAt: number;
}

const directoryListingCache = new Map<string, DirectoryListingCacheEntry>();
const directoryListingRequests = new Map<string, Promise<ReadonlySet<string> | null>>();

function normalizeFilesystemPathForComparison(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function browseParentPath(path: string): string | null {
  const trimmedPath = path.replace(/[\\/]+$/u, "");
  if (trimmedPath.length === 0) return null;
  const separatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));
  if (separatorIndex < 0) return null;
  return trimmedPath.slice(0, separatorIndex + 1);
}

function directoryListingCacheKey(environmentId: EnvironmentId, parentPath: string): string {
  return `${environmentId}\u0000${normalizeFilesystemPathForComparison(parentPath)}`;
}

function readCachedDirectoryListing(
  environmentId: EnvironmentId,
  parentPath: string,
): ReadonlySet<string> | null {
  const key = directoryListingCacheKey(environmentId, parentPath);
  const cached = directoryListingCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    directoryListingCache.delete(key);
    return null;
  }
  return cached.directoryPaths;
}

function resolveDirectoryListing(
  environmentId: EnvironmentId,
  parentPath: string,
  cwd: string | undefined,
): Promise<ReadonlySet<string> | null> {
  const cached = readCachedDirectoryListing(environmentId, parentPath);
  if (cached) return Promise.resolve(cached);

  const key = directoryListingCacheKey(environmentId, parentPath);
  const pending = directoryListingRequests.get(key);
  if (pending) return pending;

  const api = readEnvironmentApi(environmentId);
  if (!api) return Promise.resolve(null);

  const request = api.filesystem
    .browse({
      partialPath: parentPath,
      ...(cwd ? { cwd } : {}),
    })
    .then((result) => {
      const directoryPaths = new Set(
        result.entries.map((entry) => normalizeFilesystemPathForComparison(entry.fullPath)),
      );
      directoryListingCache.set(key, {
        directoryPaths,
        expiresAt: Date.now() + DIRECTORY_LISTING_CACHE_TTL_MS,
      });
      return directoryPaths as ReadonlySet<string>;
    })
    .catch(() => null)
    .finally(() => {
      directoryListingRequests.delete(key);
    });
  directoryListingRequests.set(key, request);
  return request;
}

export function useMarkdownFileLinkKinds(
  fileLinkMetaByHref: ReadonlyMap<string, MarkdownFileLinkMeta>,
  environmentId: EnvironmentId | undefined,
  cwd: string | undefined,
): ReadonlyMap<string, MarkdownFileLinkKind> {
  const [kindByPath, setKindByPath] = useState<ReadonlyMap<string, MarkdownFileLinkKind>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const nextKindByPath = new Map<string, MarkdownFileLinkKind>();
    const unresolvedPathsByParent = new Map<string, string[]>();

    for (const meta of fileLinkMetaByHref.values()) {
      if (meta.line !== undefined || !environmentId) {
        nextKindByPath.set(meta.filePath, "file");
        continue;
      }

      const parentPath = browseParentPath(meta.filePath);
      if (!parentPath) {
        nextKindByPath.set(meta.filePath, "file");
        continue;
      }

      const cachedListing = readCachedDirectoryListing(environmentId, parentPath);
      if (cachedListing) {
        nextKindByPath.set(
          meta.filePath,
          cachedListing.has(normalizeFilesystemPathForComparison(meta.filePath))
            ? "directory"
            : "file",
        );
        continue;
      }

      const unresolvedPaths = unresolvedPathsByParent.get(parentPath) ?? [];
      unresolvedPaths.push(meta.filePath);
      unresolvedPathsByParent.set(parentPath, unresolvedPaths);
    }

    setKindByPath(nextKindByPath);
    if (!environmentId || unresolvedPathsByParent.size === 0) {
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(
      [...unresolvedPathsByParent].map(async ([parentPath, filePaths]) => ({
        filePaths,
        directoryPaths: await resolveDirectoryListing(environmentId, parentPath, cwd),
      })),
    ).then((resolvedParents) => {
      if (cancelled) return;
      const resolvedKindByPath = new Map(nextKindByPath);
      for (const { filePaths, directoryPaths } of resolvedParents) {
        if (!directoryPaths) continue;
        for (const filePath of filePaths) {
          resolvedKindByPath.set(
            filePath,
            directoryPaths.has(normalizeFilesystemPathForComparison(filePath))
              ? "directory"
              : "file",
          );
        }
      }
      setKindByPath(resolvedKindByPath);
    });

    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, fileLinkMetaByHref]);

  return kindByPath;
}
