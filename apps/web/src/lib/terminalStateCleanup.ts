import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { type EnvironmentId, TERMINALS_PAGE_THREAD_ID, ThreadId } from "@threadlines/contracts";

interface TerminalRetentionThread {
  key: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

interface CollectActiveTerminalThreadIdsInput {
  snapshotThreads: readonly TerminalRetentionThread[];
  draftThreadKeys: Iterable<string>;
  /** Computers this app knows: each keeps its Terminals page's tabs. */
  environmentIds: Iterable<EnvironmentId>;
}

export function collectActiveTerminalThreadIds(
  input: CollectActiveTerminalThreadIdsInput,
): Set<string> {
  const activeThreadIds = new Set<string>();
  const snapshotThreadById = new Map(input.snapshotThreads.map((thread) => [thread.key, thread]));
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) continue;
    activeThreadIds.add(thread.key);
  }
  for (const draftThreadKey of input.draftThreadKeys) {
    const snapshotThread = snapshotThreadById.get(draftThreadKey);
    if (
      snapshotThread &&
      (snapshotThread.deletedAt !== null || snapshotThread.archivedAt !== null)
    ) {
      continue;
    }
    activeThreadIds.add(draftThreadKey);
  }
  const pageThreadId = ThreadId.make(TERMINALS_PAGE_THREAD_ID);
  for (const environmentId of input.environmentIds) {
    activeThreadIds.add(scopedThreadKey(scopeThreadRef(environmentId, pageThreadId)));
  }
  return activeThreadIds;
}
