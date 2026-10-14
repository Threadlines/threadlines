import { QueryClient } from "@tanstack/react-query";
import { EnvironmentId } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockFetchRemoteSessionState = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockIsRemoteEnvironmentUnreachableError = vi.fn();
const mockIsRemoteEnvironmentAuthHttpError = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();

function MockWsTransport() {
  return undefined;
}

const savedEnvironmentRuntimeById: Record<string, Record<string, unknown>> = {};
let activeEnvironmentId: EnvironmentId | null = null;

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    id: "env-1",
    label: "Primary environment",
    source: "window-origin",
    target: {
      httpBaseUrl: "http://127.0.0.1:3000/",
      wsBaseUrl: "ws://127.0.0.1:3000/",
    },
    environmentId: EnvironmentId.make("env-1"),
  })),
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: vi.fn(),
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: mockIsRemoteEnvironmentAuthHttpError,
  isRemoteEnvironmentUnreachableError: mockIsRemoteEnvironmentUnreachableError,
  resolveRemoteWebSocketConnectionUrl: vi.fn(() => "ws://remote.example.test"),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
      rename: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      byId: savedEnvironmentRuntimeById,
      ensure: vi.fn(),
      patch: (environmentId: EnvironmentId, patch: Record<string, unknown>) => {
        savedEnvironmentRuntimeById[environmentId] = {
          ...savedEnvironmentRuntimeById[environmentId],
          ...patch,
        };
      },
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

vi.mock("~/composerDraftStore", () => ({
  markPromotedDraftThreadByRef: vi.fn(),
  markPromotedDraftThreadsByRef: vi.fn(),
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByRef: vi.fn(() => null),
      clearDraftThread: vi.fn(),
    }),
  },
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => ({
    persistence: {
      setSavedEnvironmentRegistry: vi.fn(async () => undefined),
    },
  })),
}));

vi.mock("~/lib/terminalStateCleanup", () => ({
  collectActiveTerminalThreadIds: vi.fn(() => []),
}));

vi.mock("~/orchestrationEventEffects", () => ({
  deriveOrchestrationBatchEffects: vi.fn(() => ({
    promotedThreadRefs: [],
    invalidatedProviderState: false,
  })),
}));

vi.mock("~/lib/projectReactQuery", () => ({
  projectQueryKeys: {
    all: ["projects"],
  },
}));

vi.mock("~/lib/providerReactQuery", () => ({
  providerQueryKeys: {
    all: ["providers"],
  },
}));

vi.mock("~/store", () => ({
  useStore: {
    getState: () => ({
      get activeEnvironmentId() {
        return activeEnvironmentId;
      },
      syncServerShellSnapshot: vi.fn(),
      syncServerThreadDetail: vi.fn(),
      removeServerThreadDetail: vi.fn(),
      applyServerShellEvent: vi.fn(),
    }),
  },
  selectProjectsAcrossEnvironments: vi.fn(() => []),
  selectSidebarThreadSummaryByRef: vi.fn(() => null),
  selectThreadByRef: vi.fn(() => null),
  selectThreadsAcrossEnvironments: vi.fn(() => []),
}));

vi.mock("~/terminalStateStore", () => ({
  useTerminalStateStore: {
    getState: () => ({
      applyTerminalEvent: vi.fn(),
      removeTerminalState: vi.fn(),
      clearTerminalSelection: vi.fn(),
    }),
  },
}));

vi.mock("~/uiStateStore", () => ({
  useUiStateStore: {
    getState: () => ({
      clearThreadUi: vi.fn(),
      syncPromotedDraftThreadRefs: vi.fn(),
    }),
  },
}));

const savedRecord = {
  environmentId: EnvironmentId.make("env-saved"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.test/",
  wsBaseUrl: "wss://remote.example.test/",
};

/** What a request to a computer that is asleep fails with. */
const UNREACHABLE = new Error("Failed to fetch remote auth endpoint (Failed to fetch).");
/** What a computer that no longer accepts the saved sign-in answers. */
const REFUSED = Object.assign(new Error("Unauthorized"), { status: 401 });

const configSnapshot = {
  environment: {
    environmentId: savedRecord.environmentId,
    label: "Remote environment",
  },
};

function createClient() {
  return {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    server: {
      getConfig: vi.fn(async () => configSnapshot),
      subscribeConfig: vi.fn(() => () => undefined),
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeAuthAccess: vi.fn(() => () => undefined),
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: vi.fn(() => () => undefined),
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
    },
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
    git: {
      pull: vi.fn(async () => undefined),
      refreshStatus: vi.fn(async () => undefined),
      onStatus: vi.fn(() => () => undefined),
      runStackedAction: vi.fn(async () => ({})),
      generateCommitMessage: vi.fn(async () => ({ subject: "test", body: "", message: "test" })),
      listBranches: vi.fn(async () => []),
      createWorktree: vi.fn(async () => undefined),
      removeWorktree: vi.fn(async () => undefined),
      createBranch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
  };
}

describe("saved environment startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    for (const environmentId of Object.keys(savedEnvironmentRuntimeById)) {
      delete savedEnvironmentRuntimeById[environmentId];
    }
    activeEnvironmentId = null;

    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "owner",
    });
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue(configSnapshot.environment);
    mockIsRemoteEnvironmentUnreachableError.mockImplementation(
      (error: unknown) => error === UNREACHABLE,
    );
    mockIsRemoteEnvironmentAuthHttpError.mockImplementation((error: unknown) => error === REFUSED);
    mockGetSavedEnvironmentRecord.mockImplementation((environmentId: EnvironmentId) =>
      environmentId === savedRecord.environmentId ? savedRecord : null,
    );
    mockListSavedEnvironmentRecords.mockReturnValue([savedRecord]);
    mockSavedEnvironmentRegistrySubscribe.mockReturnValue(() => undefined);
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("saved-bearer-token");
    mockCreateWsRpcClient.mockImplementation(() => createClient());
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      if (input.kind === "saved") {
        queueMicrotask(() => {
          input.onConfigEvent?.({ version: 1, type: "snapshot", config: configSnapshot });
        });
      }

      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      };
    });
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.useRealTimers();
  });

  it("uses the initial config snapshot instead of issuing an extra getConfig call", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.runAllTimersAsync();

    const savedConnectionCall = mockCreateEnvironmentConnection.mock.calls.find(
      ([input]) => input.kind === "saved",
    );
    expect(savedConnectionCall).toBeDefined();

    const savedClient = savedConnectionCall?.[0]?.client;
    expect(savedClient.server.getConfig).not.toHaveBeenCalled();
    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps the stored config current as live provider statuses arrive", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.runAllTimersAsync();

    const savedConnectionInput = mockCreateEnvironmentConnection.mock.calls.find(
      ([input]) => input.kind === "saved",
    )?.[0];
    const providers = [{ instanceId: "codex", status: "ready" }];
    savedConnectionInput.onConfigEvent({
      version: 1,
      type: "providerStatuses",
      payload: { providers },
    });

    expect(savedEnvironmentRuntimeById[savedRecord.environmentId]?.serverConfig).toEqual({
      ...configSnapshot,
      providers,
    });

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("treats the active environment as the backend when the app has none of its own", async () => {
    const { getPrimaryKnownEnvironment } = await import("../primary");
    const {
      startEnvironmentConnectionService,
      readBackendEnvironmentConnection,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.runAllTimersAsync();

    // The hosted app serves no backend of its own; the paired environment the
    // user is looking at answers settings and provider calls instead.
    vi.mocked(getPrimaryKnownEnvironment).mockReturnValue(null);
    activeEnvironmentId = savedRecord.environmentId;

    expect(readBackendEnvironmentConnection()?.environmentId).toBe(savedRecord.environmentId);

    activeEnvironmentId = null;
    expect(readBackendEnvironmentConnection()).toBeNull();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("coalesces hydration and registry sync so the initial saved connection only starts once", async () => {
    let finishHydration!: () => void;
    let finishTokenRead!: (token: string) => void;

    mockWaitForSavedEnvironmentRegistryHydration.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHydration = () => resolve();
        }),
    );
    mockReadSavedEnvironmentBearerToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishTokenRead = resolve;
        }),
    );

    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const registryListener = mockSavedEnvironmentRegistrySubscribe.mock.calls[0]?.[0];
    expect(registryListener).toBeTypeOf("function");

    registryListener?.();
    finishHydration();
    await vi.waitFor(() => {
      expect(mockReadSavedEnvironmentBearerToken).toHaveBeenCalledTimes(1);
    });

    finishTokenRead("saved-bearer-token");
    await vi.runAllTimersAsync();

    const savedConnectionCalls = mockCreateEnvironmentConnection.mock.calls.filter(
      ([input]) => input.kind === "saved",
    );
    expect(savedConnectionCalls).toHaveLength(1);
    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });
  it("keeps checking a computer that was asleep at startup and connects once it answers", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(UNREACHABLE);
    mockFetchRemoteEnvironmentDescriptor.mockRejectedValueOnce(UNREACHABLE);
    const { startEnvironmentConnectionService, readEnvironmentConnection } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    expect(readEnvironmentConnection(savedRecord.environmentId)).toBeNull();
    expect(savedEnvironmentRuntimeById[savedRecord.environmentId]).toMatchObject({
      connectionState: "disconnected",
      lastError:
        "Can't reach Remote environment. It may be asleep, off, or offline. Threadlines will connect when it's back.",
    });

    // Still asleep at the first check.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalledTimes(1);
    expect(readEnvironmentConnection(savedRecord.environmentId)).toBeNull();

    // Awake at the next one.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalledTimes(2);
    expect(readEnvironmentConnection(savedRecord.environmentId)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalledTimes(2);
    stop();
  });

  it("leaves a computer that refuses the saved sign-in for the user", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(REFUSED);
    const { startEnvironmentConnectionService, readEnvironmentConnection } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(1);
    expect(readEnvironmentConnection(savedRecord.environmentId)).toBeNull();
    stop();
  });

  it("does not start checking when the user disconnects while the first attempt is out", async () => {
    let failSessionFetch!: (error: Error) => void;
    mockFetchRemoteSessionState.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failSessionFetch = reject;
        }),
    );
    const { startEnvironmentConnectionService, disconnectSavedEnvironment } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    await disconnectSavedEnvironment(savedRecord.environmentId);
    failSessionFetch(UNREACHABLE);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    stop();
  });

  it("leaves a computer being checked alone when other saved computers change", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(UNREACHABLE);
    mockFetchRemoteEnvironmentDescriptor.mockRejectedValue(UNREACHABLE);
    const { startEnvironmentConnectionService } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    const registryListener = mockSavedEnvironmentRegistrySubscribe.mock.calls[0]?.[0];
    registryListener?.();
    await vi.advanceTimersByTimeAsync(200);

    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not reconnect again when Connect wins the race with a check", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(UNREACHABLE);
    let answerCheck!: () => void;
    mockFetchRemoteEnvironmentDescriptor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerCheck = () => resolve(configSnapshot.environment);
        }),
    );
    const {
      startEnvironmentConnectionService,
      reconnectSavedEnvironment,
      readEnvironmentConnection,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(1_200);
    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalledTimes(1);

    await reconnectSavedEnvironment(savedRecord.environmentId);
    answerCheck();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(readEnvironmentConnection(savedRecord.environmentId)?.reconnect).not.toHaveBeenCalled();
    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalledTimes(1);
    stop();
  });
  it("takes back its promise to reconnect when the user disconnects a computer being checked", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(UNREACHABLE);
    const { startEnvironmentConnectionService, disconnectSavedEnvironment } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    await disconnectSavedEnvironment(savedRecord.environmentId);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(savedEnvironmentRuntimeById[savedRecord.environmentId]?.lastError).toBeNull();
    stop();
  });

  it("does not start checking when the user disconnects while a failed attempt cleans up", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(UNREACHABLE);
    let finishCleanup!: () => void;
    const createConnection = mockCreateEnvironmentConnection.getMockImplementation()!;
    let slowedSavedCleanup = false;
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const connection = createConnection(input);
      if (input.kind !== "saved" || slowedSavedCleanup) return connection;
      slowedSavedCleanup = true;
      return {
        ...connection,
        dispose: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishCleanup = resolve;
            }),
        ),
      };
    });
    const { startEnvironmentConnectionService, disconnectSavedEnvironment } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    await disconnectSavedEnvironment(savedRecord.environmentId);
    finishCleanup();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    stop();
  });

  it("keeps checking after a newer attempt even when an older, disconnected one fails late", async () => {
    let failFirstAttempt!: (error: Error) => void;
    mockFetchRemoteSessionState
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirstAttempt = reject;
          }),
      )
      .mockRejectedValueOnce(UNREACHABLE);
    mockFetchRemoteEnvironmentDescriptor.mockRejectedValue(UNREACHABLE);
    const {
      startEnvironmentConnectionService,
      disconnectSavedEnvironment,
      reconnectSavedEnvironment,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    await disconnectSavedEnvironment(savedRecord.environmentId);
    await reconnectSavedEnvironment(savedRecord.environmentId).catch(() => undefined);
    failFirstAttempt(UNREACHABLE);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalled();
    stop();
  });
  it("leaves a newer connection alone when an older, disconnected attempt fails late", async () => {
    let failFirstAttempt!: (error: Error) => void;
    mockFetchRemoteSessionState.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirstAttempt = reject;
        }),
    );
    const {
      startEnvironmentConnectionService,
      disconnectSavedEnvironment,
      reconnectSavedEnvironment,
      readEnvironmentConnection,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await vi.advanceTimersByTimeAsync(200);
    await disconnectSavedEnvironment(savedRecord.environmentId);
    await reconnectSavedEnvironment(savedRecord.environmentId);
    const connected = readEnvironmentConnection(savedRecord.environmentId);
    failFirstAttempt(UNREACHABLE);
    await vi.advanceTimersByTimeAsync(200);

    expect(readEnvironmentConnection(savedRecord.environmentId)).toBe(connected);
    expect(connected?.dispose).not.toHaveBeenCalled();
    stop();
  });
});
