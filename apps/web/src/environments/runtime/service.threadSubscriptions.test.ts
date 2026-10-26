import { QueryClient } from "@tanstack/react-query";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
} from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockGetPrimaryKnownEnvironment = vi.hoisted(() => vi.fn());
const mockFetchRemoteSessionState = vi.fn();
const mockConnectionReconnects: Array<ReturnType<typeof vi.fn>> = [];
let savedEnvironmentRegistryListener: (() => void) | null = null;

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: mockGetPrimaryKnownEnvironment,
  readPrimaryEnvironmentDescriptor: vi.fn(() => null),
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: vi.fn(),
  fetchRemoteEnvironmentDescriptor: vi.fn(),
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: vi.fn(() => false),
  resolveRemoteWebSocketConnectionUrl: vi.fn(async () => "ws://remote.example.test/ws"),
  isRemoteEnvironmentUnreachableError: vi.fn(() => false),
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
      byId: {},
      ensure: vi.fn(),
      patch: vi.fn(),
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

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        effectiveCwd: null,
        goal: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        pinnedAt: null,
        pullRequestAutoFix: false,
        pullRequestAutoMerge: null,
        linkedPullRequests: [],
        participants: [],
        doneOverride: null,
        lastSeenAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              providerThreadId: null,
              providerSessionId: null,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
        cumulativeDiffStat: null,
        diffStatBaselineTurnCount: 0,
        parentThreadId: null,
        parentTurnId: null,
        attachedToParent: false,
        handedBackAt: null,
        handedBackTurnId: null,
        awaitedChildThreadCount: 0,
        pendingChildApproval: false,
      },
    ],
  };
}

function makeShellSnapshot(
  threads: ReadonlyArray<Parameters<typeof makeThreadShellSnapshot>[0]>,
): OrchestrationShellSnapshot {
  return {
    ...makeThreadShellSnapshot(threads[0]!),
    threads: threads.map((params) => makeThreadShellSnapshot(params).threads[0]!),
  };
}

/** Thread ids in the order their detail streams were opened. */
function subscribedThreadIds(): string[] {
  return mockSubscribeThread.mock.calls.map(([input]) => input.threadId);
}

/** Answers a thread's open detail stream with its (empty) snapshot. */
function deliverThreadSnapshot(threadId: ThreadId): void {
  const call = mockSubscribeThread.mock.calls.findLast(([input]) => input.threadId === threadId);
  const thread = makeThreadShellSnapshot({ threadId }).threads[0]!;
  call?.[1]({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      thread: {
        ...thread,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    },
  });
}

type PointerListener = (event: PointerEvent) => void;

/** A stand-in for `document` that the hover binder listens on. */
function createPointerTarget() {
  const listeners = new Map<string, Set<PointerListener>>();
  return {
    addEventListener: (type: string, listener: PointerListener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: PointerListener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string, row: object, pointerType: "mouse" | "touch" = "mouse") => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ target: row, relatedTarget: null, pointerType } as never);
      }
    },
  };
}

/** A sidebar row carrying `data-thread-key`, as the hover binder finds it. */
function createThreadRow(threadKey: string) {
  const row = {
    closest: () => row,
    getAttribute: (name: string) => (name === "data-thread-key" ? threadKey : null),
    contains: (other: unknown) => other === row,
  };
  return row;
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
      environmentId: EnvironmentId.make("env-1"),
    });

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => true),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });
    savedEnvironmentRegistryListener = null;
    mockSavedEnvironmentRegistrySubscribe.mockImplementation((listener: () => void) => {
      savedEnvironmentRegistryListener = listener;
      return () => {
        if (savedEnvironmentRegistryListener === listener) {
          savedEnvironmentRegistryListener = null;
        }
      };
    });
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
    mockGetSavedEnvironmentRecord.mockReturnValue(null);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "client",
    });
    mockConnectionReconnects.length = 0;
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("advances the mutable resume cursor after a thread snapshot", async () => {
    const { retainThreadDetailSubscription, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-resume");
    const release = retainThreadDetailSubscription(environmentId, threadId);
    const [resumeInput, listener] = mockSubscribeThread.mock.calls[0] ?? [];
    const threadShell = makeThreadShellSnapshot({ threadId }).threads[0]!;

    listener({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 42,
        thread: {
          ...threadShell,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          deletedAt: null,
        },
      },
    });

    expect(resumeInput).toEqual({ threadId, fromSequenceExclusive: 42, acceptsPayloadRefs: true });

    release();
    stop();
  });

  it("restores values a snapshot shares before the thread reaches the store", async () => {
    const { retainThreadDetailSubscription, startEnvironmentConnectionService } =
      await import("./service");
    const { useStore, selectThreadByRef } = await import("../../store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-shared-values");
    const release = retainThreadDetailSubscription(environmentId, threadId);
    const [, listener] = mockSubscribeThread.mock.calls[0] ?? [];
    const threadShell = makeThreadShellSnapshot({ threadId }).threads[0]!;
    const screenshot = "iVBORw0KGgo".padEnd(2048, "A");
    const completionCopy = {
      $threadlinesPayloadRef: ["a1", "data", "result", "content", 0, "data"],
    };
    const activity = (id: string, kind: string, data: unknown) => ({
      id: EventId.make(id),
      tone: "tool" as const,
      kind,
      summary: kind,
      payload: { toolCallId: "call-1", data: { result: { content: [{ type: "image", data }] } } },
      turnId: null,
      createdAt: "2026-10-16T10:00:00.000Z",
    });

    const snapshot = (sharedPayloadValues: boolean) => ({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 7,
        thread: {
          ...threadShell,
          messages: [],
          activities: [
            activity("a1", "tool.updated", screenshot),
            activity("a2", "tool.completed", completionCopy),
          ],
          proposedPlans: [],
          checkpoints: [],
          deletedAt: null,
        },
        ...(sharedPayloadValues ? { sharedPayloadValues: true } : {}),
      },
    });
    const storedPayloads = () =>
      selectThreadByRef(
        useStore.getState(),
        scopeThreadRef(environmentId, threadId),
      )?.activities.map((entry) => entry.payload);

    // As a server sends the completion's copy to a client that asked.
    listener(snapshot(true));
    expect(storedPayloads()).toEqual([
      activity("a1", "tool.updated", screenshot).payload,
      activity("a2", "tool.completed", screenshot).payload,
    ]);

    // Without the mark, data that only looks like a reference is kept as stored.
    listener(snapshot(false));
    expect(storedPayloads()).toEqual([
      activity("a1", "tool.updated", screenshot).payload,
      activity("a2", "tool.completed", completionCopy).payload,
    ]);

    release();
    stop();
  });

  it("restarts a retained thread detail subscription to request a fresh snapshot", async () => {
    const {
      refreshThreadDetailSubscription,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-refresh");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    const [, listener] = mockSubscribeThread.mock.calls[0] ?? [];
    const threadShell = makeThreadShellSnapshot({ threadId }).threads[0]!;
    listener({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 42,
        thread: {
          ...threadShell,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          deletedAt: null,
        },
      },
    });

    expect(refreshThreadDetailSubscription(environmentId, threadId)).toBe(true);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    expect(mockSubscribeThread).toHaveBeenLastCalledWith(
      { threadId, acceptsPayloadRefs: true },
      expect.any(Function),
      expect.objectContaining({ onRetry: expect.any(Function) }),
    );

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not create an unretained subscription during a targeted refresh", async () => {
    const {
      refreshThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());

    expect(
      refreshThreadDetailSubscription(
        EnvironmentId.make("env-1"),
        ThreadId.make("thread-not-retained"),
      ),
    ).toBe(false);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not start the primary connection until the known environment has an id", async () => {
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
    });
    const {
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());

    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toEqual([]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("warms non-idle thread detail subscriptions from shell snapshots without a mounted chat view", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-running");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );

    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockSubscribeThread).toHaveBeenCalledWith(
      { threadId, acceptsPayloadRefs: true },
      expect.any(Function),
      expect.objectContaining({ onRetry: expect.any(Function) }),
    );

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not warm idle thread detail subscriptions from shell snapshots", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-idle");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "idle",
      }),
      environmentId,
    );

    expect(mockSubscribeThread).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("warms newly upserted non-idle thread detail subscriptions without a mounted chat view", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-promoted");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    const thread = makeThreadShellSnapshot({
      threadId,
      sessionStatus: "running",
    }).threads[0]!;

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 1,
        thread,
      },
      environmentId,
    );

    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockSubscribeThread).toHaveBeenCalledWith(
      { threadId, acceptsPayloadRefs: true },
      expect.any(Function),
      expect.objectContaining({ onRetry: expect.any(Function) }),
    );

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("evicts automatically warmed thread detail subscriptions once the thread becomes idle", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-warm-evict");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "running",
      }),
      environmentId,
    );
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reattaches retained thread detail subscriptions after a saved environment reconnect replaces the client", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const threadId = ThreadId.make("thread-reconnect");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(2);
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await disconnectSavedEnvironment(environmentId);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      listEnvironmentConnections().some((connection) => connection.environmentId === environmentId),
    ).toBe(false);

    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(3);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps healthy environment streams connected when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects stale environment streams when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");

    for (let index = 0; index < 12; index += 1) {
      const release = retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });

  it("opens the launch chat right after the thread list, and warm threads and idle prewarm once it loads", async () => {
    const {
      requestIdleThreadDetailPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const launchThreadId = ThreadId.make("thread-launch");
    const runningThreadId = ThreadId.make("thread-running");
    const topThreadId = ThreadId.make("thread-top");

    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: scopeThreadRef(environmentId, launchThreadId),
    });
    // The sidebar's thread list goes first; nothing else is on the wire yet.
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(
      makeShellSnapshot([
        { threadId: launchThreadId },
        { threadId: runningThreadId, sessionStatus: "running" },
        { threadId: topThreadId },
      ]),
      environmentId,
    );
    expect(subscribedThreadIds()).toEqual([launchThreadId]);
    const cancelPrewarm = requestIdleThreadDetailPrewarm([
      scopeThreadRef(environmentId, topThreadId),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscribedThreadIds()).toEqual([launchThreadId]);

    deliverThreadSnapshot(launchThreadId);
    expect(subscribedThreadIds()).toEqual([launchThreadId, runningThreadId]);
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribedThreadIds()).toEqual([launchThreadId, runningThreadId, topThreadId]);

    cancelPrewarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("lets warm threads through after a short cap when the launch chat is slow", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const launchThreadId = ThreadId.make("thread-launch");
    const runningThreadId = ThreadId.make("thread-running");

    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: scopeThreadRef(environmentId, launchThreadId),
    });
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([
        { threadId: launchThreadId },
        { threadId: runningThreadId, sessionStatus: "running" },
      ]),
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(1_400);
    expect(subscribedThreadIds()).toEqual([launchThreadId]);
    await vi.advanceTimersByTimeAsync(200);
    expect(subscribedThreadIds()).toEqual([launchThreadId, runningThreadId]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("opens the launch chat after a short cap when the thread list is slow", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const launchThreadId = ThreadId.make("thread-launch");

    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: scopeThreadRef(EnvironmentId.make("env-1"), launchThreadId),
    });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(mockSubscribeThread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(subscribedThreadIds()).toEqual([launchThreadId]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("never requests a launch chat the thread list no longer has, and lets warm threads go", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const runningThreadId = ThreadId.make("thread-running");

    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: scopeThreadRef(environmentId, ThreadId.make("thread-deleted")),
    });
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([{ threadId: runningThreadId, sessionStatus: "running" }]),
      environmentId,
    );
    expect(subscribedThreadIds()).toEqual([runningThreadId]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("starts warm threads and idle prewarm right away when the launch opens no chat", async () => {
    const {
      requestIdleThreadDetailPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const runningThreadId = ThreadId.make("thread-running");
    const topThreadId = ThreadId.make("thread-top");

    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: null,
    });
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([
        { threadId: runningThreadId, sessionStatus: "running" },
        { threadId: topThreadId },
      ]),
      environmentId,
    );
    expect(subscribedThreadIds()).toEqual([runningThreadId]);

    const cancelPrewarm = requestIdleThreadDetailPrewarm([
      scopeThreadRef(environmentId, topThreadId),
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([runningThreadId, topThreadId]);

    cancelPrewarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reopens the mounted chat first after a reconnect and does not wait on its resume", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const openThreadId = ThreadId.make("thread-open");
    const runningThreadId = ThreadId.make("thread-running");
    const topThreadId = ThreadId.make("thread-top");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      requestIdleThreadDetailPrewarm,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });
    mockCreateEnvironmentConnection.mock.calls[1]?.[0].syncShellSnapshot(
      makeShellSnapshot([
        { threadId: openThreadId },
        { threadId: runningThreadId, sessionStatus: "running" },
        { threadId: topThreadId },
      ]),
      environmentId,
    );
    const release = retainThreadDetailSubscription(environmentId, openThreadId);
    expect(subscribedThreadIds()).toEqual([runningThreadId, openThreadId]);
    deliverThreadSnapshot(runningThreadId);
    deliverThreadSnapshot(openThreadId);

    await disconnectSavedEnvironment(environmentId);
    mockSubscribeThread.mockClear();
    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(subscribedThreadIds()).toEqual([openThreadId, runningThreadId]);
    });
    expect(mockSubscribeThread.mock.calls[0]?.[0]).toEqual({
      threadId: openThreadId,
      fromSequenceExclusive: 1,
      acceptsPayloadRefs: true,
    });

    // The resume has nothing new to send; prewarming must not wait on it.
    // Only this computer's own threads prewarm; the remote one is skipped.
    const localEnvironmentId = EnvironmentId.make("env-1");
    const localThreadId = ThreadId.make("thread-local");
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([{ threadId: localThreadId }]),
      localEnvironmentId,
    );
    const cancelPrewarm = requestIdleThreadDetailPrewarm([
      scopeThreadRef(environmentId, topThreadId),
      scopeThreadRef(localEnvironmentId, localThreadId),
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([openThreadId, runningThreadId, localThreadId]);

    cancelPrewarm();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("frees the idle prewarm slot when its thread is removed or its request is cancelled", async () => {
    const {
      requestIdleThreadDetailPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const [firstId, secondId, thirdId] = ["thread-a", "thread-b", "thread-c"].map((id) =>
      ThreadId.make(id),
    ) as [ThreadId, ThreadId, ThreadId];

    const stop = startEnvironmentConnectionService(new QueryClient());
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(
      makeShellSnapshot([{ threadId: firstId }, { threadId: secondId }, { threadId: thirdId }]),
      environmentId,
    );

    const cancelTop = requestIdleThreadDetailPrewarm([
      scopeThreadRef(environmentId, firstId),
      scopeThreadRef(environmentId, secondId),
    ]);
    const cancelNext = requestIdleThreadDetailPrewarm([scopeThreadRef(environmentId, thirdId)]);
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([firstId]);

    // The first never answers, but it is removed: the queue moves on.
    connectionInput.applyShellEvent(
      { kind: "thread-removed", sequence: 2, threadId: firstId },
      environmentId,
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([firstId, secondId]);

    // The second never answers either; cancelling its request frees the slot
    // and closes the load, since nothing else wanted it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscribedThreadIds()).toEqual([firstId, secondId]);
    const unsubscribesBefore = mockThreadUnsubscribe.mock.calls.length;
    cancelTop();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(unsubscribesBefore + 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([firstId, secondId, thirdId]);

    cancelNext();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("moves the idle prewarm queue on when a load fails or never answers", async () => {
    const {
      requestIdleThreadDetailPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const [firstId, secondId, thirdId] = ["thread-a", "thread-b", "thread-c"].map((id) =>
      ThreadId.make(id),
    ) as [ThreadId, ThreadId, ThreadId];

    const stop = startEnvironmentConnectionService(new QueryClient());
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([{ threadId: firstId }, { threadId: secondId }, { threadId: thirdId }]),
      environmentId,
    );
    const cancelPrewarm = requestIdleThreadDetailPrewarm(
      [firstId, secondId, thirdId].map((threadId) => scopeThreadRef(environmentId, threadId)),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([firstId]);

    mockSubscribeThread.mock.calls[0]?.[2].onRetry(new Error("Thread was not found"), 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual([firstId, secondId]);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(subscribedThreadIds()).toEqual([firstId, secondId]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(subscribedThreadIds()).toEqual([firstId, secondId, thirdId]);

    cancelPrewarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("prewarms a row the pointer rests on, cancels it if the pointer leaves first, and keeps a loaded one a while", async () => {
    const {
      bindThreadRowIntentPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const threadId = ThreadId.make("thread-hovered");
    const row = createThreadRow(
      scopedThreadKey(scopeThreadRef(EnvironmentId.make("env-1"), threadId)),
    );
    const target = createPointerTarget();

    const stop = startEnvironmentConnectionService(new QueryClient());
    const unbind = bindThreadRowIntentPrewarm(target);

    // Passing over a row on the way somewhere else is not intent.
    target.dispatch("pointerover", row);
    await vi.advanceTimersByTimeAsync(50);
    target.dispatch("pointerout", row);
    await vi.advanceTimersByTimeAsync(500);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    // Resting is; leaving before the detail arrives cancels the load.
    target.dispatch("pointerover", row);
    await vi.advanceTimersByTimeAsync(100);
    expect(subscribedThreadIds()).toEqual([threadId]);
    target.dispatch("pointerout", row);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    // Once loaded, leaving keeps it 20s for the click that may follow; then
    // it idles out of the cache like any released thread (15 minutes later).
    target.dispatch("pointerover", row);
    await vi.advanceTimersByTimeAsync(100);
    deliverThreadSnapshot(threadId);
    target.dispatch("pointerout", row);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 19_000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(2);

    unbind();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("prewarms a row a finger lands on and cancels it when the touch becomes a scroll", async () => {
    const {
      bindThreadRowIntentPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const threadId = ThreadId.make("thread-touched");
    const row = createThreadRow(
      scopedThreadKey(scopeThreadRef(EnvironmentId.make("env-1"), threadId)),
    );
    const target = createPointerTarget();

    const stop = startEnvironmentConnectionService(new QueryClient());
    const unbind = bindThreadRowIntentPrewarm(target);

    // A flick turns into a scroll before it counts.
    target.dispatch("pointerdown", row, "touch");
    await vi.advanceTimersByTimeAsync(30);
    target.dispatch("pointercancel", row, "touch");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    // A finger that stays starts the load; a scroll taking over cancels it.
    target.dispatch("pointerdown", row, "touch");
    await vi.advanceTimersByTimeAsync(60);
    expect(subscribedThreadIds()).toEqual([threadId]);
    target.dispatch("pointercancel", row, "touch");
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    // A quick tap starts it as the finger lifts.
    target.dispatch("pointerdown", row, "touch");
    target.dispatch("pointerup", row, "touch");
    expect(subscribedThreadIds()).toEqual([threadId, threadId]);

    unbind();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("prewarms the first few jump-hint targets, two at a time", async () => {
    const {
      prewarmThreadJumpTargets,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const threadIds = [1, 2, 3, 4, 5, 6].map((index) => ThreadId.make(`thread-${index}`));

    const stop = startEnvironmentConnectionService(new QueryClient());
    const targets = threadIds.map((threadId) => scopeThreadRef(environmentId, threadId));

    // Hints that only flash (a slow Cmd+C) prewarm nothing.
    prewarmThreadJumpTargets(targets)();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    const release = prewarmThreadJumpTargets(targets);
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual(threadIds.slice(0, 2));
    deliverThreadSnapshot(threadIds[0]!);
    expect(subscribedThreadIds()).toEqual(threadIds.slice(0, 3));
    for (const threadId of threadIds.slice(1, 4)) deliverThreadSnapshot(threadId);
    expect(subscribedThreadIds()).toEqual(threadIds.slice(0, 4));

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not warm threads whose session is merely open", async () => {
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const environmentId = EnvironmentId.make("env-1");

    const stop = startEnvironmentConnectionService(new QueryClient());
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([
        { threadId: ThreadId.make("thread-ready"), sessionStatus: "ready" },
        { threadId: ThreadId.make("thread-interrupted"), sessionStatus: "interrupted" },
      ]),
      environmentId,
    );
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("tells the screen about the open chat's events at once and a background thread's in a batch", async () => {
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { BATCHED_NOTIFICATION_DELAY_MS } = await import("../../lib/batchedNotifications");
    const {
      resetEnvironmentServiceForTests,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("../../store");
    const environmentId = EnvironmentId.make("env-1");
    const openThreadId = ThreadId.make("thread-open");
    const backgroundThreadId = ThreadId.make("thread-background");

    const stop = startEnvironmentConnectionService(new QueryClient());
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([
        { threadId: openThreadId, sessionStatus: "running" },
        { threadId: backgroundThreadId, sessionStatus: "running" },
      ]),
      environmentId,
    );
    const release = retainThreadDetailSubscription(environmentId, openThreadId);
    deliverThreadSnapshot(openThreadId);
    deliverThreadSnapshot(backgroundThreadId);
    let notifications = 0;
    const unsubscribe = useStore.subscribe(() => {
      notifications += 1;
    });
    const deliverText = (threadId: ThreadId, sequence: number, text: string) =>
      mockSubscribeThread.mock.calls.findLast(([input]) => input.threadId === threadId)?.[1]({
        kind: "event",
        event: {
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-04-13T00:00:02.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId,
            messageId: `message-${threadId}`,
            role: "assistant",
            text,
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-13T00:00:02.000Z",
            updatedAt: "2026-04-13T00:00:02.000Z",
          },
        },
      });
    const textOf = (threadId: ThreadId) =>
      selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId))?.messages[0]
        ?.text;

    deliverText(backgroundThreadId, 2, "Working");
    deliverText(backgroundThreadId, 3, " on it");
    expect(textOf(backgroundThreadId)).toBe("Working on it");
    expect(notifications).toBe(0);
    vi.advanceTimersByTime(BATCHED_NOTIFICATION_DELAY_MS);
    expect(notifications).toBe(1);

    deliverText(openThreadId, 4, "Done");
    expect(textOf(openThreadId)).toBe("Done");
    expect(notifications).toBe(2);

    unsubscribe();
    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("lets held warm threads through when their own environment reconnects", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const launchThreadId = ThreadId.make("thread-launch");
    const runningThreadId = ThreadId.make("thread-running");
    const localRunningThreadId = ThreadId.make("thread-local-running");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: scopeThreadRef(environmentId, launchThreadId),
    });
    // This computer's own running thread waits for the remote launch chat.
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([{ threadId: localRunningThreadId, sessionStatus: "running" }]),
      EnvironmentId.make("env-1"),
    );
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });
    mockCreateEnvironmentConnection.mock.calls[1]?.[0].syncShellSnapshot(
      makeShellSnapshot([
        { threadId: launchThreadId },
        { threadId: runningThreadId, sessionStatus: "running" },
      ]),
      environmentId,
    );
    // A first connection is not a reconnect: nothing held went out with it.
    expect(subscribedThreadIds()).toEqual([launchThreadId]);

    await disconnectSavedEnvironment(environmentId);
    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(subscribedThreadIds()).toEqual([launchThreadId, launchThreadId, runningThreadId]);
    });

    // The local one waits on for the launch chat's detail.
    deliverThreadSnapshot(launchThreadId);
    expect(subscribedThreadIds()).toEqual([
      launchThreadId,
      launchThreadId,
      runningThreadId,
      localRunningThreadId,
    ]);

    stop();
    await resetEnvironmentServiceForTests();
  });
  it("keeps two intent loads in flight even when opening one evicts from a full cache", async () => {
    const {
      prewarmThreadJumpTargets,
      resetEnvironmentServiceForTests,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");

    const stop = startEnvironmentConnectionService(new QueryClient());
    for (let index = 0; index < 32; index += 1) {
      retainThreadDetailSubscription(environmentId, ThreadId.make(`thread-cached-${index}`))();
    }
    mockSubscribeThread.mockClear();
    const jumpIds = [1, 2, 3, 4].map((index) => ThreadId.make(`thread-jump-${index}`));
    const release = prewarmThreadJumpTargets(
      jumpIds.map((threadId) => scopeThreadRef(environmentId, threadId)),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(subscribedThreadIds()).toEqual(jumpIds.slice(0, 2));

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("closes a speculative load once every intent on it has ended", async () => {
    const {
      bindThreadRowIntentPrewarm,
      prewarmThreadJumpTargets,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-both"));
    const row = createThreadRow(scopedThreadKey(threadRef));
    const target = createPointerTarget();

    const stop = startEnvironmentConnectionService(new QueryClient());
    const unbind = bindThreadRowIntentPrewarm(target);
    target.dispatch("pointerover", row);
    await vi.advanceTimersByTimeAsync(100);
    const releaseJump = prewarmThreadJumpTargets([threadRef]);
    await vi.advanceTimersByTimeAsync(250);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    target.dispatch("pointerout", row);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    releaseJump();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    unbind();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("holds idle prewarm while the launch chat is still waiting for its environment", async () => {
    const {
      requestIdleThreadDetailPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const localEnvironmentId = EnvironmentId.make("env-1");
    const topThreadId = ThreadId.make("thread-top");

    // The launch chat lives on a computer that has not connected yet.
    const stop = startEnvironmentConnectionService(new QueryClient(), {
      foregroundThreadRef: scopeThreadRef(
        EnvironmentId.make("env-remote"),
        ThreadId.make("thread-launch"),
      ),
    });
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([{ threadId: topThreadId }]),
      localEnvironmentId,
    );
    const cancelPrewarm = requestIdleThreadDetailPrewarm([
      scopeThreadRef(localEnvironmentId, topThreadId),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    // A launch chat that never connects stops counting after a few seconds.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(subscribedThreadIds()).toEqual([topThreadId]);

    cancelPrewarm();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not prewarm idle threads from a primary environment reached over the network", async () => {
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "https://box.example.test/",
        wsBaseUrl: "wss://box.example.test/",
      },
      environmentId: EnvironmentId.make("env-1"),
    });
    const {
      requestIdleThreadDetailPrewarm,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const environmentId = EnvironmentId.make("env-1");
    const topThreadId = ThreadId.make("thread-top");

    const stop = startEnvironmentConnectionService(new QueryClient());
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshot([{ threadId: topThreadId }]),
      environmentId,
    );
    const cancelPrewarm = requestIdleThreadDetailPrewarm([
      scopeThreadRef(environmentId, topThreadId),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    cancelPrewarm();
    stop();
    await resetEnvironmentServiceForTests();
  });
});
