import type { PullRequestMergeMethod, ScopedThreadRef } from "@threadlines/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "./utils";

/**
 * Arm or disarm the server's watch on this thread's pull request.
 *
 * While it is on, the server starts a turn in this thread whenever a check
 * fails or a reviewer comments. It watches only while the server runs, so a
 * closed desktop app watches nothing. The caller holds its own optimistic
 * value until the read model catches up.
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
 * the server does.
 */
export async function setThreadPullRequestAutoMerge(
  threadRef: ScopedThreadRef,
  mergeMethod: PullRequestMergeMethod | null,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.pull-request-automation.set",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    autoMerge: mergeMethod,
  });
}
