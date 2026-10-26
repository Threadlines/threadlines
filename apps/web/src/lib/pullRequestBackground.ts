/**
 * The pull request work that runs in the background for the app's life, loaded
 * and started after first paint: nothing here is needed to draw the first
 * screen, and keeping it out of the startup code keeps that code small.
 *
 * - Each connected computer's pull request records (pullRequestRecords.ts),
 *   which every surface showing a pull request reads.
 * - Coming back to the window re-reads what went stale while nobody looked.
 * - Sidebar rows on screen keep their pull requests current (pullRequestWatch.ts).
 */
import type { QueryClient } from "@tanstack/react-query";

import { readPullRequestRecord } from "~/environments/pullRequests/pullRequestRecordsStore";
import { startPullRequestRecordsSync } from "~/environments/pullRequests/pullRequestRecords";
import { isPageAttended, onPageAttentionChange } from "~/lib/pageAttention";
import { pullRequestLookupQueryOptions } from "~/lib/pullRequestLookups";
import { watchedPullRequestsOnScreen } from "~/lib/pullRequestWatch";
import {
  duePullRequestWatches,
  pullRequestWatchIntervalMs,
  type PullRequestWatchEntry,
} from "~/lib/pullRequestWatch.logic";
import {
  markPullRequestListSettled,
  startPullRequestAttentionRefresh,
} from "~/lib/pullRequestsReactQuery";

/** How often the schedule is looked at; a read is due within this of its pace. */
const PULL_REQUEST_WATCH_TICK_MS = 10_000;

function readDuePullRequests(queryClient: QueryClient): void {
  if (!isPageAttended()) return;
  const nowMs = Date.now();
  const entries: PullRequestWatchEntry<ReturnType<typeof pullRequestLookupQueryOptions>>[] = [];
  for (const pullRequest of watchedPullRequestsOnScreen()) {
    const options = pullRequestLookupQueryOptions({
      key: `${pullRequest.repository.toLowerCase()}#${pullRequest.number}`,
      environmentId: pullRequest.environmentId,
      projectId: pullRequest.projectId,
      repository: pullRequest.repository,
      item: { number: pullRequest.number },
    });
    const query = queryClient.getQueryState(options.queryKey);
    if (query?.fetchStatus === "fetching") continue;
    const data = query?.data;
    if (data?.supported === false) continue;
    const answer = data?.pullRequest ?? null;
    // The record is what the row shows; the lookup's own answer fills in
    // until a record arrives.
    const record = readPullRequestRecord(pullRequest.environmentId, pullRequest);
    const intervalMs = pullRequestWatchIntervalMs({
      state: record?.state ?? answer?.state ?? null,
      autoMergeEnabled: record?.autoMergeEnabled ?? answer?.autoMergeEnabled ?? false,
      checksState: record?.checks?.state ?? null,
      busy: pullRequest.busy,
      updatedAgoMs: answer === null ? null : nowMs - Date.parse(answer.updatedAt),
      lastReadFailed: query?.status === "error",
    });
    if (intervalMs === null) continue;
    // A failed read counts as a read, or a host that refuses would be asked
    // again on every tick.
    const lastReadAt = Math.max(query?.dataUpdatedAt ?? 0, query?.errorUpdatedAt ?? 0);
    entries.push({
      value: options,
      batchKey: `${pullRequest.environmentId}|${pullRequest.projectId}|${pullRequest.repository.toLowerCase()}`,
      intervalMs,
      ageMs: lastReadAt > 0 ? nowMs - lastReadAt : Number.POSITIVE_INFINITY,
    });
  }
  // Asked for together, so each repository's go out as one request.
  for (const options of duePullRequestWatches(entries)) {
    void queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined);
  }
}

/**
 * Reads the watched pull requests as they come due, and at once when the user
 * comes back to the window.
 */
function startPullRequestWatch(queryClient: QueryClient): () => void {
  const timer = window.setInterval(
    () => readDuePullRequests(queryClient),
    PULL_REQUEST_WATCH_TICK_MS,
  );
  const stopAttention = onPageAttentionChange(() => readDuePullRequests(queryClient));
  return () => {
    window.clearInterval(timer);
    stopAttention();
  };
}

/** Starts everything above; the returned function stops it. Started once. */
export function startPullRequestBackground(queryClient: QueryClient): () => void {
  const stopAttention = startPullRequestAttentionRefresh(queryClient);
  const stopWatch = startPullRequestWatch(queryClient);
  const stopRecords = startPullRequestRecordsSync({
    onSettled: (environmentId, record) => {
      if (record.state === "open") return;
      markPullRequestListSettled(queryClient, { environmentId, state: record.state });
    },
  });
  return () => {
    stopRecords();
    stopWatch();
    stopAttention();
  };
}
