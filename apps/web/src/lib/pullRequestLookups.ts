import { useSurfaceAttended } from "~/lib/pageAttention";
import {
  PULL_REQUEST_LOOKUP_LIMIT,
  type EnvironmentId,
  type ProjectId,
  type PullRequestLookupEntry,
  type PullRequestLookupItem,
} from "@threadlines/contracts";
import { queryOptions, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  threadPullRequestFromLookup,
  type PullRequestLookupAnswer,
  type PullRequestLookupAnswers,
  type PullRequestLookupRequest,
} from "~/components/pull-requests/pullRequests.logic";
import { ensureEnvironmentApi } from "~/environmentApi";
import { useKept } from "~/hooks/useStableIdentity";

import {
  PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
  pullRequestQueryKeys,
} from "./pullRequestsReactQuery";

/** What one lookup holds: the host's answer, or word that this host cannot be asked. */
export type PullRequestLookupData =
  | {
      readonly supported: true;
      readonly pullRequest: PullRequestLookupEntry | null;
      /** When the host gave the answer; the server may have kept it a while. */
      readonly answeredAt: string;
      /** When the read behind it began; absent from older servers. */
      readonly observedAt?: string;
    }
  | { readonly supported: false };

/**
 * How long an answer that can still move holds when a surface mounts: the
 * server keeps one this long for every surface asking at about the same time.
 * Open pull requests and branches without one stay this short, since a merge
 * or a new pull request should show soon after it happens.
 */
const PULL_REQUEST_LOOKUP_STALE_TIME_MS = 30_000;

/** A thread nobody has on screen keeps its answer, so coming back to it shows it at once. */
const PULL_REQUEST_LOOKUP_GC_TIME_MS = 30 * 60_000;

/** Lookups asked for within this long of each other travel in one request. */
const PULL_REQUEST_LOOKUP_BATCH_WINDOW_MS = 10;

/**
 * How soon an answer is asked for again: an open pull request at the open
 * listing's pace, anything settled or missing at the settled listings' pace. A
 * merged number never changes, and a host that cannot be asked never will be.
 * A branch can always take a new pull request, so its answer is never final.
 */
function lookupRefetchIntervalMs(
  item: PullRequestLookupItem,
  data: PullRequestLookupData | undefined,
): number | false {
  if (data?.supported === false) {
    return false;
  }
  const state = data?.pullRequest?.state;
  if ("number" in item && state === "merged") {
    return false;
  }
  return state === "open"
    ? PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS
    : PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS;
}

/**
 * How long an answer counts as current, so a surface mounting or remounting
 * does not ask the host again for something that cannot have moved: anything
 * {@link lookupRefetchIntervalMs} never polls again is current for good, and
 * a closed pull request until its next poll. Each one costs a `gh` run, and a
 * long thread list asks about every row it shows.
 */
function lookupStaleTimeMs(
  item: PullRequestLookupItem,
  data: PullRequestLookupData | undefined,
): number {
  const refetchIntervalMs = lookupRefetchIntervalMs(item, data);
  if (refetchIntervalMs === false) {
    return Number.POSITIVE_INFINITY;
  }
  return "number" in item && data?.supported === true && data.pullRequest?.state === "closed"
    ? refetchIntervalMs
    : PULL_REQUEST_LOOKUP_STALE_TIME_MS;
}

interface PendingLookup {
  readonly item: PullRequestLookupItem;
  readonly resolve: (data: PullRequestLookupData) => void;
  readonly reject: (error: Error) => void;
}

interface PendingLookupBatch {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly lookups: PendingLookup[];
}

/** An item as the server's answers name it. */
const itemKey = (item: PullRequestLookupItem) =>
  "number" in item ? `n\u0000${item.number}` : `b\u0000${item.branch}`;

const pendingLookupBatches = new Map<string, PendingLookupBatch>();
let pendingLookupFlush: ReturnType<typeof setTimeout> | null = null;

/**
 * Each pull request is its own query, so an answer keeps its identity however
 * the set of threads changes around it, and follows its own schedule. The
 * reads still travel together: whatever is asked for within the batch window
 * goes to the server as one request per repository, at most
 * {@link PULL_REQUEST_LOOKUP_LIMIT} at a time.
 */
function requestPullRequestLookup(
  request: PullRequestLookupRequest,
): Promise<PullRequestLookupData> {
  return new Promise((resolve, reject) => {
    const batchKey = `${request.environmentId}\u0000${request.projectId}\u0000${request.repository}`;
    const batch = pendingLookupBatches.get(batchKey) ?? {
      environmentId: request.environmentId,
      projectId: request.projectId,
      repository: request.repository,
      lookups: [],
    };
    batch.lookups.push({ item: request.item, resolve, reject });
    pendingLookupBatches.set(batchKey, batch);
    pendingLookupFlush ??= setTimeout(flushPullRequestLookups, PULL_REQUEST_LOOKUP_BATCH_WINDOW_MS);
  });
}

function flushPullRequestLookups(): void {
  pendingLookupFlush = null;
  const batches = [...pendingLookupBatches.values()];
  pendingLookupBatches.clear();
  for (const batch of batches) {
    for (let start = 0; start < batch.lookups.length; start += PULL_REQUEST_LOOKUP_LIMIT) {
      void sendPullRequestLookups(
        batch,
        batch.lookups.slice(start, start + PULL_REQUEST_LOOKUP_LIMIT),
      );
    }
  }
}

/**
 * One request's worth. An item the host left unanswered fails on its own and
 * is retried with its query, without holding back the ones that were answered.
 */
async function sendPullRequestLookups(
  batch: PendingLookupBatch,
  lookups: readonly PendingLookup[],
): Promise<void> {
  try {
    const result = await ensureEnvironmentApi(batch.environmentId).pullRequests.lookup({
      projectId: batch.projectId,
      repository: batch.repository,
      items: lookups.map((lookup) => lookup.item),
    });
    if (!result.supported) {
      for (const lookup of lookups) lookup.resolve({ supported: false });
      return;
    }
    const answers = new Map(
      result.answers.map((answer) => [itemKey(answer.item), answer] as const),
    );
    for (const lookup of lookups) {
      const answer = answers.get(itemKey(lookup.item));
      if (answer === undefined) {
        lookup.reject(new Error("The host did not answer for this pull request."));
      } else {
        lookup.resolve({
          supported: true,
          pullRequest: answer.pullRequest,
          answeredAt: answer.answeredAt,
          ...(answer.observedAt === undefined ? {} : { observedAt: answer.observedAt }),
        });
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const lookup of lookups) lookup.reject(failure);
  }
}

export function pullRequestLookupQueryOptions(request: PullRequestLookupRequest) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.lookup(
      request.environmentId,
      request.projectId,
      request.repository,
      request.item,
    ),
    queryFn: () => requestPullRequestLookup(request),
    staleTime: (query) => lookupStaleTimeMs(request.item, query.state.data),
    gcTime: PULL_REQUEST_LOOKUP_GC_TIME_MS,
    refetchInterval: (query) => lookupRefetchIntervalMs(request.item, query.state.data),
    // A background tab drives no decisions, and the listings re-read on focus.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

function sameLookupRequests(
  kept: readonly PullRequestLookupRequest[],
  next: readonly PullRequestLookupRequest[],
): boolean {
  return (
    kept.length === next.length &&
    kept.every((request, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        request.key === other.key &&
        request.environmentId === other.environmentId &&
        request.projectId === other.projectId &&
        request.repository === other.repository
      );
    })
  );
}

/**
 * The answers to every lookup asked for, by `pullRequestLookupKey`. A thread
 * list rebuilt on every update keeps the same queries while it asks for the
 * same things. A lookup that starts again on a pull request it has an answer
 * for re-reads past a stale one at once, which is how a pull request that just
 * left the open listing is read the moment it does.
 */
export function usePullRequestLookups(
  requests: readonly PullRequestLookupRequest[],
): PullRequestLookupAnswers {
  const keptRequests = useKept(requests, sameLookupRequests);
  const attended = useSurfaceAttended();
  const combine = useCallback(
    (results: UseQueryResult<PullRequestLookupData>[]): PullRequestLookupAnswers => {
      const answers = new Map<string, PullRequestLookupAnswer>();
      results.forEach((result, index) => {
        const request = keptRequests[index];
        const data = result.data;
        if (request === undefined || data === undefined || !data.supported) {
          return;
        }
        const answeredAt = Date.parse(data.answeredAt) || result.dataUpdatedAt;
        // Weighed against the shared record by when its read began, as the
        // record is; an older server's answer cannot say, and yields to it.
        const observedAt = data.observedAt === undefined ? null : Date.parse(data.observedAt);
        answers.set(request.key, {
          pullRequest:
            data.pullRequest === null
              ? null
              : threadPullRequestFromLookup(data.pullRequest, request.repository, observedAt),
          updatedAt: data.pullRequest === null ? null : Date.parse(data.pullRequest.updatedAt) || 0,
          answeredAt,
        });
      });
      return answers;
    },
    [keptRequests],
  );
  return useQueries({
    // Polled only while the user is looking at the app; coming back reads
    // what went stale meanwhile (startPullRequestAttentionRefresh).
    queries: keptRequests.map((request) => ({
      ...pullRequestLookupQueryOptions(request),
      ...(attended ? {} : { refetchInterval: false as const }),
    })),
    combine,
  });
}
