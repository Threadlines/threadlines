import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  INBOX_AUTO_DONE_AFTER_DAYS,
  type InboxRemoteChild,
  resolveRemoteFamilyChildren,
} from "../components/Sidebar.logic";
import { useComputerLabel } from "../components/sidebar/linkedComputers";
import {
  type ComputerLinksEntry,
  useComputerLinksStore,
} from "../environments/links/computerLinks";
import { type AppState, useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { useSettings } from "./useSettings";

/** Every parent without children on other computers shares this. */
export const NO_REMOTE_CHILDREN: readonly InboxRemoteChild[] = [];

/**
 * Whether a computer still links to another, as its last links snapshot says.
 * Unknown (no snapshot yet, or one no longer live) reads as linked: only a
 * computer that says so has dropped the link.
 */
function stillLinked(entry: ComputerLinksEntry | undefined, environmentId: EnvironmentId) {
  if (entry === undefined || !entry.live) return true;
  return entry.snapshot.outbound.some(
    (link) =>
      link.remoteEnvironmentId === environmentId &&
      (link.state === "active" || link.state === "failed"),
  );
}

/**
 * The computers whose thread lists this app has: their threads speak for
 * themselves, so a parent's record of a child there stays out of its family.
 */
export function selectEnvironmentIdsWithThreads(state: AppState): string[] {
  return Object.entries(state.environmentStateById).flatMap(([environmentId, environment]) =>
    environment.bootstrapComplete ? [environmentId] : [],
  );
}

/**
 * A parent's children the app has no thread for (on a computer it can't see,
 * or a start with no thread yet), filed the way the sidebar files them. The
 * sidebar's families and the family tabs both read them through this.
 * `hasThread` says whether the app has a thread of the parent's computer.
 */
export function useRemoteFamilyChildren(nowIso: string) {
  const computerLinksByEnvironmentId = useComputerLinksStore((state) => state.byEnvironmentId);
  const computerLabel = useComputerLabel();
  const environmentIdsWithThreadsList = useStore(useShallow(selectEnvironmentIdsWithThreads));
  const environmentIdsWithThreads = useMemo(
    () => new Set<string>(environmentIdsWithThreadsList),
    [environmentIdsWithThreadsList],
  );
  const wrapUpChildThreadsOnFinish = useSettings((s) => s.wrapUpChildThreadsOnFinish);
  const wrapUpIdleThreads = useSettings((s) => s.wrapUpIdleThreads);
  return useCallback(
    (
      parent: SidebarThreadSummary,
      hasThread: (threadId: ThreadId) => boolean,
    ): readonly InboxRemoteChild[] =>
      (parent.remoteChildren?.length ?? 0) +
        (parent.remoteChildStarts?.length ?? 0) +
        (parent.localChildStarts?.length ?? 0) ===
      0
        ? NO_REMOTE_CHILDREN
        : resolveRemoteFamilyChildren({
            parent,
            canSeeComputer: (environmentId) => environmentIdsWithThreads.has(environmentId),
            computerLabel,
            hasThread,
            filing: {
              now: nowIso,
              wrapUpOnFinish: wrapUpChildThreadsOnFinish,
              autoDoneAfterDays: wrapUpIdleThreads ? INBOX_AUTO_DONE_AFTER_DAYS : null,
              linked: (environmentId) =>
                stillLinked(computerLinksByEnvironmentId[parent.environmentId], environmentId),
            },
          }),
    [
      computerLabel,
      computerLinksByEnvironmentId,
      environmentIdsWithThreads,
      nowIso,
      wrapUpChildThreadsOnFinish,
      wrapUpIdleThreads,
    ],
  );
}
