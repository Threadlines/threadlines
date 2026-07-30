/**
 * Inbox lifecycle state, shared across devices.
 *
 * "Where does this thread belong" (Active vs Wrapped) and "have I seen it"
 * used to live in each browser's localStorage, so a phone opened through the
 * relay disagreed with the desktop about both. They now live on the thread on
 * the server; this module is the one place that writes them.
 *
 * Every write is optimistic: the row moves immediately from an in-memory
 * overlay, the command goes out, and the overlay retires once the server's
 * value moves off the baseline the write was made against. A rejected
 * dispatch drops its overlay, so no path leaves a device showing a state the
 * server never heard of.
 */
import { parseScopedThreadKey, scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import type { EnvironmentId, ScopedThreadRef } from "@threadlines/contracts";

import { mergeThreadDoneOverride, mergeThreadLastSeenAt } from "../components/Sidebar.logic";
import type { ThreadDoneOverride } from "../components/Sidebar.logic";
import { readEnvironmentApi } from "../environmentApi";
import {
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import {
  dropLegacyInboxState,
  readLegacyInboxState,
  useUiStateStore,
  type UiState,
} from "../uiStateStore";
import { newCommandId } from "./utils";

/** This device's answer for a thread's inbox filing: overlay over server. */
export function selectThreadDoneOverride(
  uiState: UiState,
  threadKey: string,
  serverDoneOverride: ThreadDoneOverride | null | undefined,
): ThreadDoneOverride | null {
  return mergeThreadDoneOverride(uiState.doneThreadOverlays[threadKey], serverDoneOverride);
}

/** This device's answer for when a thread was last seen: overlay, server, seed. */
export function selectThreadLastSeenAt(
  uiState: UiState,
  threadKey: string,
  serverLastSeenAt: string | null | undefined,
): string | undefined {
  return mergeThreadLastSeenAt({
    overlayAt: uiState.seenThreadOverlays[threadKey]?.at,
    serverLastSeenAt,
    seedAt: uiState.threadSeedVisitedAtById[threadKey],
  });
}

function readServerLifecycle(threadRef: ScopedThreadRef): {
  readonly doneOverride: ThreadDoneOverride | null;
  readonly lastSeenAt: string | null;
} {
  const summary = selectSidebarThreadSummaryByRef(useStore.getState(), threadRef);
  return {
    doneOverride: summary?.doneOverride ?? null,
    lastSeenAt: summary?.lastSeenAt ?? null,
  };
}

function dispatchDoneOverride(
  threadRef: ScopedThreadRef,
  state: "done" | "active",
  at: string,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    return Promise.reject(new Error(`Environment ${threadRef.environmentId} is not connected.`));
  }
  return api.orchestration
    .dispatchCommand({
      type: "thread.done-override.set",
      commandId: newCommandId(),
      threadId: threadRef.threadId,
      state,
      at,
    })
    .then(() => undefined);
}

function dispatchSeen(threadRef: ScopedThreadRef, at: string): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    return Promise.reject(new Error(`Environment ${threadRef.environmentId} is not connected.`));
  }
  return api.orchestration
    .dispatchCommand({
      type: "thread.seen.set",
      commandId: newCommandId(),
      threadId: threadRef.threadId,
      at,
    })
    .then(() => undefined);
}

/**
 * File a thread (or pull it back). Always dispatched: it is the user saying
 * so, and the same stamp lands in the overlay and on the server so the row
 * cannot move twice.
 */
export function setThreadDoneOverride(
  threadRef: ScopedThreadRef,
  state: "done" | "active",
  at: string = new Date().toISOString(),
): void {
  const threadKey = scopedThreadKey(threadRef);
  const uiStore = useUiStateStore.getState();
  uiStore.setDoneOverlay(threadKey, {
    state,
    at,
    baselineAt: readServerLifecycle(threadRef).doneOverride?.at ?? null,
    settled: false,
  });
  void dispatchDoneOverride(threadRef, state, at).then(
    () => useUiStateStore.getState().resolveDoneOverlay(threadKey, at, "confirmed"),
    () => useUiStateStore.getState().resolveDoneOverlay(threadKey, at, "failed"),
  );
}

export function markThreadDoneByKey(threadKey: string, at?: string): void {
  const threadRef = parseScopedThreadKey(threadKey);
  if (!threadRef) return;
  setThreadDoneOverride(threadRef, "done", at);
}

export function reopenThreadByKey(threadKey: string, at?: string): void {
  const threadRef = parseScopedThreadKey(threadKey);
  if (!threadRef) return;
  setThreadDoneOverride(threadRef, "active", at);
}

/**
 * Record a visit. Only dispatched when it actually moves this device's answer
 * forward, so scrolling through a thread does not chatter at the server.
 */
export function markThreadSeen(threadRef: ScopedThreadRef, visitedAt: string): void {
  const threadKey = scopedThreadKey(threadRef);
  const visitedAtMs = Date.parse(visitedAt);
  if (Number.isNaN(visitedAtMs)) return;
  const server = readServerLifecycle(threadRef);
  const currentAt = selectThreadLastSeenAt(
    useUiStateStore.getState(),
    threadKey,
    server.lastSeenAt,
  );
  const currentMs = currentAt ? Date.parse(currentAt) : Number.NaN;
  if (Number.isFinite(currentMs) && currentMs >= visitedAtMs) return;
  writeSeen(threadRef, threadKey, visitedAt, server.lastSeenAt);
}

/**
 * Un-see a thread's latest completion. Deliberately moves the stamp backwards
 * -- to a millisecond before the completion -- which is why seen is
 * last-write-wins rather than advance-only on the server.
 */
export function markThreadUnreadByKey(
  threadKey: string,
  latestTurnCompletedAt: string | null | undefined,
): void {
  const threadRef = parseScopedThreadKey(threadKey);
  if (!threadRef || !latestTurnCompletedAt) return;
  const completedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedAtMs)) return;
  const unreadAt = new Date(completedAtMs - 1).toISOString();
  const server = readServerLifecycle(threadRef);
  if (server.lastSeenAt === unreadAt) return;
  writeSeen(threadRef, threadKey, unreadAt, server.lastSeenAt);
}

function writeSeen(
  threadRef: ScopedThreadRef,
  threadKey: string,
  at: string,
  baselineAt: string | null,
): void {
  useUiStateStore.getState().setSeenOverlay(threadKey, { at, baselineAt, settled: false });
  void dispatchSeen(threadRef, at).then(
    () => useUiStateStore.getState().resolveSeenOverlay(threadKey, at, "confirmed"),
    () => useUiStateStore.getState().resolveSeenOverlay(threadKey, at, "failed"),
  );
}

const LEGACY_MIGRATION_FLAG_PREFIX = "threadlines:inbox-lifecycle-migrated:v1:";
const migrationsInFlight = new Set<string>();

function readMigrationFlag(flagKey: string): boolean {
  try {
    return window.localStorage.getItem(flagKey) !== null;
  } catch {
    return true;
  }
}

function writeMigrationFlag(flagKey: string): void {
  try {
    window.localStorage.setItem(flagKey, "1");
  } catch {
    // Ignore quota/storage errors; the worst case is retrying next launch.
  }
}

/**
 * Hand this device's pre-sync inbox state to the server, once per environment.
 *
 * Runs off the render path and only fills gaps: a legacy stamp is sent when
 * the server has nothing (or, for a filing, something strictly older), so a
 * device that has been offline for a week cannot undo newer decisions made
 * elsewhere.
 */
export function migrateLegacyInboxStateForEnvironment(environmentId: EnvironmentId): void {
  if (typeof window === "undefined") return;
  const flagKey = `${LEGACY_MIGRATION_FLAG_PREFIX}${environmentId}`;
  if (migrationsInFlight.has(flagKey) || readMigrationFlag(flagKey)) return;
  migrationsInFlight.add(flagKey);

  const run = async () => {
    try {
      const legacy = readLegacyInboxState();
      const summaries = selectSidebarThreadsAcrossEnvironments(useStore.getState()).filter(
        (thread) => thread.environmentId === environmentId,
      );
      const migratedThreadKeys: string[] = [];

      for (const summary of summaries) {
        const threadRef = scopeThreadRef(summary.environmentId, summary.id);
        const threadKey = scopedThreadKey(threadRef);
        const legacyDone = legacy.doneThreadOverrides[threadKey];
        const legacySeenAt = legacy.threadLastVisitedAtById[threadKey];
        if (legacyDone === undefined && legacySeenAt === undefined) {
          continue;
        }
        migratedThreadKeys.push(threadKey);

        if (
          legacyDone !== undefined &&
          (summary.doneOverride === null ||
            Date.parse(summary.doneOverride.at) < Date.parse(legacyDone.at))
        ) {
          await dispatchDoneOverride(threadRef, legacyDone.state, legacyDone.at).catch(
            () => undefined,
          );
        }
        if (legacySeenAt !== undefined && summary.lastSeenAt === null) {
          await dispatchSeen(threadRef, legacySeenAt).catch(() => undefined);
        }
      }

      dropLegacyInboxState(migratedThreadKeys);
      writeMigrationFlag(flagKey);
    } finally {
      migrationsInFlight.delete(flagKey);
    }
  };

  // Deferred so a connect never waits on storage reads or command round-trips.
  setTimeout(() => void run(), 0);
}
