import type {
  EnvironmentId,
  OrchestrationThreadSearchMatch,
  ProjectId,
} from "@threadlines/contracts";
import { parseSearchQuery } from "@threadlines/shared/searchRanking";
import { queryOptions } from "@tanstack/react-query";
import { readEnvironmentApi } from "~/environmentApi";

export interface ThreadSearchTarget {
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchAcrossEnvironmentsResult {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly truncated: boolean;
  readonly failedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

const THREAD_SEARCH_RESULT_LIMIT_PER_ENVIRONMENT = 50;
const THREAD_SEARCH_STALE_TIME_MS = 10_000;

export function canSearchThreadContent(query: string): boolean {
  return parseSearchQuery(query).clauses.some((clause) => Array.from(clause.value).length >= 3);
}

export function threadSearchQueryOptions(input: {
  readonly query: string;
  readonly targets: ReadonlyArray<ThreadSearchTarget>;
  readonly enabled?: boolean;
}) {
  const normalizedTargets = input.targets
    .map((target) => ({
      environmentId: target.environmentId,
      ...(target.projectIds ? { projectIds: [...target.projectIds].toSorted() } : {}),
    }))
    .toSorted((left, right) => left.environmentId.localeCompare(right.environmentId));

  return queryOptions({
    queryKey: ["orchestration", "thread-search", normalizedTargets, input.query] as const,
    queryFn: async (): Promise<ThreadSearchAcrossEnvironmentsResult> => {
      const searches = await Promise.allSettled(
        normalizedTargets.map(async (target) => {
          const api = readEnvironmentApi(target.environmentId);
          if (!api) {
            throw new Error(`Environment ${target.environmentId} is unavailable.`);
          }
          const result = await api.orchestration.searchThreads({
            query: input.query,
            limit: THREAD_SEARCH_RESULT_LIMIT_PER_ENVIRONMENT,
            ...(target.projectIds ? { projectIds: target.projectIds } : {}),
          });
          return { environmentId: target.environmentId, result };
        }),
      );

      const matches: EnvironmentThreadSearchMatch[] = [];
      const failedEnvironmentIds: EnvironmentId[] = [];
      let truncated = false;

      searches.forEach((search, index) => {
        const target = normalizedTargets[index];
        if (!target) {
          return;
        }
        if (search.status === "rejected") {
          failedEnvironmentIds.push(target.environmentId);
          return;
        }

        truncated ||= search.value.result.truncated;
        matches.push(
          ...search.value.result.matches.map((match) => ({
            ...match,
            environmentId: search.value.environmentId,
          })),
        );
      });

      return { matches, truncated, failedEnvironmentIds };
    },
    enabled:
      (input.enabled ?? true) &&
      normalizedTargets.length > 0 &&
      canSearchThreadContent(input.query),
    staleTime: THREAD_SEARCH_STALE_TIME_MS,
  });
}
