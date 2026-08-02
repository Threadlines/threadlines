import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type GitManagerServiceError,
  type VcsStatusLocalResult,
  type VcsStatusResult,
} from "@threadlines/contracts";
import { applyGitStatusStreamEvent } from "@threadlines/shared/git";
import * as Cause from "effect/Cause";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import {
  recordStreamDiagnostic,
  STREAM_DIAGNOSTIC_NAMES,
} from "../observability/streamDiagnostics";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

/**
 * Server-reported git failures arrive as `GitManagerServiceError`; the client
 * also synthesizes plain errors when a subscription stops delivering snapshots
 * (retry loop, watchdog timeout), which is invisible to the server.
 */
type GitStatusError = GitManagerServiceError | Error;

interface GitStatusState {
  readonly data: VcsStatusResult | null;
  readonly error: GitStatusError | null;
  readonly cause: Cause.Cause<GitStatusError> | null;
  readonly isPending: boolean;
}

type GitStatusClient = Pick<WsRpcClient["vcs"], "onStatus" | "refreshStatus"> &
  Partial<Pick<WsRpcClient["vcs"], "refreshLocalStatus">>;
interface ResolvedGitStatusClient {
  readonly clientIdentity: string;
  readonly client: GitStatusClient;
}

/**
 * A live subscription that can be torn down and rebuilt in place. `unsubscribe`
 * is stable across rebuilds — it always releases whatever stream is current —
 * so `watchedGitStatuses` never has to swap a handle mid-rebuild and
 * refcounting stays correct while a rebuild is in flight.
 */
interface GitStatusSubscription {
  readonly unsubscribe: () => void;
  readonly rebuild: () => void;
}

interface WatchedGitStatus {
  refCount: number;
  readonly subscription: GitStatusSubscription;
}

interface GitStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface GitStatusRefreshOptions {
  readonly force?: boolean;
}

const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});
const INITIAL_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  ...EMPTY_GIT_STATUS_STATE,
  isPending: true,
});
const EMPTY_GIT_STATUS_ATOM = Atom.make(EMPTY_GIT_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-status:null"),
);

const NOOP: () => void = () => undefined;
const watchedGitStatuses = new Map<string, WatchedGitStatus>();
const knownGitStatusKeys = new Set<string>();
const gitStatusLocalRefreshInFlight = new Map<string, Promise<VcsStatusLocalResult>>();
const gitStatusRefreshInFlight = new Map<string, Promise<VcsStatusResult>>();
const gitStatusLastRefreshAtByKey = new Map<string, number>();

const GIT_STATUS_REFRESH_DEBOUNCE_MS = 1_000;
// A lost response must never wedge the in-flight maps: every caller's
// `.finally()` has to run, or refreshes for that cwd stop forever and the
// panel keeps a spinner up until the page is reloaded.
const GIT_STATUS_LOCAL_REFRESH_TIMEOUT_MS = 20_000;
// The full refresh can include a real `git fetch`, so it gets a much longer
// budget than the local-only one.
const GIT_STATUS_REFRESH_TIMEOUT_MS = 120_000;
// How long a (re)subscription may go without delivering a snapshot before it
// is treated as broken. The first expiries rebuild the stream; only the last
// one tells the UI the live status is broken rather than still loading.
const GIT_STATUS_FIRST_SNAPSHOT_TIMEOUT_MS = 20_000;
// The observed failure is a lost opening snapshot: the stream is accepted, the
// one-shot snapshot never arrives, and a quiet repo emits nothing afterwards.
// A fresh subscribe always heals it, so rebuild before showing a notice. The
// cap matters — in environments where subscribing can never succeed (browser
// tests, a server that is gone) this must settle instead of looping forever.
const GIT_STATUS_MAX_STREAM_REBUILDS = 2;
// One failed stream attempt is normal churn (socket blip, server restart).
// Only a retry that did not immediately recover is worth showing.
const GIT_STATUS_RETRY_ERROR_ATTEMPT_THRESHOLD = 2;

/** Shown wherever a broken status subscription surfaces, so it reads the same everywhere. */
export const GIT_STATUS_STALE_MESSAGE = "Source control status isn't updating.";

function gitStatusStreamError(cause?: unknown): Error {
  const error = new Error(GIT_STATUS_STALE_MESSAGE);
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function withGitStatusRequestTimeout<TResult>(
  request: Promise<TResult>,
  timeoutMs: number,
  label: string,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out waiting for the server.`));
    }, timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Runs one refresh RPC per cwd, guaranteeing the in-flight entry is released
 * even if the response never arrives. The entry is only cleared when it still
 * points at this attempt so a connection reset cannot make a stale promise
 * evict a live one.
 */
function trackGitStatusRefresh<TResult>(
  inFlight: Map<string, Promise<TResult>>,
  targetKey: string,
  request: Promise<TResult>,
  timeoutMs: number,
  label: string,
): Promise<TResult> {
  const tracked = withGitStatusRequestTimeout(request, timeoutMs, label).finally(() => {
    if (inFlight.get(targetKey) === tracked) {
      inFlight.delete(targetKey);
    }
  });
  inFlight.set(targetKey, tracked);
  return tracked;
}

// A promise created against a dead connection can never settle in time to be
// useful, so a connection change drops every in-flight entry and the debounce
// history. Otherwise the first refresh after a reconnect is deduped against a
// request the new connection never saw.
function clearGitStatusRefreshTracking(): void {
  gitStatusLocalRefreshInFlight.clear();
  gitStatusRefreshInFlight.clear();
  gitStatusLastRefreshAtByKey.clear();
}

let unsubscribeConnectionRefreshReset: (() => void) | null = null;

// Registered on first use rather than at import time: the environment runtime
// imports back into this module, so subscribing during module evaluation runs
// before the registry exists.
function ensureConnectionRefreshResetSubscribed(): void {
  unsubscribeConnectionRefreshReset ??= subscribeEnvironmentConnections(
    clearGitStatusRefreshTracking,
  );
}

const gitStatusStateAtom = Atom.family((key: string) => {
  knownGitStatusKeys.add(key);
  return Atom.make(INITIAL_GIT_STATUS_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-status:${key}`),
  );
});

function getGitStatusTargetKey(target: GitStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}`;
}

function readResolvedGitStatusClient(target: GitStatusTarget): ResolvedGitStatusClient | null {
  if (target.environmentId === null) {
    return null;
  }
  const connection = readEnvironmentConnection(target.environmentId);
  return connection
    ? { clientIdentity: connection.environmentId, client: connection.client.vcs }
    : null;
}

export function getGitStatusSnapshot(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return appAtomRegistry.get(gitStatusStateAtom(targetKey));
}

export function watchGitStatus(target: GitStatusTarget, client?: GitStatusClient): () => void {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return NOOP;
  }
  ensureConnectionRefreshResetSubscribed();

  const watched = watchedGitStatuses.get(targetKey);
  if (watched) {
    watched.refCount += 1;
    return () => unwatchGitStatus(targetKey);
  }

  watchedGitStatuses.set(targetKey, {
    refCount: 1,
    subscription: subscribeToGitStatusTarget(targetKey, target, client),
  });

  return () => unwatchGitStatus(targetKey);
}

/**
 * Forces the teardown-and-recreate that heals a stream whose opening snapshot
 * was lost. Exported for the panel's Retry: refreshing over the unary RPC
 * repairs the *data*, but leaves the dead stream in place, so the next real
 * change would go unnoticed again.
 */
export function rebuildGitStatusSubscription(target: GitStatusTarget): void {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return;
  }
  watchedGitStatuses.get(targetKey)?.subscription.rebuild();
}

export function refreshGitStatus(
  target: GitStatusTarget,
  client?: GitStatusClient,
  options?: GitStatusRefreshOptions,
): Promise<VcsStatusResult | null> {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null || target.cwd === null) {
    return Promise.resolve(null);
  }
  ensureConnectionRefreshResetSubscribed();

  const resolvedClient = client ?? readResolvedGitStatusClient(target)?.client;
  if (!resolvedClient) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  const currentInFlight = gitStatusRefreshInFlight.get(targetKey);
  if (currentInFlight) {
    return currentInFlight;
  }

  const lastRequestedAt = gitStatusLastRefreshAtByKey.get(targetKey) ?? 0;
  if (options?.force !== true && Date.now() - lastRequestedAt < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  gitStatusLastRefreshAtByKey.set(targetKey, Date.now());
  return trackGitStatusRefresh(
    gitStatusRefreshInFlight,
    targetKey,
    resolvedClient.refreshStatus({ cwd: target.cwd }).then((status) => {
      recoverGitStatusFromRefresh(targetKey, status);
      return status;
    }),
    GIT_STATUS_REFRESH_TIMEOUT_MS,
    "Git status refresh",
  );
}

/**
 * Feeds a full refresh response into the atom, but only while the live
 * subscription is broken (error set) or has never delivered. Under a healthy
 * stream the server publishes the same refresh as stream events, and writing
 * the unary response could race a newer pushed update; under a dead stream
 * this response is the only way the panel's Retry can actually recover.
 */
function recoverGitStatusFromRefresh(targetKey: string, status: VcsStatusResult): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  if (current.error === null && current.data !== null) {
    return;
  }
  appAtomRegistry.set(atom, {
    data: status,
    error: null,
    cause: null,
    isPending: false,
  });
}

/**
 * Same contract as `recoverGitStatusFromRefresh`, for the panel's 5s local
 * poll: while the stream is dead this response is the only fresh data the UI
 * can get, and dropping it left the panel frozen behind the stale notice.
 *
 * `localUpdated` is exactly this situation in the shared stream reducer, so it
 * does the merge: fresh local fields over the remote fields the last merged
 * snapshot carried (ahead/behind, PR), or the empty remote part when there is
 * no snapshot yet.
 */
function recoverGitStatusFromLocalRefresh(targetKey: string, local: VcsStatusLocalResult): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  if (current.error === null && current.data !== null) {
    return;
  }
  appAtomRegistry.set(atom, {
    data: applyGitStatusStreamEvent(current.data, { _tag: "localUpdated", local }),
    error: null,
    cause: null,
    isPending: false,
  });
}

export function refreshLocalGitStatus(
  target: GitStatusTarget,
  client?: GitStatusClient,
  options?: GitStatusRefreshOptions,
): Promise<VcsStatusLocalResult | null> {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null || target.cwd === null) {
    return Promise.resolve(null);
  }
  ensureConnectionRefreshResetSubscribed();

  const resolvedClient = client ?? readResolvedGitStatusClient(target)?.client;
  if (!resolvedClient?.refreshLocalStatus) {
    return Promise.resolve(null);
  }

  const currentInFlight = gitStatusLocalRefreshInFlight.get(targetKey);
  if (currentInFlight) {
    return currentInFlight;
  }

  const lastRequestedAt = gitStatusLastRefreshAtByKey.get(targetKey) ?? 0;
  if (options?.force !== true && Date.now() - lastRequestedAt < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  gitStatusLastRefreshAtByKey.set(targetKey, Date.now());
  return trackGitStatusRefresh(
    gitStatusLocalRefreshInFlight,
    targetKey,
    resolvedClient.refreshLocalStatus({ cwd: target.cwd }).then((local) => {
      recoverGitStatusFromLocalRefresh(targetKey, local);
      return local;
    }),
    GIT_STATUS_LOCAL_REFRESH_TIMEOUT_MS,
    "Local git status refresh",
  );
}

export function resetGitStatusStateForTests(): void {
  for (const watched of watchedGitStatuses.values()) {
    watched.subscription.unsubscribe();
  }
  watchedGitStatuses.clear();
  clearGitStatusRefreshTracking();
  unsubscribeConnectionRefreshReset?.();
  unsubscribeConnectionRefreshReset = null;

  for (const key of knownGitStatusKeys) {
    appAtomRegistry.set(gitStatusStateAtom(key), INITIAL_GIT_STATUS_STATE);
  }
  knownGitStatusKeys.clear();
}

export function useGitStatus(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  useEffect(
    () => watchGitStatus({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? gitStatusStateAtom(targetKey) : EMPTY_GIT_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_STATUS_STATE : state;
}

function unwatchGitStatus(targetKey: string): void {
  const watched = watchedGitStatuses.get(targetKey);
  if (!watched) {
    return;
  }

  watched.refCount -= 1;
  if (watched.refCount > 0) {
    return;
  }

  watched.subscription.unsubscribe();
  watchedGitStatuses.delete(targetKey);
}

const NOOP_GIT_STATUS_SUBSCRIPTION: GitStatusSubscription = {
  unsubscribe: NOOP,
  rebuild: NOOP,
};

function subscribeToGitStatusTarget(
  targetKey: string,
  target: GitStatusTarget,
  providedClient?: GitStatusClient,
): GitStatusSubscription {
  if (target.cwd === null) {
    return NOOP_GIT_STATUS_SUBSCRIPTION;
  }

  const cwd = target.cwd;
  let currentClientIdentity: string | null = null;
  let current: GitStatusSubscription = NOOP_GIT_STATUS_SUBSCRIPTION;

  const syncClientSubscription = () => {
    const resolved = providedClient
      ? {
          clientIdentity: `provided:${targetKey}`,
          client: providedClient,
        }
      : readResolvedGitStatusClient(target);

    if (!resolved) {
      if (currentClientIdentity !== null) {
        current.unsubscribe();
        current = NOOP_GIT_STATUS_SUBSCRIPTION;
        currentClientIdentity = null;
      }
      markGitStatusPending(targetKey);
      return;
    }

    if (currentClientIdentity === resolved.clientIdentity) {
      return;
    }

    current.unsubscribe();
    currentClientIdentity = resolved.clientIdentity;
    current = subscribeToGitStatus(targetKey, cwd, resolved.client);
  };

  const unsubscribeRegistry = providedClient
    ? NOOP
    : subscribeEnvironmentConnections(syncClientSubscription);
  syncClientSubscription();

  return {
    unsubscribe: () => {
      unsubscribeRegistry();
      current.unsubscribe();
    },
    rebuild: () => current.rebuild(),
  };
}

function subscribeToGitStatus(
  targetKey: string,
  cwd: string,
  client: GitStatusClient,
): GitStatusSubscription {
  let firstSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeStream = NOOP;
  let hasOpenedStream = false;
  let rebuildCount = 0;
  let disposed = false;

  const clearFirstSnapshotWatchdog = () => {
    if (firstSnapshotTimer !== null) {
      clearTimeout(firstSnapshotTimer);
      firstSnapshotTimer = null;
    }
  };
  // A subscription that is accepted but never pushes a snapshot is
  // indistinguishable from a slow one until this fires. Without it the panel
  // sits on `isPending` forever, which is what a half-dead socket produced.
  const startFirstSnapshotWatchdog = () => {
    clearFirstSnapshotWatchdog();
    firstSnapshotTimer = setTimeout(onFirstSnapshotTimeout, GIT_STATUS_FIRST_SNAPSHOT_TIMEOUT_MS);
  };

  const onFirstSnapshotTimeout = () => {
    firstSnapshotTimer = null;
    if (disposed) {
      return;
    }

    // The bucket carries the attempt so each of the (at most three) expiries in
    // a cycle is recorded: they are 20s apart, inside the 30s rate-limit window.
    recordStreamDiagnostic(
      STREAM_DIAGNOSTIC_NAMES.gitStatusWatchdogExpired,
      `${targetKey}#${rebuildCount}`,
      {
        "git.status.target": targetKey,
        "git.status.rebuild_count": rebuildCount,
        "git.status.timeout_ms": GIT_STATUS_FIRST_SNAPSHOT_TIMEOUT_MS,
      },
    );

    if (rebuildCount >= GIT_STATUS_MAX_STREAM_REBUILDS) {
      // Out of rebuilds: the notice is the last resort, not the first
      // response. Nothing restarts the watchdog from here, so this settles.
      markGitStatusStale(targetKey, gitStatusStreamError());
      return;
    }

    rebuildCount += 1;
    recordStreamDiagnostic(
      STREAM_DIAGNOSTIC_NAMES.gitStatusRebuild,
      `${targetKey}#${rebuildCount}`,
      {
        "git.status.target": targetKey,
        "git.status.rebuild_attempt": rebuildCount,
        "git.status.trigger": "watchdog",
      },
    );
    openStream();
  };

  function openStream(): void {
    if (disposed) {
      return;
    }

    // Release the old stream before opening the new one, and clear the handle
    // first so a teardown racing this rebuild cannot double-release it.
    const previousUnsubscribe = unsubscribeStream;
    unsubscribeStream = NOOP;
    previousUnsubscribe();

    // Only the first open announces "loading". Rebuilds keep whatever is on
    // screen (data or the stale notice) until an event actually arrives:
    // flipping back to pending on every rebuild makes the atom oscillate
    // pending↔stale in environments where subscribing never succeeds, and
    // that churn re-renders every consumer for a minute after mount.
    if (!hasOpenedStream) {
      hasOpenedStream = true;
      markGitStatusPending(targetKey);
    }
    startFirstSnapshotWatchdog();
    unsubscribeStream = client.onStatus(
      { cwd },
      (status: VcsStatusResult) => {
        clearFirstSnapshotWatchdog();
        // The stream is alive again, so the next silent stretch gets its own
        // full rebuild budget.
        rebuildCount = 0;
        appAtomRegistry.set(gitStatusStateAtom(targetKey), {
          data: status,
          error: null,
          cause: null,
          isPending: false,
        });
      },
      {
        onResubscribe: () => {
          rebuildCount = 0;
          markGitStatusPending(targetKey);
          startFirstSnapshotWatchdog();
        },
        onRetry: (error: unknown, attempt: number) => {
          recordStreamDiagnostic(STREAM_DIAGNOSTIC_NAMES.subscriptionRetry, targetKey, {
            "rpc.stream.tag": "vcs.subscribeVcsStatus",
            "git.status.target": targetKey,
            "rpc.stream.attempt": attempt,
            "error.message": error instanceof Error ? error.message : String(error),
          });
          if (attempt < GIT_STATUS_RETRY_ERROR_ATTEMPT_THRESHOLD) {
            return;
          }
          markGitStatusStale(targetKey, gitStatusStreamError(error));
        },
      },
    );
  }

  openStream();

  return {
    unsubscribe: () => {
      disposed = true;
      clearFirstSnapshotWatchdog();
      const previousUnsubscribe = unsubscribeStream;
      unsubscribeStream = NOOP;
      previousUnsubscribe();
    },
    rebuild: () => {
      if (disposed) {
        return;
      }
      // A manual rebuild is a user action (Retry), so it opens a fresh cycle
      // with a fresh budget. It cannot loop on its own.
      rebuildCount = 0;
      recordStreamDiagnostic(STREAM_DIAGNOSTIC_NAMES.gitStatusRebuild, targetKey, {
        "git.status.target": targetKey,
        "git.status.trigger": "manual",
      });
      openStream();
    },
  };
}

/**
 * Marks the live status as broken while keeping whatever snapshot is on
 * screen: stale data plus an explicit error reads better than a spinner that
 * never resolves.
 */
function markGitStatusStale(targetKey: string, error: GitStatusError): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  // Idempotent: a subscription that keeps failing calls this on every retry,
  // and re-setting an equivalent state re-renders every consumer each time —
  // enough churn to destabilize the whole app while a connection is down.
  if (!current.isPending && current.error?.message === error.message) {
    return;
  }
  // An atom that holds healthy data stays healthy: the poll lane refreshes it
  // every few seconds while the stream is broken, and the stale notice only
  // renders when there is no data. Setting the error here buys no UI and
  // makes the atom alternate broken↔healthy against the poll feed — the
  // exact churn loop that has destabilized the app twice (poll heals, retry
  // re-marks, forever). Dead-stream repair stays the rebuild machinery's job.
  if (current.data !== null && current.error === null && !current.isPending) {
    return;
  }
  appAtomRegistry.set(atom, {
    data: current.data,
    error,
    cause: Cause.fail(error),
    isPending: false,
  });
}

function markGitStatusPending(targetKey: string): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  const next =
    current.data === null
      ? INITIAL_GIT_STATUS_STATE
      : {
          ...current,
          error: null,
          cause: null,
          isPending: true,
        };

  if (
    current.data === next.data &&
    current.error === next.error &&
    current.cause === next.cause &&
    current.isPending === next.isPending
  ) {
    return;
  }

  appAtomRegistry.set(atom, next);
}
