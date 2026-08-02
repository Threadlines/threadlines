import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type GitManagerServiceError,
  type VcsStatusLocalResult,
  type VcsStatusResult,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
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

interface WatchedGitStatus {
  refCount: number;
  unsubscribe: () => void;
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
// How long a (re)subscription may go without delivering a snapshot before the
// UI is told the live status is broken rather than still loading.
const GIT_STATUS_FIRST_SNAPSHOT_TIMEOUT_MS = 20_000;
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
    unsubscribe: subscribeToGitStatusTarget(targetKey, target, client),
  });

  return () => unwatchGitStatus(targetKey);
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
    resolvedClient.refreshLocalStatus({ cwd: target.cwd }),
    GIT_STATUS_LOCAL_REFRESH_TIMEOUT_MS,
    "Local git status refresh",
  );
}

export function resetGitStatusStateForTests(): void {
  for (const watched of watchedGitStatuses.values()) {
    watched.unsubscribe();
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

  watched.unsubscribe();
  watchedGitStatuses.delete(targetKey);
}

function subscribeToGitStatusTarget(
  targetKey: string,
  target: GitStatusTarget,
  providedClient?: GitStatusClient,
): () => void {
  if (target.cwd === null) {
    return NOOP;
  }

  const cwd = target.cwd;
  let currentClientIdentity: string | null = null;
  let currentUnsubscribe = NOOP;

  const syncClientSubscription = () => {
    const resolved = providedClient
      ? {
          clientIdentity: `provided:${targetKey}`,
          client: providedClient,
        }
      : readResolvedGitStatusClient(target);

    if (!resolved) {
      if (currentClientIdentity !== null) {
        currentUnsubscribe();
        currentUnsubscribe = NOOP;
        currentClientIdentity = null;
      }
      markGitStatusPending(targetKey);
      return;
    }

    if (currentClientIdentity === resolved.clientIdentity) {
      return;
    }

    currentUnsubscribe();
    currentClientIdentity = resolved.clientIdentity;
    currentUnsubscribe = subscribeToGitStatus(targetKey, cwd, resolved.client);
  };

  const unsubscribeRegistry = providedClient
    ? NOOP
    : subscribeEnvironmentConnections(syncClientSubscription);
  syncClientSubscription();

  return () => {
    unsubscribeRegistry();
    currentUnsubscribe();
  };
}

function subscribeToGitStatus(targetKey: string, cwd: string, client: GitStatusClient): () => void {
  let firstSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

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
    firstSnapshotTimer = setTimeout(() => {
      firstSnapshotTimer = null;
      markGitStatusStale(targetKey, gitStatusStreamError());
    }, GIT_STATUS_FIRST_SNAPSHOT_TIMEOUT_MS);
  };

  markGitStatusPending(targetKey);
  startFirstSnapshotWatchdog();
  const unsubscribe = client.onStatus(
    { cwd },
    (status: VcsStatusResult) => {
      clearFirstSnapshotWatchdog();
      appAtomRegistry.set(gitStatusStateAtom(targetKey), {
        data: status,
        error: null,
        cause: null,
        isPending: false,
      });
    },
    {
      onResubscribe: () => {
        markGitStatusPending(targetKey);
        startFirstSnapshotWatchdog();
      },
      onRetry: (error: unknown, attempt: number) => {
        if (attempt < GIT_STATUS_RETRY_ERROR_ATTEMPT_THRESHOLD) {
          return;
        }
        markGitStatusStale(targetKey, gitStatusStreamError(error));
      },
    },
  );

  return () => {
    clearFirstSnapshotWatchdog();
    unsubscribe();
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
