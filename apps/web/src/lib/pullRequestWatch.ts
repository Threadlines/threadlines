/**
 * Keeps the pull requests the sidebar shows current while the user can see
 * them. A thread row in the Active section shows its pull request's state
 * without the thread being open, so a row on screen is watched like an open
 * thread is, at a pace set by how much is going on with it:
 *
 * - something moving (the thread's agent at work, armed to merge or queued,
 *   checks running, or changed in the last ten minutes): every half minute;
 * - open and quiet, drafts included: every minute and a half;
 * - closed, which can still be reopened: every five minutes;
 * - merged: never again.
 *
 * Reads are the lookups the rest of the app uses (pullRequestLookups.ts), so
 * every row of one repository travels in one request, and a row due soon goes
 * along with one that is due now rather than costing a request of its own. The
 * answers land in the computer's shared record, which every surface reads.
 * Nothing is read while the window is not looked at, nor for a row scrolled
 * out of view, nor for the thread already open (its composer row reads it).
 */
import type { EnvironmentId, ProjectId } from "@threadlines/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { readPullRequestRecord } from "~/environments/pullRequests/pullRequestRecordsStore";
import { useKept } from "~/hooks/useStableIdentity";
import { isPageAttended, onPageAttentionChange } from "~/lib/pageAttention";
import { pullRequestLookupQueryOptions } from "~/lib/pullRequestLookups";
import {
  duePullRequestWatches,
  pullRequestWatchIntervalMs,
  type PullRequestWatchEntry,
} from "~/lib/pullRequestWatch.logic";

/** A pull request a sidebar row shows. */
export interface WatchedPullRequest {
  readonly environmentId: EnvironmentId;
  /** The thread's project, whose checkout can read the repository. */
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  /** The thread's agent is at work: a push, a merge or a new pull request may come any moment. */
  readonly busy: boolean;
}

/** How often the schedule is looked at; a read is due within this of its pace. */
const PULL_REQUEST_WATCH_TICK_MS = 10_000;

/** Each row's pull requests, while the row is on screen. */
const shownRows = new Map<Element, readonly WatchedPullRequest[]>();
const registeredRows = new Map<Element, readonly WatchedPullRequest[]>();
let rowObserver: IntersectionObserver | null = null;

function observeRows(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  rowObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pullRequests = registeredRows.get(entry.target);
      if (entry.isIntersecting && pullRequests !== undefined) {
        shownRows.set(entry.target, pullRequests);
      } else {
        shownRows.delete(entry.target);
      }
    }
  });
  return rowObserver;
}

function sameWatchedPullRequests(
  kept: readonly WatchedPullRequest[],
  next: readonly WatchedPullRequest[],
): boolean {
  return (
    kept.length === next.length &&
    kept.every((pullRequest, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        pullRequest.environmentId === other.environmentId &&
        pullRequest.projectId === other.projectId &&
        pullRequest.repository === other.repository &&
        pullRequest.number === other.number &&
        pullRequest.url === other.url &&
        pullRequest.busy === other.busy
      );
    })
  );
}

/**
 * Watches a row's pull requests while the row is on screen. Pass an empty
 * list for a row that should not be watched (the thread already open).
 */
export function useWatchPullRequestsWhileShown(
  element: Element | null,
  pullRequests: readonly WatchedPullRequest[],
): void {
  // Rows render often; the watch changes only when what it would read does.
  const kept = useKept(pullRequests, sameWatchedPullRequests);
  const watches = kept.length > 0;
  useEffect(() => {
    if (element === null || !watches) return;
    const observer = observeRows();
    if (observer === null) return;
    observer.observe(element);
    return () => {
      observer.unobserve(element);
      registeredRows.delete(element);
      shownRows.delete(element);
    };
  }, [element, watches]);
  useEffect(() => {
    if (element === null || !watches) return;
    registeredRows.set(element, kept);
    if (shownRows.has(element)) shownRows.set(element, kept);
  }, [element, kept, watches]);
}

function watchedPullRequestsOnScreen(): readonly WatchedPullRequest[] {
  const byKey = new Map<string, WatchedPullRequest>();
  for (const pullRequests of shownRows.values()) {
    for (const pullRequest of pullRequests) {
      const key = `${pullRequest.environmentId}|${pullRequest.repository.toLowerCase()}#${pullRequest.number}`;
      const held = byKey.get(key);
      // Two rows on one pull request: either one being busy makes it busy.
      if (held === undefined || (!held.busy && pullRequest.busy)) byKey.set(key, pullRequest);
    }
  }
  return [...byKey.values()];
}

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
 * comes back to the window. Started once, for the app's life.
 */
export function startPullRequestWatch(queryClient: QueryClient): () => void {
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
