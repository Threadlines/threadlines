/**
 * Thread detail subscriptions: which threads' full detail streams are open,
 * and in what order they open.
 *
 * A thread's detail (every message, activity and plan) can be megabytes, and
 * the server loads one at a time, so the order requests go out is the order
 * chats become readable. Demand comes in four strengths:
 *
 * - Foreground: a mounted chat, or the chat a launch is about to show. Opens
 *   at once and ahead of everything else, except that during a launch it
 *   waits for its environment's thread list (see holdsUntilShell).
 * - Intent: a pointer resting on a thread row, a finger landing on one, or
 *   the jump-hint numbers on screen. At most a couple load at a time, and
 *   one still loading is cancelled when the intent ends, so sweeping across
 *   the list cannot start a burst.
 * - Warm: a thread that needs the user or has a turn running. At launch these
 *   wait until the foreground chat has its detail (or a short cap passes), so
 *   they never queue ahead of the chat being opened.
 * - Idle: a few threads worth having ready (the top rows, the open chat's
 *   neighbours). One at a time, only while nothing foreground or intent is
 *   loading, when the page is idle.
 *
 * Cache policy, unchanged by the order above:
 * - Active consumers keep a subscription retained via refCount.
 * - Released subscriptions stay warm for a longer idle TTL to avoid churn
 *   while moving around the UI.
 * - Threads with active work or pending user action are sticky and are never
 *   evicted while they remain non-idle.
 * - Capacity eviction only targets idle cached subscriptions.
 *
 * @module threadDetailSubscriptions
 */
import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@threadlines/contracts";
import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";

import {
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadExistsByRef,
  useStore,
} from "~/store";
import type { EnvironmentConnection } from "./connection";

const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
/** At launch, how long warm threads wait for the foreground chat's detail. */
export const BOOT_WARM_HOLD_CAP_MS = 1_500;
/** At launch, how long detail streams wait for their environment's shell. */
export const BOOT_SHELL_WAIT_CAP_MS = 1_500;
/** How long the launch's chat stays retained if no chat view takes it over. */
const BOOT_FOREGROUND_HOLD_MS = 30_000;
/** How long one load counts as in flight for the queues, answered or not. */
export const PREWARM_SLOT_TIMEOUT_MS = 5_000;
/** Intent loads that may be in flight at once; later ones wait their turn. */
export const MAX_INTENT_LOADS_IN_FLIGHT = 2;
/** Pointer rest on a thread row before it counts as intent to open it. */
export const THREAD_ROW_HOVER_DWELL_MS = 100;
/**
 * A finger down this long without the browser taking the gesture for a
 * scroll counts as a tap; a flick usually turns into a scroll sooner.
 */
export const THREAD_ROW_TOUCH_DWELL_MS = 60;
/** How long a loaded intent thread stays retained after the intent ends. */
export const THREAD_INTENT_GRACE_MS = 20_000;
/** After a tap, how long its hold waits for the opened chat to take over. */
export const THREAD_ROW_TAP_HOLD_MS = 2_000;
/** An idle prewarm runs by this deadline even on a page that never idles. */
const IDLE_PREWARM_DEADLINE_MS = 2_000;
/** Where the browser has no idle callbacks, wait this long instead. */
const IDLE_PREWARM_FALLBACK_DELAY_MS = 200;
const NOOP = () => undefined;

export type ThreadDetailPriority = "foreground" | "intent" | "idle";

type ThreadDetailSubscriptionEntry = {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly resumeInput: {
    readonly threadId: ThreadId;
    fromSequenceExclusive?: number;
  };
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  readonly refsByPriority: Record<ThreadDetailPriority, number>;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
  readonly createdAt: number;
  /** When the current stream opened; null while it waits for a connection. */
  attachedAt: number | null;
  /**
   * Opened only on speculation (intent or idle prewarm) and never wanted by a
   * chat or as a warm thread. Let go before its detail arrived, it is closed
   * rather than cached, so the server stops sending a history no one asked for.
   */
  speculative: boolean;
  /**
   * The stream has the thread's detail: a snapshot arrived, or it opened
   * with a resume cursor from an earlier snapshot (a resume may send nothing
   * at all when nothing changed, so it never waits for a delivery).
   */
  hydrated: boolean;
  /** The current stream failed and the transport is retrying it. */
  failed: boolean;
};

type IdlePrewarmRequest = {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  release: (() => void) | null;
  cancelled: boolean;
};

type IntentRequest = {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  state: "queued" | "loading" | "held" | "ended";
  release: (() => void) | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

type BootGate = {
  /** Foreground threads the launch waits on: its target and any chat mounted meanwhile. */
  readonly foregroundKeys: Set<string>;
  /** Warm threads held back until the gate opens, in arrival order. */
  readonly heldWarms: Map<string, ScopedThreadRef>;
  capTimeoutId: ReturnType<typeof setTimeout> | null;
};

/** What the registry needs from the connection layer that owns it. */
export interface ThreadDetailSubscriptionHost {
  readonly readConnection: (environmentId: EnvironmentId) => EnvironmentConnection | null;
  readonly subscribeConnections: (listener: () => void) => () => void;
  readonly applyThreadDetailEvent: (
    event: OrchestrationEvent,
    environmentId: EnvironmentId,
  ) => void;
}

export type ThreadDetailSubscriptions = ReturnType<typeof createThreadDetailSubscriptions>;

/**
 * Whether a thread's detail is worth loading before anyone opens it: it waits
 * on the user (an approval, a question, a plan to act on) or a turn is
 * running. A session that is merely open (ready, interrupted) is not.
 */
export function shouldWarmThreadShell(thread: OrchestrationThreadShell): boolean {
  if (
    thread.hasPendingApprovals ||
    thread.pendingChildApproval ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan
  ) {
    return true;
  }

  const sessionStatus = thread.session?.status;
  return (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    thread.latestTurn?.state === "running" ||
    (thread.sideTurn ?? null) !== null
  );
}

function isNonIdleThread(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const state = useStore.getState();
  const sidebarThread = selectSidebarThreadSummaryByRef(state, threadRef);

  // Prefer shell/sidebar state first because it carries the coarse thread
  // readiness flags used throughout the UI (pending approvals/input/plan).
  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.pendingChildApproval === true ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (
      sidebarThread.latestTurn?.state === "running" ||
      (sidebarThread.sideTurn ?? null) !== null
    ) {
      return true;
    }
  }

  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    (thread.sideTurn ?? null) !== null ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function scheduleIdleCallback(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(() => callback(), {
      timeout: IDLE_PREWARM_DEADLINE_MS,
    });
    return () => globalThis.cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, IDLE_PREWARM_FALLBACK_DELAY_MS);
  return () => clearTimeout(handle);
}

/**
 * The registry of thread detail streams for every environment, with the
 * scheduling described in the module comment. One instance serves the app;
 * the connection layer creates it and forwards connection changes.
 */
export function createThreadDetailSubscriptions(host: ThreadDetailSubscriptionHost) {
  const entries = new Map<string, ThreadDetailSubscriptionEntry>();
  const idleQueue: IdlePrewarmRequest[] = [];
  let activeIdlePrewarm: {
    readonly request: IdlePrewarmRequest;
    readonly timeoutId: ReturnType<typeof setTimeout>;
  } | null = null;
  let cancelPendingIdleCallback: (() => void) | null = null;
  let foregroundRecheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const queuedIntents: IntentRequest[] = [];
  const loadingIntents = new Set<IntentRequest>();
  const pendingReleaseTimeouts = new Set<ReturnType<typeof setTimeout>>();
  let bootStarted = false;
  let bootGate: BootGate | null = null;
  let bootForegroundHoldTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Environments whose thread list (shell) has arrived in this page load. */
  const shellLoadedEnvironments = new Set<EnvironmentId>();
  /** At launch, streams waiting for their environment's shell before opening. */
  const entriesAwaitingShell = new Set<ThreadDetailSubscriptionEntry>();
  let shellWaitCapTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let shellWaitOver = false;
  let evaluatingScheduling = false;
  let evaluateSchedulingAgain = false;

  const isEntrySettled = (entry: ThreadDetailSubscriptionEntry | undefined): boolean =>
    entry === undefined || entry.failed || entry.hydrated;

  /** Runs `release` after `delayMs`; reset clears what is still pending. */
  function releaseLater(release: () => void, delayMs: number): void {
    if (delayMs <= 0) {
      release();
      return;
    }
    const timeoutId = setTimeout(() => {
      pendingReleaseTimeouts.delete(timeoutId);
      release();
    }, delayMs);
    pendingReleaseTimeouts.add(timeoutId);
  }

  function clearEviction(entry: ThreadDetailSubscriptionEntry): void {
    if (entry.evictionTimeoutId !== null) {
      clearTimeout(entry.evictionTimeoutId);
      entry.evictionTimeoutId = null;
    }
  }

  function shouldEvict(entry: ThreadDetailSubscriptionEntry): boolean {
    return entry.refCount === 0 && !isNonIdleThread(entry.environmentId, entry.threadId);
  }

  function attach(entry: ThreadDetailSubscriptionEntry): boolean {
    if (entry.unsubscribeConnectionListener !== null) {
      entry.unsubscribeConnectionListener();
      entry.unsubscribeConnectionListener = null;
    }
    if (entry.unsubscribe !== NOOP) {
      return true;
    }

    const connection = host.readConnection(entry.environmentId);
    if (!connection) {
      return false;
    }
    if (holdsUntilShell(entry)) {
      return true;
    }

    entry.attachedAt = Date.now();
    entry.hydrated = entry.resumeInput.fromSequenceExclusive !== undefined;
    entry.failed = false;
    entry.unsubscribe = connection.client.orchestration.subscribeThread(
      entry.resumeInput,
      (item) => {
        entry.failed = false;
        if (item.kind === "snapshot") {
          useStore.getState().syncServerThreadDetail(item.snapshot.thread, entry.environmentId);
          entry.resumeInput.fromSequenceExclusive = item.snapshot.snapshotSequence;
          entry.hydrated = true;
        } else {
          host.applyThreadDetailEvent(item.event, entry.environmentId);
          entry.resumeInput.fromSequenceExclusive = Math.max(
            entry.resumeInput.fromSequenceExclusive ?? 0,
            item.event.sequence,
          );
        }
        evaluateScheduling();
      },
      {
        onRetry: () => {
          entry.failed = true;
          evaluateScheduling();
        },
      },
    );
    return true;
  }

  function watchConnection(entry: ThreadDetailSubscriptionEntry): void {
    if (entry.unsubscribeConnectionListener !== null) {
      return;
    }

    entry.unsubscribeConnectionListener = host.subscribeConnections(() => {
      if (attach(entry)) {
        entry.lastAccessedAt = Date.now();
      }
    });
    attach(entry);
  }

  function ensureAttached(entry: ThreadDetailSubscriptionEntry): void {
    if (!attach(entry)) {
      watchConnection(entry);
    }
  }

  function detach(entry: ThreadDetailSubscriptionEntry): void {
    entriesAwaitingShell.delete(entry);
    entry.unsubscribe();
    entry.unsubscribe = NOOP;
    entry.attachedAt = null;
  }

  function createEntry(
    environmentId: EnvironmentId,
    threadId: ThreadId,
    key: string,
    speculative: boolean,
  ): ThreadDetailSubscriptionEntry {
    const now = Date.now();
    const entry: ThreadDetailSubscriptionEntry = {
      key,
      environmentId,
      threadId,
      resumeInput: { threadId },
      unsubscribe: NOOP,
      unsubscribeConnectionListener: null,
      refCount: 0,
      refsByPriority: { foreground: 0, intent: 0, idle: 0 },
      lastAccessedAt: now,
      evictionTimeoutId: null,
      createdAt: now,
      attachedAt: null,
      speculative,
      hydrated: false,
      failed: false,
    };
    entries.set(key, entry);
    return entry;
  }

  function disposeByKey(key: string): boolean {
    const entry = entries.get(key);
    if (!entry) {
      return false;
    }

    clearEviction(entry);
    entry.unsubscribeConnectionListener?.();
    entry.unsubscribeConnectionListener = null;
    entries.delete(key);
    detach(entry);
    // Its detail stops updating here, so the chat waits for the next
    // snapshot before it calls the thread empty.
    useStore
      .getState()
      .markThreadDetailUnloaded(scopeThreadRef(entry.environmentId, entry.threadId));
    bootGate?.heldWarms.delete(key);
    evaluateScheduling();
    return true;
  }

  function scheduleEviction(entry: ThreadDetailSubscriptionEntry): void {
    clearEviction(entry);
    if (!shouldEvict(entry)) {
      return;
    }

    entry.evictionTimeoutId = setTimeout(() => {
      const currentEntry = entries.get(entry.key);
      if (!currentEntry) {
        return;
      }

      currentEntry.evictionTimeoutId = null;
      if (!shouldEvict(currentEntry)) {
        return;
      }
      disposeByKey(entry.key);
    }, THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS);
  }

  function evictIdleToCapacity(): void {
    if (entries.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }

    const idleEntries = [...entries.values()]
      .filter((entry) => shouldEvict(entry))
      .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);

    for (const entry of idleEntries) {
      if (entries.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
        return;
      }
      disposeByKey(entry.key);
    }
  }

  function reconcileEvictionState(entry: ThreadDetailSubscriptionEntry): void {
    clearEviction(entry);
    if (!shouldEvict(entry)) {
      return;
    }

    scheduleEviction(entry);
  }

  // ---------------------------------------------------------------------------
  // Launch: the thread list, then the foreground chat, then warm threads.
  // ---------------------------------------------------------------------------

  /**
   * During a launch into a chat, a detail stream waits for its environment's
   * shell. The server answers one request at a time, so a large detail asked
   * for alongside the shell delays the shell, and the first paint (sidebar
   * and chat together) waits for both. Shell first, the sidebar paints as
   * soon as it can and the chat follows. Bounded by BOOT_SHELL_WAIT_CAP_MS.
   */
  function holdsUntilShell(entry: ThreadDetailSubscriptionEntry): boolean {
    if (!bootGate || shellWaitOver || shellLoadedEnvironments.has(entry.environmentId)) {
      return false;
    }
    entriesAwaitingShell.add(entry);
    shellWaitCapTimeoutId ??= setTimeout(() => {
      shellWaitCapTimeoutId = null;
      shellWaitOver = true;
      releaseEntriesAwaitingShell(() => true);
    }, BOOT_SHELL_WAIT_CAP_MS);
    return true;
  }

  function releaseEntriesAwaitingShell(
    matches: (entry: ThreadDetailSubscriptionEntry) => boolean,
  ): void {
    const ready = [...entriesAwaitingShell]
      .filter(matches)
      .toSorted(
        (left, right) =>
          right.refsByPriority.foreground - left.refsByPriority.foreground ||
          right.lastAccessedAt - left.lastAccessedAt,
      );
    for (const entry of ready) {
      entriesAwaitingShell.delete(entry);
      ensureAttached(entry);
    }
    if (entriesAwaitingShell.size === 0 && shellWaitCapTimeoutId !== null) {
      clearTimeout(shellWaitCapTimeoutId);
      shellWaitCapTimeoutId = null;
    }
    evaluateScheduling();
  }

  /**
   * An environment's shell arrived: streams that waited for it open now,
   * mounted chats first. Call after dropping streams for threads the shell
   * no longer lists, so those never open at all.
   */
  function noteShellLoaded(environmentId: EnvironmentId): void {
    shellLoadedEnvironments.add(environmentId);
    releaseEntriesAwaitingShell((entry) => entry.environmentId === environmentId);
  }

  function openBootGate(): void {
    const gate = bootGate;
    if (!gate) {
      return;
    }
    bootGate = null;
    if (gate.capTimeoutId !== null) {
      clearTimeout(gate.capTimeoutId);
    }
    // Held warms are re-checked against the store: a thread that finished or
    // was removed while it waited no longer needs its detail.
    for (const ref of gate.heldWarms.values()) {
      if (isNonIdleThread(ref.environmentId, ref.threadId)) {
        ensureWarm(ref.environmentId, ref.threadId);
      }
    }
  }

  function evaluateBootGate(): void {
    if (!bootGate) {
      return;
    }
    for (const key of bootGate.foregroundKeys) {
      if (!isEntrySettled(entries.get(key))) {
        return;
      }
    }
    openBootGate();
  }

  function holdWarmUntilForegroundLoads(gate: BootGate, ref: ScopedThreadRef): void {
    gate.heldWarms.set(scopedThreadKey(ref), ref);
    if (gate.capTimeoutId === null) {
      gate.capTimeoutId = setTimeout(() => {
        gate.capTimeoutId = null;
        openBootGate();
        evaluateScheduling();
      }, BOOT_WARM_HOLD_CAP_MS);
    }
  }

  /**
   * Starts the launch: retains the chat the app is opening into (null for a
   * draft, home, settings or setup) before any warm thread, and holds warm
   * threads back until that chat has its detail. Only the first call counts.
   */
  function beginBoot(foregroundThreadRef: ScopedThreadRef | null): void {
    if (bootStarted) {
      return;
    }
    bootStarted = true;
    if (!foregroundThreadRef) {
      return;
    }
    bootGate = { foregroundKeys: new Set(), heldWarms: new Map(), capTimeoutId: null };
    const release = retain(
      foregroundThreadRef.environmentId,
      foregroundThreadRef.threadId,
      "foreground",
    );
    // The chat view retains the thread itself once it mounts; this hold only
    // covers the gap until then, or a launch that lands elsewhere after all.
    bootForegroundHoldTimeoutId = setTimeout(() => {
      bootForegroundHoldTimeoutId = null;
      release();
    }, BOOT_FOREGROUND_HOLD_MS);
  }

  // ---------------------------------------------------------------------------
  // Intent: a couple of loads at a time, cancelled while loading if the
  // intent ends.
  // ---------------------------------------------------------------------------

  function settleIntent(request: IntentRequest): void {
    if (request.state !== "loading") {
      return;
    }
    loadingIntents.delete(request);
    if (request.timeoutId !== null) {
      clearTimeout(request.timeoutId);
      request.timeoutId = null;
    }
    request.state = "held";
  }

  function startIntent(request: IntentRequest): void {
    // Counted before retaining: a retain can evict, and the evaluation that
    // follows must see this slot taken.
    request.state = "loading";
    loadingIntents.add(request);
    request.release = retain(request.ref.environmentId, request.ref.threadId, "intent");
    if (isEntrySettled(entries.get(request.key))) {
      settleIntent(request);
      return;
    }
    request.timeoutId = setTimeout(() => {
      request.timeoutId = null;
      settleIntent(request);
      evaluateScheduling();
    }, PREWARM_SLOT_TIMEOUT_MS);
  }

  function pumpIntents(): void {
    for (const request of loadingIntents) {
      if (isEntrySettled(entries.get(request.key))) {
        settleIntent(request);
      }
    }
    while (loadingIntents.size < MAX_INTENT_LOADS_IN_FLIGHT && queuedIntents.length > 0) {
      startIntent(queuedIntents.shift()!);
    }
  }

  /**
   * Ends one intent. If its thread's detail has arrived it lingers `graceMs`,
   * so the click that follows finds it; otherwise it is let go at once, which
   * closes a speculative load no one else wants (see `speculative`).
   */
  function endIntent(request: IntentRequest, graceMs: number): void {
    const state = request.state;
    request.state = "ended";
    if (state === "queued") {
      const queuedIndex = queuedIntents.indexOf(request);
      if (queuedIndex !== -1) {
        queuedIntents.splice(queuedIndex, 1);
      }
      return;
    }
    loadingIntents.delete(request);
    if (request.timeoutId !== null) {
      clearTimeout(request.timeoutId);
      request.timeoutId = null;
    }
    const release = request.release ?? NOOP;
    request.release = null;
    if (entries.get(request.key)?.hydrated) {
      releaseLater(release, graceMs);
    } else {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Idle prewarm: one thread at a time, after foreground and intent loads.
  // ---------------------------------------------------------------------------

  function finishActiveIdlePrewarm(): void {
    if (!activeIdlePrewarm) {
      return;
    }
    clearTimeout(activeIdlePrewarm.timeoutId);
    activeIdlePrewarm = null;
  }

  /**
   * Whether a foreground or intent load is still in flight. Each one counts
   * for at most PREWARM_SLOT_TIMEOUT_MS after its stream opened, so a load
   * that never answers cannot stall prewarming; a timer re-checks then.
   */
  function isForegroundLoading(): boolean {
    if (queuedIntents.length > 0) {
      return true;
    }
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      if (entry.refsByPriority.foreground + entry.refsByPriority.intent === 0) {
        continue;
      }
      if (isEntrySettled(entry)) {
        continue;
      }
      // Still waiting for a connection or a shell counts too, from creation.
      const expiresAt = (entry.attachedAt ?? entry.createdAt) + PREWARM_SLOT_TIMEOUT_MS;
      if (expiresAt > now) {
        nextExpiry = Math.min(nextExpiry, expiresAt);
      }
    }
    if (nextExpiry === Number.POSITIVE_INFINITY) {
      return false;
    }
    if (foregroundRecheckTimeoutId !== null) {
      clearTimeout(foregroundRecheckTimeoutId);
    }
    foregroundRecheckTimeoutId = setTimeout(() => {
      foregroundRecheckTimeoutId = null;
      evaluateScheduling();
    }, nextExpiry - now);
    return true;
  }

  function startNextIdlePrewarm(): void {
    if (activeIdlePrewarm || isForegroundLoading()) {
      return;
    }
    while (idleQueue.length > 0) {
      const request = idleQueue.shift()!;
      if (request.cancelled || !selectThreadExistsByRef(useStore.getState(), request.ref)) {
        continue;
      }
      request.release = retain(request.ref.environmentId, request.ref.threadId, "idle");
      if (isEntrySettled(entries.get(request.key))) {
        // Already loaded and live: keep the hold, move straight on.
        continue;
      }
      activeIdlePrewarm = {
        request,
        timeoutId: setTimeout(() => {
          finishActiveIdlePrewarm();
          evaluateScheduling();
        }, PREWARM_SLOT_TIMEOUT_MS),
      };
      return;
    }
  }

  function pumpIdlePrewarm(): void {
    if (
      activeIdlePrewarm ||
      cancelPendingIdleCallback ||
      idleQueue.length === 0 ||
      isForegroundLoading()
    ) {
      return;
    }
    cancelPendingIdleCallback = scheduleIdleCallback(() => {
      cancelPendingIdleCallback = null;
      startNextIdlePrewarm();
    });
  }

  /**
   * Re-checks every waiting decision; runs after anything that can unblock
   * one. Not re-entrant: a call made while it runs (a retain that evicts, a
   * dispose) makes it go round once more instead, so no queue decides on
   * state another is halfway through changing.
   */
  function evaluateScheduling(): void {
    if (evaluatingScheduling) {
      evaluateSchedulingAgain = true;
      return;
    }
    evaluatingScheduling = true;
    try {
      do {
        evaluateSchedulingAgain = false;
        evaluateBootGate();
        pumpIntents();
        if (activeIdlePrewarm && isEntrySettled(entries.get(activeIdlePrewarm.request.key))) {
          finishActiveIdlePrewarm();
        }
        pumpIdlePrewarm();
      } while (evaluateSchedulingAgain);
    } finally {
      evaluatingScheduling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public surface.
  // ---------------------------------------------------------------------------

  /**
   * Keeps a thread's detail stream open until the returned release runs.
   * Foreground is a mounted chat; intent and idle come from the prewarm
   * helpers below.
   */
  function retain(
    environmentId: EnvironmentId,
    threadId: ThreadId,
    priority: ThreadDetailPriority = "foreground",
  ): () => void {
    const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
    const existing = entries.get(key);
    const entry = existing ?? createEntry(environmentId, threadId, key, priority !== "foreground");
    if (priority === "foreground") {
      entry.speculative = false;
    }
    clearEviction(entry);
    entry.refCount += 1;
    entry.refsByPriority[priority] += 1;
    entry.lastAccessedAt = Date.now();
    if (priority === "foreground") {
      bootGate?.foregroundKeys.add(key);
    }
    ensureAttached(entry);
    if (!existing) {
      evictIdleToCapacity();
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.refsByPriority[priority] = Math.max(0, entry.refsByPriority[priority] - 1);
      entry.lastAccessedAt = Date.now();
      if (entry.refCount === 0) {
        if (
          entry.speculative &&
          !entry.hydrated &&
          entries.get(entry.key) === entry &&
          !isNonIdleThread(entry.environmentId, entry.threadId)
        ) {
          disposeByKey(entry.key);
        } else {
          reconcileEvictionState(entry);
          evictIdleToCapacity();
        }
      }
      evaluateScheduling();
    };
  }

  /** Opens a warm thread's stream; held back during launch. */
  function ensureWarm(environmentId: EnvironmentId, threadId: ThreadId): void {
    const ref = scopeThreadRef(environmentId, threadId);
    if (bootGate && !entries.has(scopedThreadKey(ref))) {
      holdWarmUntilForegroundLoads(bootGate, ref);
      return;
    }
    openWarm(environmentId, threadId);
  }

  function openWarm(environmentId: EnvironmentId, threadId: ThreadId): void {
    const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
    const existing = entries.get(key);
    if (existing) {
      // A warm thread is wanted for itself, so it is no longer speculation.
      existing.speculative = false;
      clearEviction(existing);
      existing.lastAccessedAt = Date.now();
      ensureAttached(existing);
      return;
    }

    ensureAttached(createEntry(environmentId, threadId, key, false));
    evictIdleToCapacity();
  }

  function warmNonIdle(
    environmentId: EnvironmentId,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): void {
    for (const thread of threads) {
      if (shouldWarmThreadShell(thread)) {
        ensureWarm(environmentId, thread.id);
      }
    }
  }

  /**
   * Prewarms threads the user is about to open at intent priority, in order,
   * MAX_INTENT_LOADS_IN_FLIGHT at a time. The returned end lets each one go:
   * loaded ones `graceMs` later, loading ones at once (see endIntent).
   */
  function holdIntent(
    refs: ReadonlyArray<ScopedThreadRef>,
    options?: { readonly graceMs?: number },
  ): () => void {
    const requests = refs.map((ref): IntentRequest => ({
      key: scopedThreadKey(ref),
      ref,
      state: "queued",
      release: null,
      timeoutId: null,
    }));
    queuedIntents.push(...requests);
    evaluateScheduling();

    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      for (const request of requests) {
        endIntent(request, options?.graceMs ?? 0);
      }
      evaluateScheduling();
    };
  }

  /**
   * Queues threads for idle prewarming, in order. Each is retained once it
   * gets its turn and stays retained until the returned cancel runs.
   */
  function requestIdlePrewarm(refs: ReadonlyArray<ScopedThreadRef>): () => void {
    const requests: IdlePrewarmRequest[] = refs.map((ref) => ({
      key: scopedThreadKey(ref),
      ref,
      release: null,
      cancelled: false,
    }));
    idleQueue.push(...requests);
    evaluateScheduling();

    return () => {
      for (const request of requests) {
        if (request.cancelled) {
          continue;
        }
        request.cancelled = true;
        const queuedIndex = idleQueue.indexOf(request);
        if (queuedIndex !== -1) {
          idleQueue.splice(queuedIndex, 1);
        }
        if (activeIdlePrewarm?.request === request) {
          finishActiveIdlePrewarm();
        }
        request.release?.();
        request.release = null;
      }
      evaluateScheduling();
    };
  }

  /** Restarts a retained stream to fetch a fresh snapshot; false if none is open. */
  function refresh(environmentId: EnvironmentId, threadId: ThreadId): boolean {
    const entry = entries.get(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
    if (!entry) {
      return false;
    }

    clearEviction(entry);
    entry.unsubscribeConnectionListener?.();
    entry.unsubscribeConnectionListener = null;
    detach(entry);
    delete entry.resumeInput.fromSequenceExclusive;
    entry.lastAccessedAt = Date.now();
    ensureAttached(entry);
    return true;
  }

  /**
   * Re-opens an environment's streams after it (re)connects. Mounted chats
   * go first, then intent, then the rest by recency, so a reconnect never
   * queues the chat on screen behind background threads. This
   * environment's warm threads still held from launch go out now too: their
   * wait was for the connection that just got replaced.
   */
  function attachForEnvironment(environmentId: EnvironmentId): void {
    const environmentEntries = [...entries.values()]
      .filter((entry) => entry.environmentId === environmentId)
      .toSorted(
        (left, right) =>
          Number(right.refsByPriority.foreground > 0) -
            Number(left.refsByPriority.foreground > 0) ||
          Number(right.refsByPriority.intent > 0) - Number(left.refsByPriority.intent > 0) ||
          right.lastAccessedAt - left.lastAccessedAt,
      );
    for (const entry of environmentEntries) {
      attach(entry);
    }
    if (bootGate) {
      for (const [key, ref] of bootGate.heldWarms) {
        if (ref.environmentId !== environmentId) {
          continue;
        }
        bootGate.heldWarms.delete(key);
        if (isNonIdleThread(ref.environmentId, ref.threadId)) {
          openWarm(ref.environmentId, ref.threadId);
        }
      }
    }
    evaluateScheduling();
  }

  function detachForEnvironment(environmentId: EnvironmentId): void {
    for (const entry of entries.values()) {
      if (entry.environmentId !== environmentId) {
        continue;
      }
      detach(entry);
      watchConnection(entry);
    }
  }

  function disposeThread(environmentId: EnvironmentId, threadId: ThreadId): void {
    disposeByKey(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  }

  function disposeForEnvironment(environmentId: EnvironmentId): void {
    for (const entry of entries.values()) {
      if (entry.environmentId === environmentId) {
        disposeByKey(entry.key);
      }
    }
    if (bootGate) {
      for (const [key, ref] of bootGate.heldWarms) {
        if (ref.environmentId === environmentId) {
          bootGate.heldWarms.delete(key);
        }
      }
    }
  }

  /** Drops streams for threads an environment no longer lists. */
  function reconcileForEnvironment(
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
  ): void {
    const activeThreadIds = new Set(threadIds);
    for (const entry of entries.values()) {
      if (entry.environmentId === environmentId && !activeThreadIds.has(entry.threadId)) {
        disposeByKey(entry.key);
      }
    }
    // A launch target the environment does not list will never load.
    evaluateScheduling();
  }

  function reconcileEvictionForThread(environmentId: EnvironmentId, threadId: ThreadId): void {
    const entry = entries.get(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
    if (entry) {
      reconcileEvictionState(entry);
    }
  }

  function reconcileEvictionForEnvironment(environmentId: EnvironmentId): void {
    for (const entry of entries.values()) {
      if (entry.environmentId === environmentId) {
        reconcileEvictionState(entry);
      }
    }
    evictIdleToCapacity();
  }

  function resetForTests(): void {
    for (const key of entries.keys()) {
      disposeByKey(key);
    }
    idleQueue.length = 0;
    finishActiveIdlePrewarm();
    cancelPendingIdleCallback?.();
    cancelPendingIdleCallback = null;
    if (foregroundRecheckTimeoutId !== null) {
      clearTimeout(foregroundRecheckTimeoutId);
      foregroundRecheckTimeoutId = null;
    }
    queuedIntents.length = 0;
    for (const request of loadingIntents) {
      if (request.timeoutId !== null) clearTimeout(request.timeoutId);
    }
    loadingIntents.clear();
    for (const timeoutId of pendingReleaseTimeouts) {
      clearTimeout(timeoutId);
    }
    pendingReleaseTimeouts.clear();
    if (bootGate?.capTimeoutId != null) {
      clearTimeout(bootGate.capTimeoutId);
    }
    bootGate = null;
    if (bootForegroundHoldTimeoutId !== null) {
      clearTimeout(bootForegroundHoldTimeoutId);
      bootForegroundHoldTimeoutId = null;
    }
    bootStarted = false;
    shellLoadedEnvironments.clear();
    entriesAwaitingShell.clear();
    if (shellWaitCapTimeoutId !== null) {
      clearTimeout(shellWaitCapTimeoutId);
      shellWaitCapTimeoutId = null;
    }
    shellWaitOver = false;
  }

  return {
    attachForEnvironment,
    beginBoot,
    noteShellLoaded,
    detachForEnvironment,
    disposeForEnvironment,
    disposeThread,
    evictIdleToCapacity,
    holdIntent,
    reconcileEvictionForEnvironment,
    reconcileEvictionForThread,
    reconcileForEnvironment,
    refresh,
    requestIdlePrewarm,
    resetForTests,
    retain,
    warmNonIdle,
  };
}

type PointerEventType =
  | "pointerover"
  | "pointerout"
  | "pointerdown"
  | "pointerup"
  | "pointercancel";

/** The slice of an event target the row binder listens on (`document` in the app). */
interface PointerEventTarget {
  addEventListener(type: PointerEventType, listener: (event: PointerEvent) => void): void;
  removeEventListener(type: PointerEventType, listener: (event: PointerEvent) => void): void;
}

interface ThreadRowElement {
  getAttribute(name: string): string | null;
  contains(other: Node | null): boolean;
}

function closestThreadRow(target: EventTarget | null): ThreadRowElement | null {
  const element = target as { closest?: (selector: string) => ThreadRowElement | null } | null;
  return typeof element?.closest === "function" ? element.closest("[data-thread-key]") : null;
}

/**
 * Turns intent on a thread row (any element carrying `data-thread-key`, a
 * scoped thread key) into a prewarm through `holdIntent`:
 *
 * - A mouse or pen resting THREAD_ROW_HOVER_DWELL_MS on a row; leaving it
 *   ends the intent (cancelled if still loading, else kept a grace period).
 * - A finger on a row for THREAD_ROW_TOUCH_DWELL_MS, or lifting sooner (a
 *   tap is about as long as a hover dwell, so this cannot wait for one). A
 *   scroll that takes the gesture over cancels it; after a tap it ends
 *   THREAD_ROW_TAP_HOLD_MS later, once the opened chat holds it.
 *
 * The returned cleanup ends everything at once.
 */
export function bindThreadRowIntentPrewarm(
  target: PointerEventTarget,
  holdIntent: (refs: ReadonlyArray<ScopedThreadRef>) => () => void,
): () => void {
  type RowIntent = {
    end: (() => void) | null;
    dwellTimeoutId: ReturnType<typeof setTimeout> | null;
    tapTimeoutId: ReturnType<typeof setTimeout> | null;
  };
  const intents = new Map<string, RowIntent>();

  const rowKeyOf = (event: PointerEvent): string | null => {
    const row = closestThreadRow(event.target);
    const key = row?.getAttribute("data-thread-key");
    // Moving between a row's own children is not entering or leaving it.
    return row && key && !row.contains(event.relatedTarget as Node | null) ? key : null;
  };

  const hold = (key: string, intent: RowIntent) => {
    const ref = parseScopedThreadKey(key);
    if (ref && !intent.end) {
      intent.end = holdIntent([ref]);
    }
  };

  const end = (key: string) => {
    const intent = intents.get(key);
    if (!intent) {
      return;
    }
    intents.delete(key);
    if (intent.dwellTimeoutId !== null) clearTimeout(intent.dwellTimeoutId);
    if (intent.tapTimeoutId !== null) clearTimeout(intent.tapTimeoutId);
    intent.end?.();
  };

  const intentFor = (key: string): RowIntent => {
    const existing = intents.get(key);
    if (existing) {
      return existing;
    }
    const intent: RowIntent = { end: null, dwellTimeoutId: null, tapTimeoutId: null };
    intents.set(key, intent);
    return intent;
  };

  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    const key = rowKeyOf(event);
    if (!key) {
      return;
    }
    const intent = intentFor(key);
    if (intent.end || intent.dwellTimeoutId !== null) {
      return;
    }
    intent.dwellTimeoutId = setTimeout(() => {
      intent.dwellTimeoutId = null;
      hold(key, intent);
    }, THREAD_ROW_HOVER_DWELL_MS);
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    const key = rowKeyOf(event);
    if (key) {
      end(key);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    const key = closestThreadRow(event.target)?.getAttribute("data-thread-key");
    if (!key) {
      return;
    }
    const intent = intentFor(key);
    if (intent.end || intent.dwellTimeoutId !== null) {
      return;
    }
    intent.dwellTimeoutId = setTimeout(() => {
      intent.dwellTimeoutId = null;
      hold(key, intent);
    }, THREAD_ROW_TOUCH_DWELL_MS);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    const key = closestThreadRow(event.target)?.getAttribute("data-thread-key");
    const intent = key ? intents.get(key) : undefined;
    if (!key || !intent || intent.tapTimeoutId !== null) {
      return;
    }
    // A quick tap lifts before the dwell: the click is coming, start now.
    if (intent.dwellTimeoutId !== null) {
      clearTimeout(intent.dwellTimeoutId);
      intent.dwellTimeoutId = null;
      hold(key, intent);
    }
    intent.tapTimeoutId = setTimeout(() => end(key), THREAD_ROW_TAP_HOLD_MS);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    const key = closestThreadRow(event.target)?.getAttribute("data-thread-key");
    if (key) {
      end(key);
    }
  };

  const listeners = [
    ["pointerover", onPointerOver],
    ["pointerout", onPointerOut],
    ["pointerdown", onPointerDown],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
  ] as const;
  for (const [type, listener] of listeners) {
    target.addEventListener(type, listener);
  }
  return () => {
    for (const [type, listener] of listeners) {
      target.removeEventListener(type, listener);
    }
    for (const key of intents.keys()) {
      end(key);
    }
  };
}
