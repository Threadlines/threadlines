import type {
  DispatchResult,
  PullRequestMergeMethod,
  ScopedThreadRef,
} from "@threadlines/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "./utils";

/**
 * Arm or disarm the server's watch on this thread's pull request.
 *
 * While it is on, the server starts a turn in this thread whenever a check
 * fails, a reviewer comments, or the merge queue gives the pull request back,
 * and turning it on with a failure already there starts one right away. After
 * a merge queue failure it puts the pull request back in the queue once the
 * agent's turn is over. It watches only while the server runs, so a closed
 * desktop app watches nothing. The caller holds its own optimistic value until
 * the read model catches up.
 */
export async function setThreadPullRequestAutoFix(
  threadRef: ScopedThreadRef,
  autoFix: boolean,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.pull-request-automation.set",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    autoFix,
  });
}

/**
 * Ask the server to merge this thread's pull request, by `mergeMethod`, once
 * its checks pass; null takes the request back. This is for a host that cannot
 * hold the instruction itself, and like the auto-fix watch it only runs while
 * the server does. With `pullRequestNumber` it is the switch of that linked
 * pull request instead of the one on the thread's own branch.
 */
export async function setThreadPullRequestAutoMerge(
  threadRef: ScopedThreadRef,
  mergeMethod: PullRequestMergeMethod | null,
  pullRequestNumber: number | null = null,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.pull-request-automation.set",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    ...(pullRequestNumber === null ? {} : { pullRequestNumber }),
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
