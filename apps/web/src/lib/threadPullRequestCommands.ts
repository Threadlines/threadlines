import type {
  DispatchResult,
  PullRequestMergeMethod,
  ScopedThreadRef,
} from "@threadlines/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "./utils";

/**
 * The pull request a switch belongs to: its number, and its address, which
 * lets the thread take on one it does not hold by number yet. Null is the
 * thread's own switch, for whatever pull request its checkout's branch has,
 * which only threads that set it before switches went by number still hold.
 */
export interface ThreadPullRequestSwitchTarget {
  readonly number: number;
  readonly url: string;
}

function switchTarget(pullRequest: ThreadPullRequestSwitchTarget | null) {
  return pullRequest === null
    ? {}
    : { pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url };
}

/**
 * Arm or disarm the server's watch on one of this thread's pull requests.
 *
 * While it is on, the server starts a turn in this thread whenever a check
 * fails, a reviewer comments, or the merge queue gives the pull request back,
 * and turning it on with a failure already there starts one right away. The
 * agent is told which folder the pull request's branch is checked out in when
 * it is not the thread's own. After a merge queue failure it puts the pull
 * request back in the queue once the agent's turn is over. It watches only
 * while the server runs, so a closed desktop app watches nothing. The caller
 * holds its own optimistic value until the read model catches up.
 */
export async function setThreadPullRequestAutoFix(
  threadRef: ScopedThreadRef,
  autoFix: boolean,
  pullRequest: ThreadPullRequestSwitchTarget | null,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.pull-request-automation.set",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    ...switchTarget(pullRequest),
    autoFix,
  });
}

/**
 * Ask the server to merge one of this thread's pull requests, by
 * `mergeMethod`, once its checks pass; null takes the request back. This is
 * for a host that cannot hold the instruction itself, and like the auto-fix
 * watch it only runs while the server does.
 */
export async function setThreadPullRequestAutoMerge(
  threadRef: ScopedThreadRef,
  mergeMethod: PullRequestMergeMethod | null,
  pullRequest: ThreadPullRequestSwitchTarget | null,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.pull-request-automation.set",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    ...switchTarget(pullRequest),
    autoMerge: mergeMethod,
  });
}

/**
 * Close a pull request's row above this thread's composer, or bring it back.
 * The thread holds the answer, so it stands after a restart and on every
 * device. Resolves to the sequence the server gave the write; rejects when the
 * environment is not connected. `composerPullRequestDismissals` is the caller.
 */
export async function setThreadPullRequestDismissed(
  threadRef: ScopedThreadRef,
  pullRequestNumber: number,
  dismissed: boolean,
): Promise<DispatchResult> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    throw new Error(`Environment ${threadRef.environmentId} is not connected.`);
  }
  return api.orchestration.dispatchCommand({
    type: "thread.pull-request.dismiss",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    number: pullRequestNumber,
    dismissed,
  });
}
