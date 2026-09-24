/**
 * What the composer's pull request row says, derived from the two reads that
 * feed it: the thread's own pull request (which the sidebar badge and the tab
 * already resolve) and, once it arrives, the detail the Pull request tab reads.
 *
 * The row renders whole from the first: the listing behind it already knows
 * the branch and the size, and the project is the thread's own. The detail
 * only sharpens what is there and adds the check rollup.
 *
 * @module composerPullRequest.logic
 */
import type {
  PullRequestCheck,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestState,
} from "@threadlines/contracts";
import {
  resolvePullRequestAutoMergeStep,
  type PullRequestAutoMergeStep,
} from "@threadlines/shared/pullRequestAutoMerge";

import {
  summarizePullRequestChecks,
  pullRequestArmedToMerge,
  resolveMergeWhenReadyBlock,
  resolvePullRequestAutoMergeBlock,
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
  /** It lands on its own: armed on the host or by this thread, or already queued. */
  readonly autoMergeEnabled: boolean;
  readonly title: string;
  readonly url: string;
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
  if (isInMergeQueue(detail)) {
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
 * The row for one thread's pull request. Everything the thread's own
 * resolution and its project know is drawn at once; the detail, which is a
 * slower read, replaces those figures with fresher ones when it lands rather
 * than being what the row waits for.
 */
export function composerPullRequestRow(input: {
  readonly pullRequest: ThreadPullRequest;
  /** The thread's project, which is the pull request's too. */
  readonly projectTitle: string | null;
  readonly detail: PullRequestDetail | undefined;
  /** This thread asked the server to merge it once its checks pass. */
  readonly threadAutoMerge: boolean;
}): ComposerPullRequestRowModel {
  const { pullRequest, detail } = input;
  // The detail is the fresher read of the two: it is re-read while checks run,
  // while the listing behind the thread's resolution polls far more slowly.
  const state = detail?.state ?? pullRequest.state;
  return {
    number: pullRequest.number,
    state,
    isDraft: detail?.isDraft ?? pullRequest.isDraft,
    autoMergeEnabled:
      input.threadAutoMerge ||
      (detail ? pullRequestArmedToMerge(detail) : pullRequest.autoMergeEnabled),
    title: detail?.title ?? pullRequest.title,
    url: detail?.url ?? pullRequest.url,
    projectTitle: input.projectTitle ?? detail?.projectTitle ?? null,
    headBranch: detail?.headBranch ?? pullRequest.headBranch,
    diffStat: detail
      ? { additions: detail.additions, deletions: detail.deletions }
      : pullRequest.diffStat,
    chip: composerPullRequestChip({ state, detail }),
  };
}

function isInMergeQueue(detail: Pick<PullRequestDetail, "mergeQueue">): boolean {
  return detail.mergeQueue !== undefined && detail.mergeQueue.position !== null;
}

/**
 * What the popover shows in place of "Merge when checks pass".
 *
 * `toggle` is the ordinary case: the switch arms or disarms the host's standing
 * instruction. `server` is the same switch held by this thread instead, for a
 * GitHub repository that cannot hold it (auto-merge off, no required checks so
 * GitHub would merge at once, or checks that have already passed); `status`
 * says what the server is waiting on, or that it has nothing to wait for.
 * `queued` is a pull request the host has already taken into its merge queue:
 * GitHub drops the instruction at that point, so a switch would read as off
 * while the merge is in motion. Unavailable actions explain why and lead to
 * the full merge controls instead.
 */
export type ComposerAutoMergeControl =
  | { readonly kind: "hidden" }
  | { readonly kind: "queued" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "toggle"; readonly checked: boolean }
  | { readonly kind: "server"; readonly checked: boolean; readonly status: string | null };

/** What the server weighs, besides the pull request itself, before it merges. */
interface ServerAutoMergeContext {
  /** The thread's auto-fix watch, which turns a failing check into one to wait out. */
  readonly autoFix: boolean;
  /** The agent is mid-turn, and may be about to push. */
  readonly agentWorking: boolean;
  /** Commits on the thread's branch that the host has not seen yet. */
  readonly unpushedCommits: number;
  readonly now: number;
}

export function composerAutoMergeControl(
  input: ServerAutoMergeContext & {
    readonly detail: PullRequestDetail | undefined;
    /** The thread's own request that the server merge it, or null. */
    readonly threadAutoMerge: PullRequestMergeMethod | null;
  },
): ComposerAutoMergeControl {
  const { detail } = input;
  if (detail === undefined || detail.state !== "open") {
    return { kind: "hidden" };
  }
  if (isInMergeQueue(detail)) {
    return { kind: "queued" };
  }
  // Whatever the host now says, a request the thread already made stays in
  // view, so it can always be taken back.
  if (input.threadAutoMerge !== null) {
    const step = serverAutoMergeStep(detail, input);
    return {
      kind: "server",
      checked: true,
      status: step.kind === "merge" ? "Merging shortly" : step.reason,
    };
  }
  if (!detail.viewer.canWrite) {
    return { kind: "unavailable", reason: "Write access is needed to merge" };
  }
  const hostCanArm =
    detail.autoMergeEnabled !== null &&
    detail.capabilities.actions.includes(
      detail.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge",
    );
  if (hostCanArm && detail.autoMergeEnabled) {
    return { kind: "toggle", checked: true };
  }
  const hostBlock = hostCanArm ? resolvePullRequestAutoMergeBlock(detail) : null;
  if (hostCanArm && hostBlock === null) {
    return { kind: "toggle", checked: false };
  }
  if (detail.provider === "github" && detail.capabilities.actions.includes("merge")) {
    return serverAutoMergeOffer(detail, input);
  }
  if (hostBlock !== null) {
    return { kind: "unavailable", reason: hostBlock };
  }
  if (detail.autoMergeEnabled === null) {
    return { kind: "hidden" };
  }
  return { kind: "unavailable", reason: "Auto-merge is not available for this repository" };
}

/**
 * Whether the server can take the merge on. Anything it would not give up on
 * at once can be handed over: a pull request with nothing left to wait for is
 * merged as soon as the server looks, which is as soon as the switch comes on,
 * and the switch says so before it is clicked. A draft or a conflict needs
 * someone to act first, and a failing check with nobody fixing it would only
 * end the wait at once.
 */
function serverAutoMergeOffer(
  detail: PullRequestDetail,
  context: ServerAutoMergeContext,
): ComposerAutoMergeControl {
  const block = resolveMergeWhenReadyBlock(detail);
  if (block !== null) {
    return { kind: "unavailable", reason: block };
  }
  const failing =
    detail.checksState === "failure" || summarizePullRequestChecks(detail.checks).failing > 0;
  if (failing && !context.autoFix) {
    return {
      kind: "unavailable",
      reason: "A check failed. Turn on fixing below to wait for a fix.",
    };
  }
  return {
    kind: "server",
    checked: false,
    status:
      serverAutoMergeStep(detail, context).kind === "merge"
        ? "Nothing left to wait for, so it merges right away"
        : null,
  };
}

/**
 * The server's next step, in its own words: the shared rule, and before it the
 * watcher's own hold on a thread whose agent is mid-turn, which it passes over
 * until the turn ends.
 */
function serverAutoMergeStep(
  detail: PullRequestDetail,
  context: ServerAutoMergeContext,
): PullRequestAutoMergeStep {
  const step = resolvePullRequestAutoMergeStep({
    detail,
    autoFix: context.autoFix,
    unpushedCommits: context.unpushedCommits,
    now: context.now,
  });
  return step.kind !== "stop" && context.agentWorking
    ? { kind: "wait", reason: "Waiting for the agent to finish" }
    : step;
}

/**
 * Whether the popover offers "Fix failing checks and review comments". Only
 * GitHub is watched, and only while the detail says so: until it lands there is
 * nothing to say the host is one the server can read, so the switch waits
 * rather than appearing and then vanishing.
 */
export function composerAutoFixOffered(detail: PullRequestDetail | undefined): boolean {
  return detail?.provider === "github";
}

/** The host's own checks page for a pull request. */
export function pullRequestChecksUrl(url: string): string {
  return `${url.replace(/\/+$/u, "")}/checks`;
}
