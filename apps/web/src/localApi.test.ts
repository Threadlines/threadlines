import {
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  EnvironmentId,
  type VcsStatusResult,
  type OrchestrationShellStreamItem,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type TerminalEvent,
  ThreadId,
} from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ContextMenuItem } from "@threadlines/contracts";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
const shellStreamListeners = new Set<(event: OrchestrationShellStreamItem) => void>();
const gitStatusListeners = new Set<(event: VcsStatusResult) => void>();

const rpcClientMock = {
  dispose: vi.fn(),
  terminal: {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((listener: (event: TerminalEvent) => void) =>
      registerListener(terminalEventListeners, listener),
    ),
  },
  realtime: {
    appendAudio: vi.fn(),
    subscribeAudio: vi.fn(
      (_input: unknown, _listener: unknown, _options?: unknown) => () => undefined,
    ),
  },
  dictation: {
    subscribeStatus: vi.fn((_listener: unknown, _options?: unknown) => () => undefined),
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
    removeModel: vi.fn(),
    warmUp: vi.fn(),
    transcribe: vi.fn(),
  },
  projects: {
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  attachments: {
    read: vi.fn(),
  },
  visualizations: {
    read: vi.fn(),
  },
  pages: {
    read: vi.fn(),
  },
  commandRuns: {
    start: vi.fn(),
    sendOutput: vi.fn(),
  },
  filesystem: {
    browse: vi.fn(),
  },
  usage: {
    summary: vi.fn(),
  },
  sourceControl: {
    lookupRepository: vi.fn(),
    listRepositories: vi.fn(),
    cloneRepository: vi.fn(),
    publishRepository: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
  },
  vcs: {
    pull: vi.fn(),
    refreshLocalStatus: vi.fn(),
    refreshStatus: vi.fn(),
    onStatus: vi.fn((input: { cwd: string }, listener: (event: VcsStatusResult) => void) =>
      registerListener(gitStatusListeners, listener),
    ),
    listRefs: vi.fn(),
    commitGraph: vi.fn(),
    workingTreeDiff: vi.fn(),
    discardChanges: vi.fn(),
    stageChanges: vi.fn(),
    unstageChanges: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createRef: vi.fn(),
    createTag: vi.fn(),
    deleteBranch: vi.fn(),
    switchRef: vi.fn(),
    mergeRef: vi.fn(),
    init: vi.fn(),
  },
  git: {
    runStackedAction: vi.fn(),
    generateCommitMessage: vi.fn(),
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
  },
  pullRequests: {
    list: vi.fn(),
    detail: vi.fn(),
    activity: vi.fn(),
    diff: vi.fn(),
    comment: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    refreshProviders: vi.fn(),
    consumeProviderRateLimitResetCredit: vi.fn(),
    updateProvider: vi.fn(),
    resolveProviderUpdateBlockers: vi.fn(),
    upsertKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    discoverSourceControl: vi.fn(),
    updateSourceControlTool: vi.fn(),
    subscribeConfig: vi.fn(),
    subscribeLifecycle: vi.fn(),
    subscribeAuthAccess: vi.fn(),
  },
  orchestration: {
    dispatchCommand: vi.fn(),
    getTurnDiff: vi.fn(),
    getFullThreadDiff: vi.fn(),
    subscribeShell: vi.fn((listener: (event: OrchestrationShellStreamItem) => void) =>
      registerListener(shellStreamListeners, listener),
    ),
    subscribeThread: vi.fn(() => () => undefined),
  },
};

vi.mock("./environments/runtime", () => ({
  readBackendEnvironmentConnection: () => ({
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Primary",
      source: "manual" as const,
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
      environmentId: EnvironmentId.make("environment-local"),
    },
    client: rpcClientMock,
    environmentId: EnvironmentId.make("environment-local"),
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
}));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  const bridge: DesktopBridge = {
    getAppBranding: () => null,
    getLocalEnvironmentBootstrap: () => null,
    getClientSettings: async () => null,
    setClientSettings: async () => undefined,
    getSavedEnvironmentRegistry: async () => [],
    setSavedEnvironmentRegistry: async () => undefined,
    getSavedEnvironmentSecret: async () => null,
    setSavedEnvironmentSecret: async () => true,
    removeSavedEnvironmentSecret: async () => undefined,
    discoverSshHosts: async () => [],
    ensureSshEnvironment: async () => {
      throw new Error("ensureSshEnvironment not implemented in test");
    },
    disconnectSshEnvironment: async () => undefined,
    fetchSshEnvironmentDescriptor: async () => {
      throw new Error("fetchSshEnvironmentDescriptor not implemented in test");
    },
    bootstrapSshBearerSession: async () => {
      throw new Error("bootstrapSshBearerSession not implemented in test");
    },
    fetchSshSessionState: async () => {
      throw new Error("fetchSshSessionState not implemented in test");
    },
    issueSshWebSocketToken: async () => {
      throw new Error("issueSshWebSocketToken not implemented in test");
    },
    onSshPasswordPrompt: () => () => undefined,
    resolveSshPasswordPrompt: async () => undefined,
    getServerExposureState: async () => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
    setServerExposureMode: async () => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
    setTailscaleServeEnabled: async (input) => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
      tailscaleServeEnabled: input.enabled,
      tailscaleServePort: input.port ?? 443,
    }),
    getAdvertisedEndpoints: async () => [],
    getRetiredPhoneLinkNotice: async () => false,
    dismissRetiredPhoneLinkNotice: async () => undefined,
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    setUpdateChannel: async () => {
      throw new Error("setUpdateChannel not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
  };
  return Object.assign(bridge, overrides);
}

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

const baseEnvironment = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

const baseServerConfig: ServerConfig = {
  environment: baseEnvironment,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: "threadlines_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  terminalEventListeners.clear();
  shellStreamListeners.clear();
  gitStatusListeners.clear();
  const testWindow = getWindowForTest();
  Reflect.deleteProperty(testWindow, "desktopBridge");
  Object.defineProperty(testWindow, "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsApi", () => {
  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards realtime audio stream completion handling", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");
    const api = createEnvironmentApi(rpcClientMock as never);
    const onAudio = vi.fn();
    const onComplete = vi.fn();

    (api.realtime.subscribeAudio as unknown as typeof rpcClientMock.realtime.subscribeAudio)(
      { threadId: ThreadId.make("thread-1") },
      onAudio,
      { onComplete },
    );

    expect(rpcClientMock.realtime.subscribeAudio).toHaveBeenCalledWith(
      { threadId: ThreadId.make("thread-1") },
      onAudio,
      { onComplete },
    );
  });

  it("forwards shell stream subscription options to the RPC client", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onShellEvent = vi.fn();
    const onResubscribe = vi.fn();

    api.orchestration.subscribeShell(onShellEvent, { onResubscribe });

    expect(rpcClientMock.orchestration.subscribeShell).toHaveBeenCalledWith(onShellEvent, {
      onResubscribe,
    });
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards targeted provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    const instanceId = ProviderInstanceId.make("codex");
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.refreshProviders({ instanceId })).resolves.toEqual({
      providers: nextProviders,
    });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith({ instanceId });
  });

  it("forwards context menu metadata to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    getWindowForTest().desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
  });

  it("forwards folder picker options to the desktop bridge", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    getWindowForTest().desktopBridge = makeDesktopBridge({ pickFolder });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await expect(api.dialogs.pickFolder({ initialPath: "/tmp/workspace" })).resolves.toBe(
      "/tmp/project",
    );
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp/workspace" });
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("reads and writes persistence through the desktop bridge when available", async () => {
    const clientSettings = {
      agentBrowserApprovedDomains: {},
      agentBrowserSitePolicy: "ask" as const,
      agentBrowserProjectSitePolicy: {},
      agentBrowserTrustedCertificates: {},
      autoOpenAgentsPanel: false,
      chatChangedFilesDefaultExpanded: false,
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      wrapUpThreadsOnPullRequestSettled: true,
      wrapUpChildThreadsOnFinish: true,
      wrapUpIdleThreads: true,
      dismissedProviderUpdateNotificationKeys: [],
      dictationHoldToRecord: true,
      dictationMicrophoneDeviceId: null,
      diffChangesOnly: false,
      diffIgnoreWhitespace: true,
      diffRenderMode: "stacked" as const,
      diffWordWrap: true,
      fileViewerWordWrap: false,
      followUpDelivery: "steer" as const,
      favorites: [],
      openLinksIn: "browser-panel" as const,
      providerModelPreferences: {},
      suppressCrossProviderSwitchWarning: false,
      sidebarGrouping: "none" as const,
      sidebarProjectGroupingMode: "repository_path" as const,
      sidebarProjectGroupingOverrides: {
        "environment-local:/tmp/project": "separate" as const,
      },
      sidebarProjectSortOrder: "manual" as const,
      sidebarThreadPreviewCount: 6,
      sourceControlPanelDefaultOpen: false,
      timestampFormat: "24-hour" as const,
    };
    const getClientSettings = vi.fn().mockResolvedValue({
      ...clientSettings,
    });
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    const getSavedEnvironmentRegistry = vi.fn().mockResolvedValue([]);
    const setSavedEnvironmentRegistry = vi.fn().mockResolvedValue(undefined);
    const getSavedEnvironmentSecret = vi.fn().mockResolvedValue("bearer-token");
    const setSavedEnvironmentSecret = vi.fn().mockResolvedValue(true);
    const removeSavedEnvironmentSecret = vi.fn().mockResolvedValue(undefined);
    getWindowForTest().desktopBridge = makeDesktopBridge({
      getClientSettings,
      setClientSettings,
      getSavedEnvironmentRegistry,
      setSavedEnvironmentRegistry,
      getSavedEnvironmentSecret,
      setSavedEnvironmentSecret,
      removeSavedEnvironmentSecret,
    });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await api.persistence.getClientSettings();
    await api.persistence.setClientSettings(clientSettings);
    await api.persistence.getSavedEnvironmentRegistry();
    await api.persistence.setSavedEnvironmentRegistry([]);
    await api.persistence.getSavedEnvironmentSecret(EnvironmentId.make("environment-local"));
    await api.persistence.setSavedEnvironmentSecret(
      EnvironmentId.make("environment-local"),
      "bearer-token",
    );
    await api.persistence.removeSavedEnvironmentSecret(EnvironmentId.make("environment-local"));

    expect(getClientSettings).toHaveBeenCalledWith();
    expect(setClientSettings).toHaveBeenCalledWith(clientSettings);
    expect(getSavedEnvironmentRegistry).toHaveBeenCalledWith();
    expect(setSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(getSavedEnvironmentSecret).toHaveBeenCalledWith("environment-local");
    expect(setSavedEnvironmentSecret).toHaveBeenCalledWith("environment-local", "bearer-token");
    expect(removeSavedEnvironmentSecret).toHaveBeenCalledWith("environment-local");
  });

  it("falls back to browser storage for persistence when the desktop bridge is missing", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);
    const clientSettings = {
      agentBrowserApprovedDomains: {},
      agentBrowserSitePolicy: "ask" as const,
      agentBrowserProjectSitePolicy: {},
      agentBrowserTrustedCertificates: {},
      autoOpenAgentsPanel: false,
      chatChangedFilesDefaultExpanded: false,
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      wrapUpThreadsOnPullRequestSettled: true,
      wrapUpChildThreadsOnFinish: true,
      wrapUpIdleThreads: true,
      dismissedProviderUpdateNotificationKeys: [],
      dictationHoldToRecord: true,
      dictationMicrophoneDeviceId: null,
      diffChangesOnly: false,
      diffIgnoreWhitespace: true,
      diffRenderMode: "stacked" as const,
      diffWordWrap: true,
      fileViewerWordWrap: false,
      followUpDelivery: "steer" as const,
      favorites: [],
      openLinksIn: "browser-panel" as const,
      providerModelPreferences: {},
      suppressCrossProviderSwitchWarning: false,
      sidebarGrouping: "none" as const,
      sidebarProjectGroupingMode: "repository_path" as const,
      sidebarProjectGroupingOverrides: {
        "environment-local:/tmp/project": "separate" as const,
      },
      sidebarProjectSortOrder: "manual" as const,
      sidebarThreadPreviewCount: 6,
      sourceControlPanelDefaultOpen: false,
      timestampFormat: "24-hour" as const,
    };

    await api.persistence.setClientSettings(clientSettings);
    await api.persistence.setSavedEnvironmentRegistry([
      {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Primary",
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);
    await api.persistence.setSavedEnvironmentSecret(
      EnvironmentId.make("environment-local"),
      "bearer-token",
    );

    await expect(api.persistence.getClientSettings()).resolves.toEqual(clientSettings);
    await expect(api.persistence.getSavedEnvironmentRegistry()).resolves.toEqual([
      {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Primary",
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);
    await expect(
      api.persistence.getSavedEnvironmentSecret(EnvironmentId.make("environment-local")),
    ).resolves.toBe("bearer-token");

    await api.persistence.removeSavedEnvironmentSecret(EnvironmentId.make("environment-local"));

    await expect(
      api.persistence.getSavedEnvironmentSecret(EnvironmentId.make("environment-local")),
    ).resolves.toBeNull();
  });
});
