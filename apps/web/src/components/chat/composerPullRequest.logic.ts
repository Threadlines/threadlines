/**
 * What the composer's pull request row says, derived from the two reads that
 * feed it: the thread's own pull request (which the sidebar badge and the tab
 * already resolve) and, once it arrives, the detail the Pull request tab reads.
 *
 * The row renders from the first alone, so it appears with the thread rather
 * than a beat later, and gains its branch, its diff stat and its check rollup
 * when the detail lands.
 *
 * @module composerPullRequest.logic
 */
import type { PullRequestCheck, PullRequestDetail, PullRequestState } from "@threadlines/contracts";

import {
  summarizePullRequestChecks,
  pullRequestArmedToMerge,
  type ThreadPullRequest,
} from "../pull-requests/pullRequests.logic";

/**
 * How the check chip reads. `pending`, `success` and `failure` are the host's
 * own rollup; `queued` is a merge queue, which moves on its own and outranks
 * whatever the checks say; `none` is a pull request with no checks at all, and
 * `unknown` is the moment before the detail arrives. `merged` and `closed`
 * state a fact about the pull request rather than its checks.
 */
export type ComposerPullRequestChipTone =
  | "unknown"
  | "pending"
  | "success"
  | "failure"
  | "none"
  | "queued"
  | "merged"
  | "closed";

export interface ComposerPullRequestChip {
  readonly label: string;
  readonly tone: ComposerPullRequestChipTone;
  /**
   * Whether the chip opens the checks popover. A settled pull request has
   * nothing left to arm or wait for, so its chip is a word, not a button.
   */
  readonly interactive: boolean;
}

/** One status bucket of a check run, as the popover lists it. */
export interface ComposerPullRequestCheckBucket {
  readonly id: "pending" | "failure" | "success" | "skipped";
  readonly label: string;
  readonly count: number;
}

/** Everything the row draws, in the order it draws it. */
export interface ComposerPullRequestRowModel {
  readonly number: number;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  /** The host is landing it on its own: armed, or already in the merge queue. */
  readonly autoMergeEnabled: boolean;
  readonly title: string;
  readonly url: string;
  /** Absent until the detail arrives. */
  readonly projectTitle: string | null;
  readonly headBranch: string | null;
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  readonly chip: ComposerPullRequestChip;
}

/**
 * The buckets worth a row of their own, worst first: what is still running,
 * what failed, what passed, and what the host skipped. A bucket nobody is in
 * is left out rather than printed as a zero.
 */
export function composerPullRequestCheckBuckets(
  checks: readonly PullRequestCheck[],
): readonly ComposerPullRequestCheckBucket[] {
  const summary = summarizePullRequestChecks(checks);
  return (
    [
      { id: "pending", label: "In progress", count: summary.pending },
      { id: "failure", label: "Failed", count: summary.failing },
      { id: "success", label: "Passed", count: summary.passing },
      { id: "skipped", label: "Skipped", count: summary.skipped },
    ] as const
  ).filter((bucket) => bucket.count > 0);
}

/**
 * The chip's word and colour. A settled pull request says so and stops there;
 * a queued one leads with the queue, since that is the part that moves without
 * anyone here asking. Otherwise it is the check rollup, which reads as "CI"
 * whichever way it is going -- the dot carries that -- and as "No checks" only
 * where the host reported none at all.
 */
export function composerPullRequestChip(input: {
  readonly state: PullRequestState;
  readonly detail: PullRequestDetail | undefined;
}): ComposerPullRequestChip {
  if (input.state === "merged") {
    return { label: "Merged", tone: "merged", interactive: false };
  }
  if (input.state === "closed") {
    return { label: "Closed", tone: "closed", interactive: false };
  }
  const detail = input.detail;
  if (detail === undefined) {
    return { label: "CI", tone: "unknown", interactive: true };
  }
  if (detail.mergeQueue !== undefined && detail.mergeQueue.position !== null) {
    return { label: "Queued", tone: "queued", interactive: true };
  }
  if (detail.checksState === undefined && detail.checks.length === 0) {
    return { label: "No checks", tone: "none", interactive: true };
  }
  return {
    label: "CI",
    tone: detail.checksState ?? summarizePullRequestChecks(detail.checks).state,
    interactive: true,
  };
}

/**
 * The row for one thread's pull request. The state, number and title come from
 * the thread's own resolution so the row is never blank; everything the detail
 * alone knows waits for it rather than being guessed at.
 */
export function composerPullRequestRow(input: {
  readonly pullRequest: ThreadPullRequest;
  readonly detail: PullRequestDetail | undefined;
}): ComposerPullRequestRowModel {
  const { pullRequest, detail } = input;
  // The detail is the fresher read of the two: it is re-read while checks run,
  // while the listing behind the thread's resolution polls far more slowly.
  const state = detail?.state ?? pullRequest.state;
  return {
    number: pullRequest.number,
    state,
    isDraft: detail?.isDraft ?? pullRequest.isDraft,
    autoMergeEnabled: detail ? pullRequestArmedToMerge(detail) : pullRequest.autoMergeEnabled,
    title: detail?.title ?? pullRequest.title,
    url: detail?.url ?? pullRequest.url,
    projectTitle: detail?.projectTitle ?? null,
    headBranch: detail?.headBranch ?? null,
    diffStat: detail ? { additions: detail.additions, deletions: detail.deletions } : null,
    chip: composerPullRequestChip({ state, detail }),
  };
}

/**
 * Whether the "Merge when checks pass" toggle has anything to do. A host that
 * does not say whether the pull request is armed cannot be asked to arm it,
 * and neither can one that offers neither action.
 */
export function canToggleComposerAutoMerge(detail: PullRequestDetail | undefined): boolean {
  if (detail === undefined || detail.autoMergeEnabled === null) {
    return false;
  }
  return (
    detail.capabilities.actions.includes("enable-auto-merge") ||
    detail.capabilities.actions.includes("disable-auto-merge")
  );
}

/** The host's own checks page for a pull request. */
export function pullRequestChecksUrl(url: string): string {
  return `${url.replace(/\/+$/u, "")}/checks`;
}
