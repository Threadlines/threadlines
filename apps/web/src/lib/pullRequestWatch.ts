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
 *
 * This module is what the rows need, so it loads with the sidebar; the
 * schedule that reads them starts after first paint (pullRequestBackground.ts).
 */
import type { EnvironmentId, ProjectId } from "@threadlines/contracts";
import { useEffect } from "react";

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

/**
 * Watches a row's pull requests while the row is on screen. Pass an empty
 * list for a row that should not be watched (the thread already open).
 */
export function useWatchPullRequestsWhileShown(
  element: Element | null,
  pullRequests: readonly WatchedPullRequest[],
): void {
  const watches = pullRequests.length > 0;
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
  // The newest list after every render: rows render often, and filing a list
  // costs less than telling two apart.
  useEffect(() => {
    if (element === null || !watches) return;
    registeredRows.set(element, pullRequests);
    if (shownRows.has(element)) shownRows.set(element, pullRequests);
  });
}

/** Every pull request a row on screen shows, once each. */
export function watchedPullRequestsOnScreen(): readonly WatchedPullRequest[] {
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
