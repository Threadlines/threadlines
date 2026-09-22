/**
 * Whether a thread's "Merge when checks pass" should merge its pull request
 * now, keep waiting, or give up, for a host that cannot hold that instruction
 * itself and leaves the server to carry it out.
 *
 * Pure so the watcher's behaviour is testable without a host, and shared so the
 * composer says what the merge is waiting on in the same words the server
 * decides by.
 *
 * @module pullRequestAutoMerge
 */
import type { PullRequestDetail } from "@threadlines/contracts";

/**
 * How long after the pull request last changed the server holds off. A push
 * leaves a moment where the host has the commit but has not yet listed every
 * check it will run, and a rollup read then looks finished when it is not.
 */
export const PULL_REQUEST_AUTO_MERGE_SETTLE_MS = 60_000;

export type PullRequestAutoMergeStep =
  | { readonly kind: "merge" }
  /** Nothing is wrong yet; `reason` is what it is waiting on. */
  | { readonly kind: "wait"; readonly reason: string }
  /** Waiting would never end on its own; `reason` says why it stopped. */
  | { readonly kind: "stop"; readonly reason: string };

export interface PullRequestAutoMergeInput {
  readonly detail: Pick<
    PullRequestDetail,
    | "state"
    | "isDraft"
    | "mergeability"
    | "mergeGate"
    | "checks"
    | "checksState"
    | "updatedAt"
    | "viewer"
    | "capabilities"
  >;
  /**
   * The thread also fixes failing checks on its own, so a failure is something
   * to wait out rather than a reason to stop.
   */
  readonly autoFix: boolean;
  /** Commits on the thread's branch that have not reached the host yet. */
  readonly unpushedCommits: number;
  readonly now: number;
}

/**
 * The next step for an open pull request. Worst first: what can never merge,
 * then what someone has to act on, then what only needs time.
 */
export function resolvePullRequestAutoMergeStep(
  input: PullRequestAutoMergeInput,
): PullRequestAutoMergeStep {
  const { detail } = input;
  if (detail.state !== "open") {
    return { kind: "stop", reason: `The pull request is ${detail.state}` };
  }
  if (!detail.viewer.canWrite || !detail.capabilities.actions.includes("merge")) {
    return { kind: "stop", reason: "Write access is needed to merge" };
  }
  const failing =
    detail.checksState === "failure" || detail.checks.some((check) => check.status === "failure");
  if (failing && !input.autoFix) {
    return { kind: "stop", reason: "A check failed" };
  }
  if (detail.isDraft) {
    return { kind: "wait", reason: "Waiting for it to be marked ready" };
  }
  if (detail.mergeability === "conflicting") {
    return { kind: "wait", reason: "Waiting for the conflicts to be resolved" };
  }
  if (input.unpushedCommits > 0) {
    return { kind: "wait", reason: "Waiting for local commits to be pushed" };
  }
  if (failing) {
    return { kind: "wait", reason: "Waiting for the failing checks to be fixed" };
  }
  const updatedAt = Date.parse(detail.updatedAt);
  const settling =
    Number.isFinite(updatedAt) && input.now - updatedAt < PULL_REQUEST_AUTO_MERGE_SETTLE_MS;
  if (
    settling ||
    detail.checksState === "pending" ||
    detail.checks.some((check) => check.status === "pending")
  ) {
    return { kind: "wait", reason: "Waiting for checks" };
  }
  if (detail.mergeGate === "blocked") {
    return { kind: "wait", reason: "Waiting for required reviews" };
  }
  if (detail.mergeGate === "behind") {
    return { kind: "wait", reason: "Waiting for the branch to be updated" };
  }
  // The host has not decided yet whether its rules would take the merge.
  if (detail.mergeGate === undefined || detail.mergeability === "unknown") {
    return { kind: "wait", reason: "Waiting for GitHub to allow the merge" };
  }
  return { kind: "merge" };
}
