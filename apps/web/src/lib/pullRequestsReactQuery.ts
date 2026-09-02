import type { EnvironmentId, PullRequestListState } from "@threadlines/contracts";
import {
  keepPreviousData,
  queryOptions,
  useQueries,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import {
  mergePullRequestListResults,
  type PullRequestEntry,
  type PullRequestProjectFailure,
} from "~/components/pull-requests/pullRequests.logic";
import { ensureEnvironmentApi } from "~/environmentApi";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";

/** Matches the server's own listing cache, so a remount does not re-run `gh`. */
const PULL_REQUEST_STALE_TIME_MS = 30_000;

/** The page keeps the list current while it is on screen. */
export const PULL_REQUEST_PAGE_REFETCH_INTERVAL_MS = 60_000;

/** The sidebar count only has to be roughly right. */
export const PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS = 300_000;

export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  list: (environmentId: EnvironmentId, state: PullRequestListState) =>
    ["pull-requests", "list", environmentId, state] as const,
};

/** An environment whose server can answer a pull request listing. */
export interface PullRequestEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function pullRequestListQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly state: PullRequestListState;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.list(input.environmentId, input.state),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.list({ state: input.state }),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    // A refresh keeps the rows on screen: the list updates, it does not blink.
    placeholderData: keepPreviousData,
  });
}

/**
 * The refresh button. Writes through the same key the page and the sidebar
 * read, so one round trip updates both and the server drops its own cache
 * first rather than replaying the answer the user just rejected.
 */
export async function refreshPullRequestList(
  queryClient: QueryClient,
  input: { readonly environmentId: EnvironmentId; readonly state: PullRequestListState },
): Promise<void> {
  await queryClient.fetchQuery({
    ...pullRequestListQueryOptions(input),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.list({
        state: input.state,
        force: true,
      }),
    staleTime: 0,
  });
}

/**
 * Every environment that can serve the page: this device plus each connected
 * saved computer whose server reports the capability. A server too old to know
 * about pull requests omits the key, and an absent capability is a no.
 */
export function usePullRequestEnvironments(): readonly PullRequestEnvironment[] {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = readPrimaryEnvironmentDescriptor();
  const primarySupported = primaryDescriptor?.capabilities.pullRequests === true;
  const primaryLabel = primaryDescriptor?.label ?? null;
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  return useMemo(() => {
    const environments: PullRequestEnvironment[] = [];
    const seen = new Set<EnvironmentId>();

    if (primaryEnvironmentId && primarySupported) {
      seen.add(primaryEnvironmentId);
      environments.push({
        environmentId: primaryEnvironmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: true,
          environmentId: primaryEnvironmentId,
          runtimeLabel: primaryLabel,
        }),
      });
    }

    for (const environmentId of Object.keys(savedEnvironmentRuntimeById) as EnvironmentId[]) {
      if (seen.has(environmentId)) continue;
      const runtime = savedEnvironmentRuntimeById[environmentId];
      if (!runtime || runtime.connectionState !== "connected") continue;
      const descriptor = runtime.descriptor;
      if (!descriptor || descriptor.capabilities.pullRequests !== true) continue;
      seen.add(environmentId);
      environments.push({
        environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId,
          runtimeLabel: descriptor.label,
          savedLabel: savedEnvironmentsById[environmentId]?.label ?? null,
        }),
      });
    }

    return environments.toSorted((left, right) =>
      left.environmentId.localeCompare(right.environmentId),
    );
  }, [
    primaryEnvironmentId,
    primaryLabel,
    primarySupported,
    savedEnvironmentRuntimeById,
    savedEnvironmentsById,
  ]);
}

/** What one environment could not do, kept next to what the others returned. */
export interface PullRequestEnvironmentFailure {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly message: string;
}

export interface PullRequestListSnapshot {
  readonly environments: readonly PullRequestEnvironment[];
  readonly entries: readonly PullRequestEntry[];
  readonly failures: readonly PullRequestProjectFailure[];
  readonly environmentFailures: readonly PullRequestEnvironmentFailure[];
  readonly viewer: string | null;
  /** Nothing to show yet, not even a previous answer. */
  readonly isPending: boolean;
  readonly isFetching: boolean;
}

function describeListFailure(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  return "Unavailable";
}

/**
 * The page's and the sidebar's shared read. Every environment is asked in
 * parallel on the same keys, so whichever surface is mounted keeps the other
 * one warm, and one unreachable computer costs a notice rather than the list.
 */
export function usePullRequestLists(input: {
  readonly state: PullRequestListState;
  readonly refetchIntervalMs: number;
  readonly enabled?: boolean;
}): PullRequestListSnapshot {
  const environments = usePullRequestEnvironments();
  const enabled = input.enabled ?? true;
  const state = input.state;

  return useQueries({
    queries: environments.map((environment) => ({
      ...pullRequestListQueryOptions({ environmentId: environment.environmentId, state }),
      enabled,
      refetchInterval: input.refetchIntervalMs,
      // A background tab drives no decisions, and every poll spawns `gh`.
      refetchIntervalInBackground: false,
    })),
    combine: (results) => {
      // Placeholder data here is the previous tab's answer, held over while the
      // new one loads. Its rows are all filtered out by the state check, so
      // reading it would turn a tab switch into a flash of "nothing to show"
      // instead of the loading rows.
      const usableData = results.map((result) =>
        result.isPlaceholderData ? undefined : result.data,
      );
      const merged = mergePullRequestListResults({
        state,
        results: results.flatMap((_result, index) => {
          const environment = environments[index];
          return environment
            ? [
                {
                  environmentId: environment.environmentId,
                  environmentLabel: environment.label,
                  data: usableData[index],
                },
              ]
            : [];
        }),
      });

      return {
        environments,
        entries: merged.entries,
        failures: merged.failures,
        environmentFailures: results.flatMap((result, index) => {
          const environment = environments[index];
          return result.error && environment
            ? [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  message: describeListFailure(result.error),
                },
              ]
            : [];
        }),
        viewer: merged.viewer,
        isPending: results.length > 0 && usableData.every((data) => data === undefined),
        isFetching: results.some((result) => result.isFetching),
      };
    },
  });
}
