import type { ScopedThreadRef } from "@threadlines/contracts";

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
