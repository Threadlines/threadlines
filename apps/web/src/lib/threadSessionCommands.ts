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

/**
 * Stop every thread under this one that is still going ("Stop N working
 * threads" in its menu, and the Stop button on its family's tab row). The
 * thread itself keeps running; the server decides which threads that is.
 */
export async function stopThreadsUnder(threadRef: ScopedThreadRef): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.children.stop",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    createdAt: new Date().toISOString(),
  });
}
