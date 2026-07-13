import type { EnvironmentId, ProjectSearchEntriesResult } from "@threadlines/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit: number,
  ) => ["projects", "search-entries", environmentId ?? null, cwd, query, limit] as const,
  listEntries: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["projects", "list-entries", environmentId ?? null, cwd] as const,
  readFile: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    relativePath: string | null,
  ) => ["projects", "read-file", environmentId ?? null, cwd, relativePath] as const,
  favicon: (environmentId: EnvironmentId, cwd: string) =>
    ["projects", "favicon", environmentId, cwd] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
  allowEmptyQuery?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.environmentId, input.cwd, input.query, limit),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry search is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      (input.allowEmptyQuery === true || input.query.length > 0),
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

const DEFAULT_LIST_ENTRIES_STALE_TIME = 15_000;
const DEFAULT_READ_FILE_STALE_TIME = 5_000;

export function projectListEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listEntries(input.environmentId, input.cwd),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry listing is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.listEntries({ cwd: input.cwd });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_LIST_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous,
  });
}

export function projectReadFileQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.readFile(input.environmentId, input.cwd, input.relativePath),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.relativePath) {
        throw new Error("Workspace file read is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.relativePath !== null,
    staleTime: input.staleTime ?? DEFAULT_READ_FILE_STALE_TIME,
  });
}

const PROJECT_FAVICON_STALE_TIME = 60 * 60_000;

/**
 * Fetches the project favicon over the environment's WebSocket RPC and
 * yields a data URL, or null when the project has no icon. Used instead of
 * the `/api/project-favicon` HTTP route for relay-paired environments
 * (phonelink), where the relay carries only the WebSocket.
 */
export function projectFaviconQueryOptions(input: {
  environmentId: EnvironmentId;
  cwd: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.favicon(input.environmentId, input.cwd),
    queryFn: async (): Promise<string | null> => {
      const api = ensureEnvironmentApi(input.environmentId);
      const result = await api.projects.favicon({ cwd: input.cwd });
      return result.favicon
        ? `data:${result.favicon.mimeType};base64,${result.favicon.base64}`
        : null;
    },
    enabled: input.enabled ?? true,
    staleTime: PROJECT_FAVICON_STALE_TIME,
    retry: 1,
  });
}
