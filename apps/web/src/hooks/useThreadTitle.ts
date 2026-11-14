import type { EnvironmentId, ThreadId } from "@threadlines/contracts";

import { selectEnvironmentState, useStore } from "../store";

/**
 * Another thread's title, live, for a link to it; null when this device does
 * not know it. In a file of its own: the sidebar and the row under the
 * message box read it at startup, and importing it from `childThreads.ts`
 * would pull that whole module into the startup code with it.
 */
export function useThreadTitle(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null | undefined,
): string | null {
  return useStore((state) =>
    threadId == null || environmentId === null
      ? null
      : (selectEnvironmentState(state, environmentId).threadShellById[threadId]?.title ?? null),
  );
}
