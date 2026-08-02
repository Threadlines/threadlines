import { EnvironmentId, type VcsStatusResult } from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { WsRpcClient } from "../rpc/wsRpcClient";
import { resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  GIT_STATUS_STALE_MESSAGE,
  getGitStatusSnapshot,
  rebuildGitStatusSubscription,
  resetGitStatusStateForTests,
  refreshLocalGitStatus,
  refreshGitStatus,
  watchGitStatus,
} from "./gitStatusState";

const serviceHarness = vi.hoisted(() => ({
  connections: new Map<string, any>(),
  listeners: new Set<() => void>(),
}));

vi.mock("../environments/runtime/service", () => ({
  readEnvironmentConnection: (environmentId: string) =>
    serviceHarness.connections.get(environmentId) ?? null,
  subscribeEnvironmentConnections: (listener: () => void) => {
    serviceHarness.listeners.add(listener);
    return () => {
      serviceHarness.listeners.delete(listener);
    };
  },
}));

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const gitStatusListeners = new Set<(event: VcsStatusResult) => void>();
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const TARGET = { environmentId: ENVIRONMENT_ID, cwd: "/repo" } as const;
const FRESH_TARGET = { environmentId: ENVIRONMENT_ID, cwd: "/fresh" } as const;

const BASE_STATUS: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/push-status",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const gitClient = {
  refreshLocalStatus: vi.fn(async (input: { cwd: string }) => ({
    ...BASE_STATUS,
    refName: `${input.cwd}-local-refreshed`,
  })),
  refreshStatus: vi.fn(async (input: { cwd: string }) => ({
    ...BASE_STATUS,
    refName: `${input.cwd}-refreshed`,
  })),
  onStatus: vi.fn((input: { cwd: string }, listener: (event: VcsStatusResult) => void) =>
    registerListener(gitStatusListeners, listener),
  ),
};

function emitGitStatus(event: VcsStatusResult) {
  for (const listener of gitStatusListeners) {
    listener(event);
  }
}

interface StreamHooks {
  onResubscribe?: () => void;
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * A client whose stream can be driven directly: emit snapshots, replay the
 * transport's resubscribe/retry hooks, and count how many times the module
 * opened a *new* subscription (the observable signal that a rebuild happened).
 */
function createControllableGitStatusClient() {
  const listeners = new Set<(event: VcsStatusResult) => void>();
  let hooks: StreamHooks = {};
  const onStatus = vi.fn(
    (
      _input: { cwd: string },
      listener: (event: VcsStatusResult) => void,
      options?: StreamHooks,
    ) => {
      hooks = options ?? {};
      return registerListener(listeners, listener);
    },
  );

  return {
    client: {
      refreshStatus: vi.fn(async () => BASE_STATUS),
      refreshLocalStatus: vi.fn(async (input: { cwd: string }) => ({
        ...BASE_STATUS,
        refName: `${input.cwd}-local-refreshed`,
      })),
      onStatus,
    },
    onStatus,
    subscriberCount: () => listeners.size,
    emit: (event: VcsStatusResult) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    resubscribe: () => hooks.onResubscribe?.(),
    retry: (error: unknown, attempt: number) => hooks.onRetry?.(error, attempt),
  };
}

function createRegisteredGitStatusClient(environmentId: EnvironmentId) {
  const listeners = new Set<(event: VcsStatusResult) => void>();
  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    terminal: {
      open: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    vcs: {
      pull: vi.fn(async () => undefined),
      refreshLocalStatus: vi.fn(async (input: { cwd: string }) => ({
        ...BASE_STATUS,
        refName: `${input.cwd}-local-refreshed`,
      })),
      refreshStatus: vi.fn(async (input: { cwd: string }) => ({
        ...BASE_STATUS,
        refName: `${input.cwd}-refreshed`,
      })),
      onStatus: vi.fn((_: { cwd: string }, listener: (event: VcsStatusResult) => void) =>
        registerListener(listeners, listener),
      ),
      listRefs: vi.fn(async () => []),
      workingTreeDiff: vi.fn(async () => ({ diff: "" })),
      discardChanges: vi.fn(async () => ({ discardedPaths: [] })),
      stageChanges: vi.fn(async () => ({ stagedPaths: [] })),
      unstageChanges: vi.fn(async () => ({ unstagedPaths: [] })),
      createWorktree: vi.fn(async () => undefined),
      removeWorktree: vi.fn(async () => undefined),
      createRef: vi.fn(async () => undefined),
      createTag: vi.fn(async () => undefined),
      deleteBranch: vi.fn(async () => undefined),
      switchRef: vi.fn(async () => undefined),
      mergeRef: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
    },
    git: {
      runStackedAction: vi.fn(async () => ({}) as any),
      generateCommitMessage: vi.fn(async () => ({ subject: "test", body: "", message: "test" })),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId,
        },
      })),
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
      subscribeConfig: vi.fn(() => () => undefined),
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeAuthAccess: vi.fn(() => () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: vi.fn(() => () => undefined),
    },
  } as unknown as WsRpcClient;

  serviceHarness.connections.set(environmentId, {
    kind: "saved" as const,
    knownEnvironment: {
      id: environmentId,
      label: `Environment ${environmentId}`,
      source: "manual" as const,
      environmentId,
      target: {
        httpBaseUrl: "http://example.test",
        wsBaseUrl: "ws://example.test",
      },
    },
    client,
    environmentId,
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  });
  for (const listener of serviceHarness.listeners) {
    listener();
  }

  return {
    client,
    emit: (event: VcsStatusResult) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

afterEach(async () => {
  gitStatusListeners.clear();
  serviceHarness.connections.clear();
  serviceHarness.listeners.clear();
  gitClient.onStatus.mockClear();
  gitClient.refreshLocalStatus.mockClear();
  gitClient.refreshStatus.mockClear();
  resetGitStatusStateForTests();
  resetAppAtomRegistryForTests();
});

describe("gitStatusState", () => {
  it("starts fresh cwd state in a pending state", () => {
    expect(getGitStatusSnapshot(FRESH_TARGET)).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });
  });

  it("shares one live subscription per cwd and updates the per-cwd atom snapshot", () => {
    const releaseA = watchGitStatus(TARGET, gitClient);
    const releaseB = watchGitStatus(TARGET, gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });

    emitGitStatus(BASE_STATUS);

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    releaseA();
    expect(gitStatusListeners.size).toBe(1);

    releaseB();
    expect(gitStatusListeners.size).toBe(0);
  });

  it("refreshes git status through the unary RPC without restarting the stream", async () => {
    const release = watchGitStatus(TARGET, gitClient);

    emitGitStatus(BASE_STATUS);
    const refreshed = await refreshGitStatus(TARGET, gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(gitClient.refreshStatus).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(refreshed).toEqual({ ...BASE_STATUS, refName: "/repo-refreshed" });
    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("can force a git status refresh through the debounce window", async () => {
    const release = watchGitStatus(TARGET, gitClient);

    emitGitStatus(BASE_STATUS);
    await refreshGitStatus(TARGET, gitClient);
    await refreshGitStatus(TARGET, gitClient);
    await refreshGitStatus(TARGET, gitClient, { force: true });

    expect(gitClient.refreshStatus).toHaveBeenCalledTimes(2);

    release();
  });

  it("refreshes local git status without using the full remote refresh RPC", async () => {
    const release = watchGitStatus(TARGET, gitClient);

    emitGitStatus(BASE_STATUS);
    const healthy = getGitStatusSnapshot(TARGET);
    const refreshed = await refreshLocalGitStatus(TARGET, gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(gitClient.refreshLocalStatus).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(gitClient.refreshStatus).not.toHaveBeenCalled();
    expect(refreshed).toEqual({ ...BASE_STATUS, refName: "/repo-local-refreshed" });
    // Reference equality, not just deep equality: a poll landing on a healthy
    // atom must not write at all, or it races the live stream and re-renders
    // every consumer every 5 seconds.
    expect(getGitStatusSnapshot(TARGET)).toBe(healthy);
    expect(healthy).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("keeps git status subscriptions isolated by environment when cwds match", () => {
    const localListeners = new Set<(event: VcsStatusResult) => void>();
    const remoteListeners = new Set<(event: VcsStatusResult) => void>();
    const localClient = {
      refreshStatus: vi.fn(),
      onStatus: vi.fn((_: { cwd: string }, listener: (event: VcsStatusResult) => void) =>
        registerListener(localListeners, listener),
      ),
    };
    const remoteClient = {
      refreshStatus: vi.fn(),
      onStatus: vi.fn((_: { cwd: string }, listener: (event: VcsStatusResult) => void) =>
        registerListener(remoteListeners, listener),
      ),
    };
    const remoteTarget = { environmentId: OTHER_ENVIRONMENT_ID, cwd: "/repo" } as const;

    const releaseLocal = watchGitStatus(TARGET, localClient);
    const releaseRemote = watchGitStatus(remoteTarget, remoteClient);

    for (const listener of localListeners) {
      listener(BASE_STATUS);
    }
    for (const listener of remoteListeners) {
      listener({ ...BASE_STATUS, refName: "remote-refName" });
    }

    expect(getGitStatusSnapshot(TARGET).data?.refName).toBe("feature/push-status");
    expect(getGitStatusSnapshot(remoteTarget).data?.refName).toBe("remote-refName");

    releaseLocal();
    releaseRemote();
  });

  it("waits for a delayed environment client registration instead of throwing", () => {
    const release = watchGitStatus(TARGET);

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });

    const registered = createRegisteredGitStatusClient(ENVIRONMENT_ID);
    registered.emit(BASE_STATUS);

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("resubscribes after the environment client is removed and re-registered", async () => {
    const firstClient = createRegisteredGitStatusClient(ENVIRONMENT_ID);
    const release = watchGitStatus(TARGET);

    firstClient.emit(BASE_STATUS);
    expect(getGitStatusSnapshot(TARGET).data?.refName).toBe("feature/push-status");

    serviceHarness.connections.delete(ENVIRONMENT_ID);
    for (const listener of serviceHarness.listeners) {
      listener();
    }

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: true,
    });

    const secondClient = createRegisteredGitStatusClient(ENVIRONMENT_ID);
    secondClient.emit({ ...BASE_STATUS, refName: "reconnected-refName" });

    expect(getGitStatusSnapshot(TARGET)).toEqual({
      data: { ...BASE_STATUS, refName: "reconnected-refName" },
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("returns the cached snapshot when refresh is requested before the client is registered", async () => {
    await expect(refreshGitStatus(TARGET)).resolves.toBeNull();
  });

  it("rejects and releases the in-flight refresh when the response never arrives", async () => {
    vi.useFakeTimers();
    try {
      const stalledClient = {
        refreshStatus: vi.fn(() => new Promise<VcsStatusResult>(() => undefined)),
        onStatus: vi.fn(() => () => undefined),
      };

      const stalled = refreshGitStatus(TARGET, stalledClient, { force: true });
      const assertion = expect(stalled).rejects.toThrow(/timed out waiting for the server/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;

      // The stuck attempt must not block the next one for this cwd.
      stalledClient.refreshStatus.mockImplementation(async () => BASE_STATUS);
      await expect(refreshGitStatus(TARGET, stalledClient, { force: true })).resolves.toEqual(
        BASE_STATUS,
      );
      expect(stalledClient.refreshStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a broken subscription when no status arrives", async () => {
    vi.useFakeTimers();
    try {
      const release = watchGitStatus(TARGET, gitClient);

      expect(getGitStatusSnapshot(TARGET).isPending).toBe(true);

      // Two silent windows are spent rebuilding the stream; the notice only
      // appears after the third.
      await vi.advanceTimersByTimeAsync(60_000);

      const snapshot = getGitStatusSnapshot(TARGET);
      expect(snapshot.isPending).toBe(false);
      expect(snapshot.data).toBeNull();
      expect(snapshot.error?.message).toBe("Source control status isn't updating.");
      expect(snapshot.cause).not.toBeNull();

      emitGitStatus(BASE_STATUS);
      expect(getGitStatusSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: false,
      });

      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the same snapshot object across repeated subscription retries", () => {
    let retry: ((error: unknown, attempt: number) => void) | undefined;
    const failingClient = {
      refreshStatus: vi.fn(async () => BASE_STATUS),
      onStatus: vi.fn(
        (
          _input: { cwd: string },
          _listener: (event: VcsStatusResult) => void,
          options?: { onRetry?: (error: unknown, attempt: number) => void },
        ) => {
          retry = options?.onRetry;
          return () => undefined;
        },
      ),
    };
    const release = watchGitStatus(TARGET, failingClient);

    // A connection that stays down retries indefinitely; every retry past the
    // first must be a no-op on the atom or the whole app re-renders in a loop.
    retry?.(new Error("boom"), 2);
    const first = getGitStatusSnapshot(TARGET);
    expect(first.error).not.toBeNull();

    retry?.(new Error("boom"), 3);
    retry?.(new Error("boom"), 4);
    expect(getGitStatusSnapshot(TARGET)).toBe(first);

    release();
  });

  it("recovers a broken subscription from a successful manual refresh", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        refreshStatus: vi.fn(async () => BASE_STATUS),
        onStatus: vi.fn(() => () => undefined),
      };
      const release = watchGitStatus(TARGET, client);

      // The stream never delivers; the watchdog rebuilds twice, then marks
      // the status broken.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getGitStatusSnapshot(TARGET).error).not.toBeNull();

      // Retry goes over the unary path, which still works when only the
      // push stream is dead — its response must reach the atom.
      await expect(refreshGitStatus(TARGET, client, { force: true })).resolves.toEqual(BASE_STATUS);
      expect(getGitStatusSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: false,
      });

      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops in-flight refreshes when the environment connections change", async () => {
    const stalledClient = {
      refreshStatus: vi.fn(() => new Promise<VcsStatusResult>(() => undefined)),
      onStatus: vi.fn(() => () => undefined),
    };

    void refreshGitStatus(TARGET, stalledClient, { force: true }).catch(() => undefined);
    expect(stalledClient.refreshStatus).toHaveBeenCalledTimes(1);

    // Without clearing the in-flight map, this request is deduped against a
    // promise the new connection will never settle.
    void refreshGitStatus(TARGET, stalledClient, { force: true }).catch(() => undefined);
    expect(stalledClient.refreshStatus).toHaveBeenCalledTimes(1);

    for (const listener of serviceHarness.listeners) {
      listener();
    }

    void refreshGitStatus(TARGET, stalledClient, { force: true }).catch(() => undefined);
    expect(stalledClient.refreshStatus).toHaveBeenCalledTimes(2);
  });

  it("rebuilds a silent subscription twice before showing the stale notice", async () => {
    vi.useFakeTimers();
    try {
      const harness = createControllableGitStatusClient();
      const release = watchGitStatus(TARGET, harness.client);

      expect(harness.onStatus).toHaveBeenCalledOnce();

      // The reproduced failure is a lost opening snapshot on an otherwise
      // working socket, so each silent window buys a fresh subscribe rather
      // than a notice the user has to act on.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.onStatus).toHaveBeenCalledTimes(2);
      expect(harness.subscriberCount()).toBe(1);
      expect(getGitStatusSnapshot(TARGET).error).toBeNull();
      expect(getGitStatusSnapshot(TARGET).isPending).toBe(true);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.onStatus).toHaveBeenCalledTimes(3);
      expect(getGitStatusSnapshot(TARGET).error).toBeNull();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(getGitStatusSnapshot(TARGET).error?.message).toBe(GIT_STATUS_STALE_MESSAGE);

      // Bounded: once the notice is up nothing keeps resubscribing, or an
      // environment where subscribing can never succeed loops forever.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.onStatus).toHaveBeenCalledTimes(3);

      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a stream that delivered again a fresh rebuild budget", async () => {
    vi.useFakeTimers();
    try {
      const harness = createControllableGitStatusClient();
      const release = watchGitStatus(TARGET, harness.client);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.onStatus).toHaveBeenCalledTimes(3);
      expect(getGitStatusSnapshot(TARGET).error).not.toBeNull();

      harness.emit(BASE_STATUS);
      expect(getGitStatusSnapshot(TARGET)).toEqual({
        data: BASE_STATUS,
        error: null,
        cause: null,
        isPending: false,
      });

      // The transport restarting the stream reopens the watchdog. With the
      // budget reset by the delivered event, the next silence rebuilds again
      // instead of jumping straight back to the notice.
      harness.resubscribe();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.onStatus).toHaveBeenCalledTimes(4);
      expect(getGitStatusSnapshot(TARGET).error).toBeNull();

      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds the subscription on demand for the panel's retry", () => {
    const harness = createControllableGitStatusClient();
    const release = watchGitStatus(TARGET, harness.client);

    harness.emit(BASE_STATUS);
    rebuildGitStatusSubscription(TARGET);

    expect(harness.onStatus).toHaveBeenCalledTimes(2);
    expect(harness.subscriberCount()).toBe(1);

    release();
    expect(harness.subscriberCount()).toBe(0);

    // Nothing is watching this target any more, so retrying must be inert.
    rebuildGitStatusSubscription(TARGET);
    expect(harness.onStatus).toHaveBeenCalledTimes(2);
  });

  it("feeds the local poll response into a status atom the stream never filled", async () => {
    vi.useFakeTimers();
    try {
      const harness = createControllableGitStatusClient();
      const release = watchGitStatus(TARGET, harness.client);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(getGitStatusSnapshot(TARGET).data).toBeNull();
      expect(getGitStatusSnapshot(TARGET).error).not.toBeNull();

      await refreshLocalGitStatus(TARGET, harness.client, { force: true });

      const snapshot = getGitStatusSnapshot(TARGET);
      expect(snapshot.data?.refName).toBe("/repo-local-refreshed");
      expect(snapshot.error).toBeNull();
      expect(snapshot.cause).toBeNull();
      expect(snapshot.isPending).toBe(false);

      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlays the local poll response without dropping remote-derived fields", async () => {
    const harness = createControllableGitStatusClient();
    const release = watchGitStatus(TARGET, harness.client);

    harness.emit({ ...BASE_STATUS, aheadCount: 3, behindCount: 1 });
    harness.retry(new Error("stream died"), 2);
    expect(getGitStatusSnapshot(TARGET).error).not.toBeNull();

    await refreshLocalGitStatus(TARGET, harness.client, { force: true });

    const snapshot = getGitStatusSnapshot(TARGET);
    expect(snapshot.error).toBeNull();
    expect(snapshot.data?.refName).toBe("/repo-local-refreshed");
    // Only the local half is fresh: ahead/behind come from the last snapshot
    // the stream did deliver, and the local RPC knows nothing about them.
    expect(snapshot.data?.aheadCount).toBe(3);
    expect(snapshot.data?.behindCount).toBe(1);

    release();
  });
});
