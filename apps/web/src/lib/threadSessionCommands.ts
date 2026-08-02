import type { ScopedThreadRef } from "@threadlines/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "./utils";

/**
 * Stop the thread's provider session.
 *
 * Stopping tears down the runtime, which discards anything still living inside
 * it (background tasks, open approval prompts — the server expires those as
 * part of the stop). Callers that stop on the user's behalf must say so first.
 */
export async function stopThreadSession(threadRef: ScopedThreadRef): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.session.stop",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    createdAt: new Date().toISOString(),
  });
}
