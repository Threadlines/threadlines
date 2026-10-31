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
 * value moves off the baseline the write was made against. A filing the
 * server did not take drops its overlay, so the row never sits in a list the
 * server has not heard of. A visit it did not take keeps its overlay and
 * is offered again when the environment answers (see `sendSeen`).
 */
import { parseScopedThreadKey, scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { useShallow } from "zustand/react/shallow";

import {
  mergeThreadDoneOverride,
  mergeThreadLastSeenAt,
  resolveThreadSeenAt,
} from "../components/Sidebar.logic";
import type { ThreadDoneOverride, ThreadSeenSources } from "../components/Sidebar.logic";
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

/**
 * What a list outside the inbox reads to tell a new result from a seen one
 * (`resolveSeenThreadStatus`). Stable until either map changes.
 */
export function useThreadSeenSources(): ThreadSeenSources {
  return useUiStateStore(
    useShallow((state) => ({
      seenThreadOverlays: state.seenThreadOverlays,
      threadSeedVisitedAtById: state.threadSeedVisitedAtById,
    })),
  );
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

/**
 * When the user surely saw a thread: overlay, then server, never the seed
 * (`resolveThreadSeenAt`). What a visit is weighed against before it is sent.
 */
export function selectThreadSeenAt(
  uiState: UiState,
  threadKey: string,
  serverLastSeenAt: string | null | undefined,
): string | undefined {
  return resolveThreadSeenAt(uiState.seenThreadOverlays[threadKey]?.at, serverLastSeenAt);
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
 * Wrap up (or reopen) a parent's child on a computer this app can't see. The
 * word lands on the parent's record of it, on the parent's computer, which
 * sends it on to the child's computer with the same stamp
 * (`thread.remote-child.done-override.set`). The parent's computer answers
 * within a moment, so the row moves on its word, not an overlay.
 */
export function setRemoteChildDoneOverride(
  parentRef: ScopedThreadRef,
  child: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  state: "done" | "active",
  at: string = new Date().toISOString(),
): Promise<void> {
  const api = readEnvironmentApi(parentRef.environmentId);
  if (!api) {
    return Promise.reject(new Error(`Environment ${parentRef.environmentId} is not connected.`));
  }
  return api.orchestration
    .dispatchCommand({
      type: "thread.remote-child.done-override.set",
      commandId: newCommandId(),
      threadId: parentRef.threadId,
      environmentId: child.environmentId,
      childThreadId: child.threadId,
      state,
      at,
    })
    .then(() => undefined);
}

/**
 * Record a visit. Only dispatched when it moves the recorded visit forward,
 * so scrolling through a thread does not chatter at the server. The seed is
 * no visit: a thread only it covers still records this one.
 */
export function markThreadSeen(threadRef: ScopedThreadRef, visitedAt: string): void {
  const threadKey = scopedThreadKey(threadRef);
  const visitedAtMs = Date.parse(visitedAt);
  if (Number.isNaN(visitedAtMs)) return;
  const server = readServerLifecycle(threadRef);
  const currentAt = selectThreadSeenAt(useUiStateStore.getState(), threadKey, server.lastSeenAt);
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
  // Skipped only when this device already says so. The server holding the
  // stamp is not enough: a visit still pending here speaks over it now and
  // would overwrite it later.
  const overlay = useUiStateStore.getState().seenThreadOverlays[threadKey];
  if ((overlay?.at ?? server.lastSeenAt) === unreadAt) return;
  writeSeen(threadRef, threadKey, unreadAt, server.lastSeenAt);
}

/**
 * How many more times a seen write the server did not take is offered.
 * Bounded so that no kind of failure, including one that makes the
 * environment list its threads again, can keep a write going out forever.
 */
const SEEN_RESEND_LIMIT = 3;

let nextSeenWriteId = 0;

function writeSeen(
  threadRef: ScopedThreadRef,
  threadKey: string,
  at: string,
  baselineAt: string | null,
): void {
  nextSeenWriteId += 1;
  const write = { at, baselineAt, writeId: nextSeenWriteId, settled: false };
  useUiStateStore.getState().setSeenOverlay(threadKey, write);
  sendSeen(threadRef, threadKey, write, SEEN_RESEND_LIMIT);
}

/**
 * One attempt at a seen write. `markThreadSeen` is called from a render
 * effect that reads the overlay, so a failed visit that dropped its overlay
 * re-armed the effect and went out again at once: a computer that had gone to
 * sleep was sent the same command about 85 times a second until the window
 * froze. A failed write is kept instead, so failing changes nothing the
 * effect reads.
 */
function sendSeen(
  threadRef: ScopedThreadRef,
  threadKey: string,
  write: { readonly at: string; readonly writeId: number },
  resendsLeft: number,
): void {
  // The server's value is read when the attempt ends: it may have moved while
  // the attempt was in flight, and then its answer is the newer one.
  const settle = (outcome: { readonly resendsLeft?: number }) =>
    useUiStateStore.getState().settleSeenOverlay(threadKey, write.writeId, {
      serverLastSeenAt: readServerLifecycle(threadRef).lastSeenAt,
      ...outcome,
    });
  void dispatchSeen(threadRef, write.at).then(
    () => settle({}),
    () => settle({ resendsLeft }),
  );
}

/**
 * Offer an environment the seen writes it did not take, once each. Called
 * when the environment lists its threads, which is the first proof it is
 * answering again.
 */
export function resendUndeliveredThreadSeen(environmentId: EnvironmentId): void {
  const uiStore = useUiStateStore.getState();
  for (const [threadKey, held] of Object.entries(uiStore.seenThreadOverlays)) {
    if (!held.settled || !held.resendsLeft) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef?.environmentId !== environmentId) continue;
    const serverLastSeenAt = readServerLifecycle(threadRef).lastSeenAt;
    if (serverLastSeenAt !== held.baselineAt) {
      // The server moved while the write waited: settling it again retires it.
      uiStore.settleSeenOverlay(threadKey, held.writeId, {
        serverLastSeenAt,
        resendsLeft: held.resendsLeft,
      });
      continue;
    }
    uiStore.setSeenOverlay(threadKey, {
      at: held.at,
      baselineAt: held.baselineAt,
      writeId: held.writeId,
      settled: false,
    });
    sendSeen(threadRef, threadKey, held, held.resendsLeft - 1);
  }
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
