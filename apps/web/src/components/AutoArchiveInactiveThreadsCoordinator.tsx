import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { newCommandId } from "../lib/utils";
import { selectAutoArchiveCandidates, type AutoArchiveCandidate } from "../threadAutoArchive";
import { resolveThreadRouteRef } from "../threadRoutes";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { stackedThreadToast, toastManager } from "./ui/toast";

const AUTO_ARCHIVE_COMMAND_DELAY_MS = 25;
const AUTO_ARCHIVE_RETRY_WINDOW_MS = 60_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function threadKey(thread: Pick<AutoArchiveCandidate, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function AutoArchiveInactiveThreadsCoordinator() {
  const clientSettingsHydrated = useClientSettingsHydrated();
  const autoArchiveInactiveThreadsDays = useSettings(
    (settings) => settings.autoArchiveInactiveThreadsDays,
  );
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const pathname = useLocation({ select: (location) => location.pathname });
  const router = useRouter();
  const pendingThreadKeysRef = useRef(new Set<string>());
  const lastCandidateKeyRef = useRef<string | null>(null);
  const lastAttemptMsRef = useRef(0);

  const currentRouteThreadKey = useMemo(() => {
    if (pathname.length === 0) {
      return null;
    }
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    const threadRef = resolveThreadRouteRef(params);
    return threadRef ? scopedThreadKey(threadRef) : null;
  }, [pathname, router]);

  const excludeThreadKeys = useMemo(
    () => (currentRouteThreadKey ? new Set([currentRouteThreadKey]) : undefined),
    [currentRouteThreadKey],
  );

  const candidates = useMemo(
    () =>
      selectAutoArchiveCandidates({
        threads: sidebarThreads,
        inactiveDays: autoArchiveInactiveThreadsDays,
        excludeThreadKeys,
      }),
    [autoArchiveInactiveThreadsDays, excludeThreadKeys, sidebarThreads],
  );
  const candidateKey = useMemo(
    () => candidates.map((candidate) => threadKey(candidate)).join("\n"),
    [candidates],
  );

  const archiveCandidates = useEffectEvent(async (threads: ReadonlyArray<AutoArchiveCandidate>) => {
    const pendingThreadKeys = pendingThreadKeysRef.current;
    const archiveableThreads = threads.filter(
      (thread) => !pendingThreadKeys.has(threadKey(thread)),
    );
    if (archiveableThreads.length === 0) {
      return;
    }

    for (const thread of archiveableThreads) {
      pendingThreadKeys.add(threadKey(thread));
    }

    let archivedCount = 0;
    let failedCount = 0;

    try {
      for (const thread of archiveableThreads) {
        const api = readEnvironmentApi(thread.environmentId);
        if (!api) {
          failedCount += 1;
          continue;
        }

        try {
          await api.orchestration.dispatchCommand({
            type: "thread.archive",
            commandId: newCommandId(),
            threadId: thread.id,
          });
          archivedCount += 1;
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        } catch (error) {
          failedCount += 1;
          console.warn("Auto-archive failed for inactive thread", {
            threadId: thread.id,
            environmentId: thread.environmentId,
            error,
          });
        }

        await wait(AUTO_ARCHIVE_COMMAND_DELAY_MS);
      }
    } finally {
      for (const thread of archiveableThreads) {
        pendingThreadKeys.delete(threadKey(thread));
      }
    }

    if (archivedCount > 0) {
      toastManager.add({
        type: "success",
        title:
          archivedCount === 1
            ? "Archived one inactive thread"
            : `Archived ${archivedCount} inactive threads`,
        description: "Archived threads stay available from Settings.",
      });
    }

    if (failedCount > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title:
            failedCount === 1
              ? "One inactive thread could not be archived"
              : `${failedCount} inactive threads could not be archived`,
          description: "Threadlines will try again after the environment refreshes.",
        }),
      );
    }
  });

  useEffect(() => {
    if (
      !clientSettingsHydrated ||
      autoArchiveInactiveThreadsDays === 0 ||
      candidates.length === 0
    ) {
      return;
    }

    const nowMs = Date.now();
    if (
      candidateKey === lastCandidateKeyRef.current &&
      nowMs - lastAttemptMsRef.current < AUTO_ARCHIVE_RETRY_WINDOW_MS
    ) {
      return;
    }

    lastCandidateKeyRef.current = candidateKey;
    lastAttemptMsRef.current = nowMs;
    void archiveCandidates(candidates);
  }, [autoArchiveInactiveThreadsDays, candidateKey, candidates, clientSettingsHydrated]);

  return null;
}
