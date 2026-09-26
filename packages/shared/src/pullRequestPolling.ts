/**
 * When a pull request is worth reading again soon. The composer's checks chip
 * and the Pull request tab re-read at this pace, and the server's automation
 * watcher looks at an armed thread's pull request at the same pace while its
 * checks run, so a check that turns red goes to the agent about when the chip
 * turns red.
 *
 * @module pullRequestPolling
 */
import type { PullRequestDetail } from "@threadlines/contracts";

/**
 * The pace while there is something to wait for: a running check, or a fresh
 * push whose checks the host has not queued yet.
 */
export const PULL_REQUEST_CHECKS_POLL_INTERVAL_MS = 20_000;

/** How long after a push a reader waits for the host to register the new commit's checks. */
export const PULL_REQUEST_FRESH_PUSH_WATCH_MS = 120_000;

/**
 * Whether the host is landing this pull request on its own: armed by the
 * standing instruction, or already taken into the base's merge queue. A queued
 * pull request need not carry the instruction any more, so the queue's own
 * position counts as much as the instruction does.
 */
export function pullRequestArmedToMerge(
  detail: Pick<PullRequestDetail, "autoMergeEnabled" | "mergeQueue">,
): boolean {
  return detail.autoMergeEnabled === true || (detail.mergeQueue?.position ?? null) !== null;
}

/**
 * Whether a verdict on the pull request's checks is on its way. A check still
 * running is the plain case. The other is the quiet moment right after a push
 * (an update from the base, a new commit) when the host has the commit but has
 * not queued its checks or decided whether it merges: a read then shows no
 * checks at all, and would otherwise sit on that answer until the next look.
 */
export function pullRequestChecksInMotion(
  detail: Pick<PullRequestDetail, "state" | "checks" | "mergeability" | "updatedAt">,
  now: number,
): boolean {
  if (detail.checks.some((check) => check.status === "pending")) {
    return true;
  }
  if (detail.state !== "open") {
    return false;
  }
  const unsettled = detail.checks.length === 0 || detail.mergeability === "unknown";
  const updatedAt = Date.parse(detail.updatedAt);
  return (
    unsettled && Number.isFinite(updatedAt) && now - updatedAt < PULL_REQUEST_FRESH_PUSH_WATCH_MS
  );
}

/**
 * Whether a pull request on screen should keep re-reading itself: while its
 * checks are in motion, and while the host is landing it on its own. In a merge
 * queue, or armed with nothing the host says is in the way, it can be queued,
 * merged or given back without anyone here asking, and the surfaces showing it
 * should see that happen. Armed but blocked (a review still owed, a failed
 * check) is a settled state: nothing moves until someone acts, and that act is
 * re-read on its own.
 */
export function shouldPollPullRequestDetail(
  detail: Pick<
    PullRequestDetail,
    | "state"
    | "checks"
    | "mergeability"
    | "updatedAt"
    | "mergeQueue"
    | "autoMergeEnabled"
    | "mergeGate"
  >,
  now: number,
): boolean {
  return (
    pullRequestChecksInMotion(detail, now) ||
    (detail.state === "open" && pullRequestArmedToMerge(detail) && detail.mergeGate !== "blocked")
  );
}
