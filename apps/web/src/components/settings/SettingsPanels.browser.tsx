import "../../index.css";

import {
  type AuthAccessStreamEvent,
  type AuthAccessSnapshot,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DesktopBridge,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type LocalApi,
  ProviderDriverKind,
  ProviderInstanceId,
  type RelayAccessSnapshot,
  type RelayHostJoinRequest,
  RelayDeviceId,
  RelayHostId,
  RelayInviteId,
  RelayRequestId,
  type ServerConfig,
  type ServerProcessResourceHistoryResult,
  type ServerProvider,
  type SourceControlDiscoveryResult,
  type SourceControlSetupState,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useState, type ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useUiStateStore } from "../../uiStateStore";
import {
  collectSourceControlToolUpdateNotices,
  sourceControlToolUpdateNoticeSetKey,
} from "../SourceControlToolUpdateLaunchNotification.logic";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { GeneralSettingsPanel, ProviderSettingsPanel } from "./SettingsPanels";
import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { ThreadsSettingsPanel } from "./ThreadsSettings";
import { resetSourceControlDiscoveryStateForTests } from "../../lib/sourceControlDiscoveryState";

/**
 * The app-wide providers these panels are always mounted under. Settings rows
 * read cached data (usage, updates), so a bare render would crash on the
 * missing query client rather than on anything the test is about.
 */
function TestAppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AppAtomRegistryProvider>{children}</AppAtomRegistryProvider>
    </QueryClientProvider>
  );
}

function renderWithTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => children,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

/**
 * Waits for the collapsible panel around `inside` to finish opening. The
 * element can have stable bounds while its panel is still revealing it, and a
 * pointer click sent then can miss.
 */
async function waitForPanelOpen(inside: Element | null) {
  const panel = inside?.closest('[data-slot="collapsible-panel"]');
  if (!panel) throw new Error("Expected the element inside a collapsible panel");
  await Promise.all(panel.getAnimations().map((animation) => animation.finished));
}

const authAccessHarness = vi.hoisted(() => {
  type Snapshot = AuthAccessSnapshot;
  let snapshot: Snapshot = {
    pairingLinks: [],
    clientSessions: [],
  };
  let revision = 1;
  let deferSnapshot = false;
  const listeners = new Set<(event: AuthAccessStreamEvent) => void>();

  const emitEvent = (event: AuthAccessStreamEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    reset() {
      snapshot = {
        pairingLinks: [],
        clientSessions: [],
      };
      revision = 1;
      deferSnapshot = false;
      listeners.clear();
    },
    setSnapshot(next: Snapshot) {
      snapshot = next;
    },
    /** Hold the first snapshot back, the way a slow or reconnecting stream does. */
    deferSnapshot() {
      deferSnapshot = true;
    },
    emitSnapshot() {
      emitEvent({
        version: 1 as const,
        revision,
        type: "snapshot" as const,
        payload: snapshot,
      });
      revision += 1;
    },
    emitEvent,
    emitPairingLinkUpserted(pairingLink: Snapshot["pairingLinks"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: pairingLink,
      });
      revision += 1;
    },
    emitPairingLinkRemoved(id: string) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id },
      });
      revision += 1;
    },
    emitClientUpserted(clientSession: Snapshot["clientSessions"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "clientUpserted",
        payload: clientSession,
      });
      revision += 1;
    },
    emitClientRemoved(sessionId: string) {
      emitEvent({
        version: 1,
        revision,
        type: "clientRemoved",
        payload: {
          sessionId: AuthSessionId.make(sessionId),
        },
      });
      revision += 1;
    },
    subscribe(listener: (event: AuthAccessStreamEvent) => void) {
      listeners.add(listener);
      if (!deferSnapshot) {
        listener({
          version: 1,
          revision: 1,
          type: "snapshot",
          payload: snapshot,
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const providerAuthHarness = vi.hoisted(() => {
  type AuthEvent = {
    readonly instanceId: string;
    readonly createdAt: string;
  } & (
    | { readonly type: "command"; readonly flow: string; readonly command: string }
    | { readonly type: "output"; readonly data: string }
    | {
        readonly type: "status";
        readonly status: string;
        readonly exitCode: number | null;
        readonly detail: string | null;
      }
  );

  // Like the real service, events are delivered only to subscribers of the
  // matching instance — every mounted panel subscribes, so a broadcast would
  // render the same output in all of them.
  const listeners = new Set<{
    readonly instanceId: string;
    readonly listener: (event: AuthEvent) => void;
  }>();
  const startCalls: Array<{ instanceId: string; flow: string }> = [];

  return {
    startCalls,
    reset() {
      listeners.clear();
      startCalls.length = 0;
    },
    emit(event: AuthEvent) {
      for (const entry of listeners) {
        if (entry.instanceId === event.instanceId) {
          entry.listener(event);
        }
      }
    },
    client: {
      start: (input: { instanceId: string; flow: string }) => {
        startCalls.push({ instanceId: input.instanceId, flow: input.flow });
        return Promise.resolve();
      },
      write: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscribe: (input: { instanceId: string }, listener: (event: AuthEvent) => void) => {
        const entry = { instanceId: input.instanceId, listener };
        listeners.add(entry);
        return () => {
          listeners.delete(entry);
        };
      },
    },
  };
});

const mockConnectDesktopSshEnvironment = vi.hoisted(() => vi.fn());

const relayAccessHarness = vi.hoisted(() => {
  let snapshot: RelayAccessSnapshot | null = null;
  const listeners = new Set<(snapshot: RelayAccessSnapshot) => void>();
  const client = {
    subscribeAccess: (listener: (snapshot: RelayAccessSnapshot) => void) => {
      listeners.add(listener);
      if (snapshot) listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    createInvite: vi.fn(),
    cancelInvite: vi.fn(),
    respondToJoinRequest: vi.fn(),
    submitJoin: vi.fn(),
  };
  return {
    client,
    reset() {
      snapshot = null;
      listeners.clear();
      client.createInvite.mockReset();
      client.cancelInvite.mockReset().mockResolvedValue(undefined);
      client.respondToJoinRequest.mockReset();
      client.submitJoin.mockReset();
    },
    emit(next: RelayAccessSnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
});

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        subscribeAuthAccess: (listener: Parameters<typeof authAccessHarness.subscribe>[0]) =>
          authAccessHarness.subscribe(listener),
      },
      providerAuth: providerAuthHarness.client,
      relay: relayAccessHarness.client,
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    environmentRequiresRpcAssetTransport: () => false,
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: () => undefined,
    resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    cancelPendingRelayJoin: vi.fn(),
    canJoinWithCode: () => true,
    connectDesktopSshEnvironment: mockConnectDesktopSshEnvironment,
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readBackendEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    RelayJoinError: class RelayJoinError extends Error {
      readonly code: string | null;
      constructor(message: string, code: string | null) {
        super(message);
        this.code = code;
      }
    },
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: () => undefined,
    startCodeJoin: vi.fn(),
    startEnvironmentConnectionService: () => undefined,
    subscribeEnvironmentConnections: () => () => {},
    useRelayJoinStore: Object.assign(
      (selector: (state: { byEnvironmentId: Record<string, never> }) => unknown) =>
        selector({ byEnvironmentId: {} }),
      { getState: () => ({ dismiss: () => undefined }) },
    ),
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "threadlines_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.threadlines/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.threadlines/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function createOutdatedProvider(
  driver: string,
  updateCommand = "npm install -g openai/codex@latest",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-04T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      message: "Update available.",
      checkedAt: "2026-05-04T10:00:00.000Z",
      updateCommand,
      canUpdate: true,
      installCommand: null,
      canInstall: false,
    },
  };
}

function createVerifiedNativeOutdatedClaudeProvider(): ServerProvider {
  const nativeUpdaterCommand =
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand <verified-native-claude-updater>";
  return {
    ...createOutdatedProvider("claudeAgent", nativeUpdaterCommand),
    displayName: "Claude",
    version: "2.1.183",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "2.1.183",
      latestVersion: "2.1.185",
      message:
        "Threadlines will run a checksum-verified Windows native Claude updater because `claude update` and Anthropic's installer can report success without replacing the active binary.",
      checkedAt: "2026-05-04T10:00:00.000Z",
      updateCommand: nativeUpdaterCommand,
      canUpdate: true,
      installCommand: null,
      canInstall: false,
    },
  };
}

function createClaudeUpdateLockFailedProvider(): ServerProvider {
  return {
    ...createVerifiedNativeOutdatedClaudeProvider(),
    updateState: {
      status: "failed",
      startedAt: "2026-05-04T10:01:00.000Z",
      finishedAt: "2026-05-04T10:01:01.000Z",
      message:
        "Claude is still running, so Windows cannot replace its executable. Stop Claude processes, close other Claude windows, or end terminal Claude sessions and try again.",
      output:
        '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Move-Item : Cannot create a file when that file already exists.</S></Objs>',
    },
  };
}

function createClaudeProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.175",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-04T10:00:00.000Z",
    models: [
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function createClaudeProviderWithTokenHistory(): ServerProvider {
  const checkedAt = new Date().toISOString();
  return {
    ...createClaudeProvider(),
    checkedAt,
    accountUsage: {
      source: "claude-oauth-usage",
      checkedAt,
      limits: [],
      tokenUsage: {
        checkedAt,
        scope: "local",
        coverageStartDate: utcDateKeyAtOffset(-365),
        coverageEndDate: utcDateKeyAtOffset(0),
        completeLifetimeHistory: false,
        dailyBuckets: [
          { startDate: utcDateKeyAtOffset(-40), tokens: 1000 },
          { startDate: utcDateKeyAtOffset(-38), tokens: 3000 },
        ],
        summary: { lifetimeTokens: 4000, peakDailyTokens: 3000 },
      },
    },
  };
}

const CLAUDE_INSTALL_GUIDE_MESSAGE =
  "Claude Agent CLI (`claude`) is not installed or not on PATH. Install Claude Code from https://claude.com/product/claude-code and run `claude` to sign in.";

/**
 * A Claude whose CLI is missing. `canInstall` is what the server sets when it
 * found npm and could run the install itself; without it the card has nothing
 * to offer but the guide.
 */
function createMissingClaudeProvider(options?: {
  readonly canInstall?: boolean;
  readonly updateState?: ServerProvider["updateState"];
}): ServerProvider {
  return {
    ...createClaudeProvider(),
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    message: CLAUDE_INSTALL_GUIDE_MESSAGE,
    models: [],
    versionAdvisory: {
      status: "unknown",
      currentVersion: null,
      latestVersion: null,
      updateCommand: null,
      canUpdate: false,
      installCommand:
        options?.canInstall === true ? "npm install -g @anthropic-ai/claude-code@latest" : null,
      canInstall: options?.canInstall === true,
      checkedAt: null,
      message: null,
    },
    ...(options?.updateState ? { updateState: options.updateState } : {}),
  };
}

function createCodexProviderWithResetCredits(): ServerProvider {
  const nowMs = Date.now();
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.144.3",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(nowMs).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    accountUsage: {
      source: "codex-rate-limits",
      checkedAt: new Date(nowMs).toISOString(),
      rateLimitResetCredits: {
        availableCount: 4,
        credits: [
          {
            id: "reset-settings-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: Math.floor(nowMs / 1000),
            expiresAt: Math.floor((nowMs + 86_400_000) / 1000),
            title: "Full reset",
          },
          {
            id: "reset-settings-2",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: Math.floor(nowMs / 1000),
            expiresAt: Math.floor((nowMs + 4 * 86_400_000) / 1000),
            title: "Full reset",
          },
          {
            id: "reset-settings-3",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: Math.floor(nowMs / 1000),
            expiresAt: Math.floor((nowMs + 30 * 86_400_000) / 1000),
            title: "Full reset",
          },
        ],
      },
      limits: [],
    },
  };
}

function utcDateKeyAtOffset(dayOffset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset))
    .toISOString()
    .slice(0, 10);
}

function formatTokenActivityTestDate(dateKey: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

function createCodexProviderWithTokenHistory(): ServerProvider {
  const checkedAt = new Date().toISOString();
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.147.0",
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    accountUsage: {
      source: "codex-rate-limits",
      checkedAt,
      limits: [],
      tokenUsage: {
        checkedAt,
        dailyBuckets: [
          { startDate: utcDateKeyAtOffset(-40), tokens: 1_000 },
          { startDate: utcDateKeyAtOffset(-38), tokens: 3_000 },
        ],
        summary: { lifetimeTokens: 4_000 },
      },
    },
  };
}

function makeUtc(value: string) {
  return DateTime.makeUnsafe(value);
}

function createEmptyProcessResourceHistoryResult(): ServerProcessResourceHistoryResult {
  return {
    readAt: makeUtc("2036-04-07T00:00:00.000Z"),
    windowMs: 15 * 60_000,
    bucketMs: 60_000,
    sampleIntervalMs: 5_000,
    retainedSampleCount: 0,
    totalCpuSecondsApprox: 0,
    buckets: [],
    topProcesses: [],
    error: Option.none(),
  };
}

function makePairingLink(input: {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}): AuthAccessSnapshot["pairingLinks"][number] {
  return {
    ...input,
    createdAt: makeUtc(input.createdAt),
    expiresAt: makeUtc(input.expiresAt),
  };
}

function makeClientSession(input: {
  readonly sessionId: string;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: AuthAccessSnapshot["clientSessions"][number]["method"];
  readonly client?: {
    readonly label?: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
    readonly deviceType?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    readonly os?: string;
    readonly browser?: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt?: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}): AuthAccessSnapshot["clientSessions"][number] {
  return {
    ...input,
    client: {
      deviceType: "unknown",
      ...input.client,
    },
    sessionId: AuthSessionId.make(input.sessionId),
    issuedAt: makeUtc(input.issuedAt),
    expiresAt: makeUtc(input.expiresAt),
    lastConnectedAt:
      input.lastConnectedAt === undefined || input.lastConnectedAt === null
        ? null
        : makeUtc(input.lastConnectedAt),
  };
}

function makeRelayInvite() {
  return {
    inviteId: RelayInviteId.make("invite-1"),
    hostId: RelayHostId.make("host-1"),
    relayOrigin: "https://relay.threadlines.dev",
    code: "482913",
    inviteSecret: "invite-secret",
    hostPublicKey: "host-public-key",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function makeRelayJoinRequest(
  state: RelayHostJoinRequest["state"],
  options: { readonly matchNumber?: string } = { matchNumber: "4721" },
): RelayHostJoinRequest {
  return {
    requestId: RelayRequestId.make("request-1"),
    inviteId: RelayInviteId.make("invite-1"),
    deviceId: RelayDeviceId.make("device-1"),
    joiner: { label: "Will's Desktop", platform: "Windows", kind: "computer" },
    ...(options.matchNumber ? { matchNumber: options.matchNumber } : {}),
    autoApprove: false,
    state,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

function makeRelayAccessSnapshot(
  requests: ReadonlyArray<RelayHostJoinRequest> = [],
): RelayAccessSnapshot {
  return {
    status: "online",
    hostLabel: "Local environment",
    invite: null,
    requests,
    usage: null,
  };
}

const createDesktopBridgeStub = (overrides?: {
  readonly discoverSshHosts?: DesktopBridge["discoverSshHosts"];
  readonly serverExposureState?: Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>;
  readonly advertisedEndpoints?: Awaited<ReturnType<DesktopBridge["getAdvertisedEndpoints"]>>;
  readonly setServerExposureMode?: DesktopBridge["setServerExposureMode"];
  readonly getRetiredPhoneLinkNotice?: DesktopBridge["getRetiredPhoneLinkNotice"];
  readonly dismissRetiredPhoneLinkNotice?: DesktopBridge["dismissRetiredPhoneLinkNotice"];
  readonly openExternal?: DesktopBridge["openExternal"];
  readonly setUpdateChannel?: DesktopBridge["setUpdateChannel"];
}): DesktopBridge => {
  const idleUpdateState: DesktopUpdateState = {
    enabled: false,
    status: "idle",
    channel: "latest",
    currentVersion: "0.0.0-test",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  return {
    getAppBranding: vi.fn().mockReturnValue(null),
    getLocalEnvironmentBootstrap: () => ({
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "desktop-bootstrap-token",
    }),
    getClientSettings: vi.fn().mockResolvedValue(null),
    setClientSettings: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
    setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
    setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
    removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    discoverSshHosts: overrides?.discoverSshHosts ?? vi.fn().mockResolvedValue([]),
    ensureSshEnvironment: vi.fn().mockImplementation(async (target) => ({
      target,
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: "ssh-pairing-token",
    })),
    disconnectSshEnvironment: vi.fn().mockResolvedValue(undefined),
    fetchSshEnvironmentDescriptor: vi.fn().mockResolvedValue({
      environmentId: "environment-ssh",
      label: "SSH environment",
      platform: {
        os: "linux",
        arch: "x64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
      },
    }),
    bootstrapSshBearerSession: vi.fn().mockResolvedValue({
      authenticated: true,
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2026-05-01T12:00:00.000Z",
      sessionToken: "ssh-bearer-token",
    }),
    fetchSshSessionState: vi.fn().mockResolvedValue({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "threadlines_session",
      },
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2026-05-01T12:00:00.000Z",
    }),
    issueSshWebSocketToken: vi.fn().mockResolvedValue({
      token: "ssh-ws-token",
      expiresAt: "2026-05-01T12:05:00.000Z",
    }),
    onSshPasswordPrompt: vi.fn(() => () => {}),
    resolveSshPasswordPrompt: vi.fn().mockResolvedValue(undefined),
    getServerExposureState: vi.fn().mockResolvedValue(
      overrides?.serverExposureState ?? {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    ),
    setServerExposureMode:
      overrides?.setServerExposureMode ??
      vi.fn().mockImplementation(async (mode) => ({
        mode,
        endpointUrl: mode === "network-accessible" ? "http://192.168.1.44:3773" : null,
        advertisedHost: mode === "network-accessible" ? "192.168.1.44" : null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })),
    setTailscaleServeEnabled: vi.fn().mockImplementation(async (input) => ({
      mode: overrides?.serverExposureState?.mode ?? "network-accessible",
      endpointUrl: overrides?.serverExposureState?.endpointUrl ?? "http://192.168.1.44:3773",
      advertisedHost: overrides?.serverExposureState?.advertisedHost ?? "192.168.1.44",
      tailscaleServeEnabled: input.enabled,
      tailscaleServePort: input.port ?? 443,
    })),
    getAdvertisedEndpoints: vi.fn().mockResolvedValue(overrides?.advertisedEndpoints ?? []),
    getRetiredPhoneLinkNotice:
      overrides?.getRetiredPhoneLinkNotice ?? vi.fn().mockResolvedValue(false),
    dismissRetiredPhoneLinkNotice:
      overrides?.dismissRetiredPhoneLinkNotice ?? vi.fn().mockResolvedValue(undefined),
    pickFolder: vi.fn().mockResolvedValue(null),
    confirm: vi.fn().mockResolvedValue(false),
    setTheme: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
    openExternal: overrides?.openExternal ?? vi.fn().mockResolvedValue(true),
    onMenuAction: () => () => {},
    getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
    setUpdateChannel:
      overrides?.setUpdateChannel ??
      vi.fn().mockImplementation(async (channel: DesktopUpdateChannel) => ({
        ...idleUpdateState,
        channel,
      })),
    checkForUpdate: vi.fn().mockResolvedValue({ checked: false, state: idleUpdateState }),
    downloadUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    installUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    onUpdateState: () => () => {},
  };
};

describe("GeneralSettingsPanel observability", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    localStorage.clear();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
    authAccessHarness.reset();
    providerAuthHarness.reset();
    relayAccessHarness.reset();
    mockConnectDesktopSshEnvironment.mockReset();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopBridge");
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
    authAccessHarness.reset();
  });

  it("lets a browser-served owner connect devices without listing its own tab", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [
        makeClientSession({
          sessionId: "session-owner",
          subject: "browser-owner",
          role: "owner",
          method: "browser-session-cookie",
          client: {
            label: "Chrome on Mac",
            deviceType: "desktop",
            os: "macOS",
            browser: "Chrome",
            ipAddress: "127.0.0.1",
          },
          issuedAt: "2036-04-07T00:00:00.000Z",
          expiresAt: "2036-05-07T00:00:00.000Z",
          connected: true,
          current: true,
        }),
      ],
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "owner",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByRole("button", { name: "Connect a device", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Mac")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "Only devices using a code can reach this computer. To allow same-network connections, restart Threadlines with network access on.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("switch", { name: "Same network" }))
      .not.toBeInTheDocument();
  });

  it("shows a code for a new device and allows it once the numbers match", async () => {
    window.desktopBridge = createDesktopBridgeStub();
    relayAccessHarness.client.createInvite.mockResolvedValue(makeRelayInvite());
    relayAccessHarness.client.respondToJoinRequest.mockResolvedValue({
      requestId: RelayRequestId.make("request-1"),
      state: "approved",
    });
    relayAccessHarness.emit(makeRelayAccessSnapshot());
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Connect a device", exact: true }).click();
    await expect.element(page.getByText("482 913", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Scan with your camera.")).toBeInTheDocument();

    // No Allow until the server has checked the joiner's half of the number.
    relayAccessHarness.emit(makeRelayAccessSnapshot([makeRelayJoinRequest("pending", {})]));
    await expect
      .element(page.getByText("Will's Desktop typed your code. Getting the number to compare."))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Allow", exact: true }))
      .not.toBeInTheDocument();

    relayAccessHarness.emit(makeRelayAccessSnapshot([makeRelayJoinRequest("pending")]));
    await expect
      .element(page.getByRole("heading", { name: "Allow Will's Desktop?", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("4721", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await vi.waitFor(() => {
      expect(relayAccessHarness.client.respondToJoinRequest).toHaveBeenCalledWith({
        requestId: "request-1",
        allow: true,
      });
    });

    relayAccessHarness.emit(makeRelayAccessSnapshot([makeRelayJoinRequest("approved")]));
    await expect
      .element(page.getByText("Will's Desktop can now use this computer."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    // A used code has nothing left to cancel.
    expect(relayAccessHarness.client.cancelInvite).not.toHaveBeenCalled();
  });

  it("cancels an unused code when the connect dialog closes", async () => {
    window.desktopBridge = createDesktopBridgeStub();
    relayAccessHarness.client.createInvite.mockResolvedValue(makeRelayInvite());
    relayAccessHarness.emit(makeRelayAccessSnapshot());
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Connect a device", exact: true }).click();
    await expect.element(page.getByText("482 913", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await vi.waitFor(() => {
      expect(relayAccessHarness.client.cancelInvite).toHaveBeenCalledWith({
        inviteId: "invite-1",
      });
    });
  });

  it("tells desktop users once that old phone links were replaced", async () => {
    const dismissRetiredPhoneLinkNotice = vi.fn().mockResolvedValue(undefined);
    window.desktopBridge = createDesktopBridgeStub({
      getRetiredPhoneLinkNotice: vi.fn().mockResolvedValue(true),
      dismissRetiredPhoneLinkNotice,
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await expect.element(page.getByText("Connect your phone again")).toBeInTheDocument();
    await page.getByRole("button", { name: "Got it", exact: true }).click();
    await expect.element(page.getByText("Connect your phone again")).not.toBeInTheDocument();
    expect(dismissRetiredPhoneLinkNotice).toHaveBeenCalledTimes(1);
  });

  it("hides advertised endpoint rows when desktop network access is disabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "loopback",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
        {
          id: "tailscale-ip",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.105.39.17:3773/",
          wsBaseUrl: "ws://100.105.39.17:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: "Same network" }))
      .toHaveAttribute("aria-checked", "false");
    await expect
      .element(page.getByRole("heading", { name: "This machine", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Tailscale IP", exact: true }))
      .not.toBeInTheDocument();
  });

  it("collapses advertised endpoints behind the network access summary", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.86.39:3773",
        advertisedHost: "192.168.86.39",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "desktop-loopback:3773",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
        },
        {
          id: "desktop-lan:http://192.168.86.39:3773",
          label: "Local network",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://192.168.86.39:3773/",
          wsBaseUrl: "ws://192.168.86.39:3773/",
          reachability: "lan",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
        {
          id: "tailscale-ip:http://100.105.39.17:3773",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.105.39.17:3773/",
          wsBaseUrl: "ws://100.105.39.17:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect.element(page.getByText("http://192.168.86.39:3773/")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "+2" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "+2" }).click();

    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Default", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Set as default" }).first().click();
    await expect.element(page.getByText("http://127.0.0.1:3773/").first()).toBeInTheDocument();
  });

  it("shows diagnostics inside About with a diagnostics link", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <GeneralSettingsPanel />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByRole("heading", { name: "Privacy & about", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Diagnostics", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "View diagnostics" })).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("shows the paired computer's writing model on the phone's Threads page", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ThreadsSettingsPanel surface="phone" />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByRole("heading", { name: "Writing model", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Backup writing model", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Applies to your paired computer.").first())
      .toBeInTheDocument();
  });

  it("keeps the phone's General page to this computer and the browser's own settings", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <GeneralSettingsPanel surface="phone" />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByRole("heading", { name: "This computer", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Writing model", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "View diagnostics" }))
      .not.toBeInTheDocument();
  });

  it("persists the usage analytics opt-out from About", async () => {
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue({ ...DEFAULT_SERVER_SETTINGS, usageAnalyticsEnabled: false });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateSettings,
      },
    } as unknown as LocalApi;
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <GeneralSettingsPanel />
      </TestAppProviders>,
    );

    const analyticsSwitch = page.getByRole("switch", {
      name: "Share anonymous usage analytics",
    });

    await expect.element(analyticsSwitch).toHaveAttribute("aria-checked", "true");
    await analyticsSwitch.click();
    await expect.element(analyticsSwitch).toHaveAttribute("aria-checked", "false");
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ usageAnalyticsEnabled: false });
    });
  });

  it("creates and shows a pairing link when network access is enabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    let pairingLinks: Array<AuthAccessSnapshot["pairingLinks"][number]> = [];
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
        issuedAt: "2036-04-07T00:00:00.000Z",
        expiresAt: "2036-05-07T00:00:00.000Z",
        connected: true,
        current: true,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks,
      clientSessions,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/auth/pairing-token") && method === "POST") {
          pairingLinks = [
            makePairingLink({
              id: "pairing-link-1",
              credential: "pairing-token",
              role: "client",
              subject: "one-time-token",
              label: "Julius iPhone",
              createdAt: "2036-04-07T00:00:00.000Z",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
          ];
          clientSessions = [
            ...clientSessions,
            makeClientSession({
              sessionId: "session-client",
              subject: "one-time-token",
              role: "client",
              method: "browser-session-cookie",
              client: {
                label: "Julius iPhone",
                deviceType: "mobile",
                os: "iOS",
                browser: "Safari",
                ipAddress: "192.168.1.88",
              },
              issuedAt: "2036-04-07T00:01:00.000Z",
              expiresAt: "2036-05-07T00:01:00.000Z",
              connected: false,
              current: false,
            }),
          ];
          authAccessHarness.setSnapshot({
            pairingLinks,
            clientSessions,
          });
          return new Response(
            JSON.stringify({
              id: "pairing-link-1",
              credential: "pairing-token",
              label: "Julius iPhone",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unhandled fetch ${method} ${url}`);
      }),
    );

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByText("Devices using this computer", { exact: true }))
      .toBeInTheDocument();
    // The desktop window's own sign-in is this computer, not a device using it.
    await expect.element(page.getByText("This Mac")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await page.getByRole("button", { name: "Make a link", exact: true }).click();
    await page.getByPlaceholder("e.g. Work laptop").fill("Julius iPhone");
    await page.getByRole("button", { name: "Make link", exact: true }).click();
    authAccessHarness.emitPairingLinkUpserted(pairingLinks[0]!);
    authAccessHarness.emitClientUpserted(clientSessions[1]!);
    await expect
      .element(page.getByText("Phone · Same network · iOS · Safari · Not connected yet"))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Copy link for:/ })).toBeInTheDocument();
  });

  it("removes every other device from settings after confirming", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
        issuedAt: "2036-04-05T00:00:00.000Z",
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: true,
        current: true,
      }),
      makeClientSession({
        sessionId: "session-client",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
        issuedAt: "2036-04-05T00:01:00.000Z",
        expiresAt: "2036-05-05T00:01:00.000Z",
        connected: false,
        current: false,
      }),
      makeClientSession({
        sessionId: "session-relay-device",
        subject: "relay-device",
        role: "client",
        method: "bearer-session-token",
        client: {
          label: "Will's Desktop",
          deviceType: "desktop",
          os: "Windows",
        },
        issuedAt: "2036-04-05T00:02:00.000Z",
        expiresAt: "2036-07-04T00:02:00.000Z",
        connected: true,
        current: false,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions,
    });

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/clients/revoke-others") && method === "POST") {
        clientSessions = clientSessions.filter((session) => session.current);
        authAccessHarness.setSnapshot({
          pairingLinks: [],
          clientSessions,
        });
        authAccessHarness.emitClientRemoved("session-client");
        authAccessHarness.emitClientRemoved("session-relay-device");
        return new Response(JSON.stringify({ revokedCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await expect.element(page.getByText("Julius iPhone")).toBeInTheDocument();
    // Code-joined devices show what they are, not the browser they joined from.
    await expect
      .element(page.getByText("Computer · Windows · Connected now", { exact: true }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Remove all", exact: true }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect
      .element(
        confirmDialog.getByText(
          "2 devices will lose access to this computer and need to connect again.",
        ),
      )
      .toBeInTheDocument();
    await confirmDialog.getByRole("button", { name: "Remove all", exact: true }).click();
    await expect.element(page.getByText("Julius iPhone")).not.toBeInTheDocument();
    await expect.element(page.getByText("Will's Desktop")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  // An audit read the pre-snapshot section as "nothing paired" because it was
  // rendered completely empty, and offered to remove devices it hadn't loaded.
  it("shows a device-row skeleton until the access snapshot lands", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    const clientSessions = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: { label: "This Mac", deviceType: "desktop", os: "macOS", browser: "Electron" },
        issuedAt: "2036-04-05T00:00:00.000Z",
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: true,
        current: true,
      }),
      makeClientSession({
        sessionId: "session-client",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
        issuedAt: "2036-04-05T00:01:00.000Z",
        expiresAt: "2036-05-05T00:01:00.000Z",
        connected: true,
        current: false,
      }),
      makeClientSession({
        sessionId: "session-tablet",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: { label: "Julius iPad", deviceType: "tablet", os: "iPadOS", browser: "Safari" },
        issuedAt: "2036-04-05T00:02:00.000Z",
        expiresAt: "2036-05-05T00:02:00.000Z",
        connected: false,
        current: false,
      }),
    ];
    authAccessHarness.setSnapshot({ pairingLinks: [], clientSessions });
    authAccessHarness.deferSnapshot();

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await expect.element(page.getByTestId("connected-devices-skeleton")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove all", exact: true }))
      .not.toBeInTheDocument();

    authAccessHarness.emitSnapshot();

    await expect.element(page.getByText("Julius iPhone")).toBeInTheDocument();
    await expect.element(page.getByTestId("connected-devices-skeleton")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove all", exact: true }))
      .not.toBeDisabled();
  });

  it("turns on same-network access from connection options after a restart warning", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Show", exact: true }).click();
    const networkAccessToggle = page.getByRole("switch", { name: "Same network" });
    await expect.element(networkAccessToggle).not.toBeDisabled();
    await networkAccessToggle.click();
    await expect
      .element(page.getByText("Let devices on this network connect?"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Threadlines will restart so devices on your network can reach this computer directly.",
        ),
      )
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and allow", exact: true }).click();
    await vi.waitFor(() => {
      expect(desktopBridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    });
    await expect.element(page.getByText("http://192.168.1.44:3773")).toBeInTheDocument();
  });

  it("adds desktop ssh environments from the connect-to-a-computer dialog", async () => {
    const discoverSshHosts = vi.fn().mockResolvedValue([
      {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
        source: "ssh-config" as const,
      },
    ]);
    window.desktopBridge = createDesktopBridgeStub({
      discoverSshHosts,
    });
    mockConnectDesktopSshEnvironment.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-devbox"),
      label: "Build box",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      httpBaseUrl: "http://127.0.0.1:3774/",
      createdAt: "2036-04-07T00:00:00.000Z",
      lastConnectedAt: "2036-04-07T00:00:00.000Z",
      desktopSsh: {
        alias: "devbox.example.com",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      },
    });

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Connect to a computer", exact: true }).click();
    const addEnvironmentDialog = page.getByRole("dialog", { name: "Connect to a computer" });
    await addEnvironmentDialog.getByRole("button", { name: /^Other ways to connect/ }).click();
    await addEnvironmentDialog.getByRole("button", { name: /^SSH/ }).click();
    await vi.waitFor(() => {
      expect(discoverSshHosts).toHaveBeenCalledTimes(1);
    });
    await expect
      .element(page.getByRole("heading", { name: "devbox", exact: true }))
      .toBeInTheDocument();

    await addEnvironmentDialog
      .getByLabelText("Computer name or SSH host")
      .fill("devbox.example.com");
    await addEnvironmentDialog.getByLabelText("User name").fill("julius");
    await addEnvironmentDialog.getByLabelText("Port").fill("2222");
    await addEnvironmentDialog
      .getByRole("button", { name: "Add this computer", exact: true })
      .click();

    await vi.waitFor(() => {
      expect(mockConnectDesktopSshEnvironment).toHaveBeenCalledWith(
        {
          alias: "devbox.example.com",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        { label: "" },
      );
    });
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: {
        openInEditor,
      },
      server: {
        getProcessDiagnostics: vi.fn().mockResolvedValue({
          serverPid: 1234,
          readAt: makeUtc("2036-04-07T00:00:00.000Z"),
          processCount: 0,
          totalRssBytes: 0,
          totalCpuPercent: 0,
          processes: [],
          error: Option.none(),
        }),
        getProcessResourceHistory: vi
          .fn()
          .mockResolvedValue(createEmptyProcessResourceHistoryResult()),
        getTraceDiagnostics: vi.fn().mockResolvedValue({
          traceFilePath: "/repo/project/.threadlines/traces.jsonl",
          scannedFilePaths: ["/repo/project/.threadlines/traces.jsonl"],
          readAt: makeUtc("2036-04-07T00:00:00.000Z"),
          recordCount: 0,
          parseErrorCount: 0,
          firstSpanAt: Option.none(),
          lastSpanAt: Option.none(),
          failureCount: 0,
          interruptionCount: 0,
          slowSpanThresholdMs: 5_000,
          slowSpanCount: 0,
          logLevelCounts: {},
          topSpansByCount: [],
          slowestSpans: [],
          commonFailures: [],
          latestFailures: [],
          latestWarningAndErrorLogs: [],
          partialFailure: Option.none(),
          error: Option.none(),
        }),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <DiagnosticsSettingsPanel />
      </TestAppProviders>,
    );

    const openLogsButton = page.getByLabelText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.threadlines/logs", "cursor");
  });

  it("uses native-layout skeletons while diagnostics are initially loading", async () => {
    const pendingDiagnostics = new Promise<never>(() => {});
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        getProcessDiagnostics: vi.fn().mockReturnValue(pendingDiagnostics),
        getProcessResourceHistory: vi.fn().mockReturnValue(pendingDiagnostics),
        getTraceDiagnostics: vi.fn().mockReturnValue(pendingDiagnostics),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <DiagnosticsSettingsPanel />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByText("Loading diagnostics", { exact: true }))
      .toBeInTheDocument();
    expect(await page.getByTestId("diagnostics-loading-skeleton").all()).toHaveLength(10);
    await expect.element(page.getByText("Loading live processes...")).not.toBeInTheDocument();
  });

  it("shows Claude configuration fields in provider settings", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Claude details").click();
    await page.getByRole("button", { name: "Configuration" }).click();

    await expect.element(page.getByText("Binary path")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Binary path")).toHaveValue("claude");
    await expect.element(page.getByText("Launch arguments", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("e.g. --chrome")).toBeInTheDocument();
  });

  it("distinguishes configured Claude chat auth from verified usage", async () => {
    const claude = createClaudeProvider();
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...claude,
          auth: {
            status: "authenticated",
            label: "Claude Max Subscription",
            capabilities: {
              chat: {
                status: "configured",
                detail: "A credential was found locally.",
              },
              usage: {
                status: "verified",
                detail: "Subscription usage was fetched successfully.",
              },
            },
          },
        },
      ],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByText(/Credential configured · Claude Max/)).toBeInTheDocument();
    await page.getByLabelText("Toggle Claude details").click();
    await expect.element(page.getByText("Chat configured")).toBeVisible();
    await expect.element(page.getByText("Usage verified")).toBeVisible();
    const advancedTokenLabel = page.getByText("Advanced: headless chat token");
    await expect.element(advancedTokenLabel).toBeVisible();
    const advancedTokenToggle = advancedTokenLabel.element().closest("summary");
    if (!advancedTokenToggle) throw new Error("Claude details panel did not render");
    await waitForPanelOpen(advancedTokenToggle);
    await page.elementLocator(advancedTokenToggle).click();
    await expect.element(page.getByText(/Optional for remote or headless chat/)).toBeVisible();
  });

  it("signs a provider in without leaving settings", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          auth: { status: "unauthenticated" },
        },
      ],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Claude details").click();
    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    await expect.element(signIn).toBeVisible();
    await waitForPanelOpen(signIn.element());
    await signIn.click();

    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([
        { instanceId: "claudeAgent", flow: "login" },
      ]);
    });

    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:00.000Z",
      type: "command",
      flow: "login",
      command: "claude auth login",
    });
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:00.000Z",
      type: "status",
      status: "running",
      exitCode: null,
      detail: null,
    });
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:01.000Z",
      type: "output",
      data: "Opening browser to complete sign-in\r\n",
    });

    await expect
      .element(page.getByText("Finish sign-in in your browser, then come back to this page."))
      .toBeVisible();
    await expect.element(page.getByText("Opening browser to complete sign-in")).toBeVisible();

    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:02.000Z",
      type: "status",
      status: "succeeded",
      exitCode: 0,
      detail: null,
    });

    await expect.element(page.getByText("Signed in", { exact: true })).toBeVisible();
  });

  it("signs a signed-out provider in from its row without opening the card first", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          auth: { status: "unauthenticated" },
        },
      ],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Sign in to Claude" }).click();

    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([
        { instanceId: "claudeAgent", flow: "login" },
      ]);
    });
    // The card opens on its Account section so the sign-in progress is in view.
    await expect
      .element(page.getByRole("button", { name: "Sign in", exact: true }), { timeout: 5_000 })
      .toBeVisible();
  });

  it("switches Antigravity to a Gemini API key in one save, then checks the key", async () => {
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: { updateSettings },
      shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
    } as unknown as LocalApi;
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          instanceId: ProviderInstanceId.make("antigravity"),
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "Antigravity",
          version: "1.3.0",
          auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
        },
      ],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Antigravity details").click();
    await expect
      .element(page.getByRole("radio", { name: /Google account/ }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: /Gemini API key/ }).click();
    // Per-use methods say so before anything is saved.
    await expect
      .element(page.getByText("Google bills each request to you", { exact: false }))
      .toBeVisible();
    const switchButton = page.getByRole("button", { name: "Switch to Gemini API key" });
    await expect.element(switchButton).toBeDisabled();
    await page.getByLabelText("Gemini API key").fill("AIzaSyTestKey000000000007Qx2");
    await switchButton.click();

    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    const saved =
      updateSettings.mock.calls[0]![0].providerInstances?.[ProviderInstanceId.make("antigravity")];
    expect(saved?.config).toMatchObject({ authMethod: "gemini-api-key" });
    expect(saved?.environment).toEqual([
      { name: "GEMINI_API_KEY", value: "AIzaSyTestKey000000000007Qx2", sensitive: true },
    ]);
    // The key check starts once the save landed.
    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([
        { instanceId: "antigravity", flow: "login" },
      ]);
    });
  });

  it("opens the shared reset-credit picker from provider settings", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createCodexProviderWithResetCredits()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Choose a reset credit for Codex usage").click();

    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("Codex usage resets")).toBeInTheDocument();
    await expect.element(page.getByText("Full reset").first()).toBeInTheDocument();
    await expect.element(page.getByText("in 4 days")).toBeInTheDocument();
    await expect.element(page.getByText(/^Expires /).first()).toBeInTheDocument();
    await expect.element(page.getByText("1 additional reset")).toBeInTheDocument();
  });

  it("fills a complete sparse lifetime history with zero-usage dates through today", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createCodexProviderWithTokenHistory()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Codex details").click();
    await page.getByRole("button", { name: "Usage" }).click();

    const beforeFirstActivity = formatTokenActivityTestDate(utcDateKeyAtOffset(-41));
    const missingActivityDate = formatTokenActivityTestDate(utcDateKeyAtOffset(-39));
    const today = formatTokenActivityTestDate(utcDateKeyAtOffset(0));
    const visibleActivityGrid = page.getByLabelText("Token history daily token activity").last();
    await expect
      .element(visibleActivityGrid.getByLabelText(`0 tokens on ${beforeFirstActivity}`))
      .toBeVisible();
    await expect
      .element(visibleActivityGrid.getByLabelText(`0 tokens on ${missingActivityDate}`))
      .toBeVisible();
    await expect.element(visibleActivityGrid.getByLabelText(`0 tokens on ${today}`)).toBeVisible();
  });

  it("shows paired-computer Claude token history with an all-machines link", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createClaudeProviderWithTokenHistory()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Claude details").click();
    await page.getByRole("button", { name: "Usage" }).click();

    await expect.element(page.getByText("Local token activity").first()).toBeVisible();
    await expect
      .element(page.getByText("Observed on this computer from Claude Code history."))
      .toBeVisible();
    const allMachinesLink = page.getByRole("link", { name: "View all machines" });
    await expect.element(allMachinesLink).toHaveAttribute("href", "/usage");
    const root = document.documentElement;
    const hadDarkClass = root.classList.contains("dark");
    root.classList.add("dark");
    try {
      await allMachinesLink.hover();
      const expectedHoverColor = getComputedStyle(root)
        .getPropertyValue("--primary-readable")
        .trim();
      await vi.waitFor(() => {
        expect(getComputedStyle(allMachinesLink.element()).color).toBe(expectedHoverColor);
      });
    } finally {
      if (!hadDarkClass) root.classList.remove("dark");
    }

    const today = formatTokenActivityTestDate(utcDateKeyAtOffset(0));
    const visibleActivityGrid = page
      .getByLabelText("Local token activity daily token activity")
      .last();
    await expect.element(visibleActivityGrid.getByLabelText(`0 tokens on ${today}`)).toBeVisible();
  });

  it("configures Claude fallback models from the provider models list", async () => {
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateSettings,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createClaudeProvider()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Claude details").click();
    await page.getByRole("button", { name: "Models" }).click();
    await page.getByRole("button", { name: "Add Claude Sonnet 4.6 to fallback chain" }).click();

    await expect.element(page.getByText("fallback 1")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          providerInstances: expect.objectContaining({
            [ProviderInstanceId.make("claudeAgent")]: expect.objectContaining({
              config: expect.objectContaining({
                fallbackModel: ["claude-sonnet-4-6"],
              }),
            }),
          }),
        }),
      );
    });
  });

  it("keeps model details open when the info icon is clicked", async () => {
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createClaudeProvider()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByLabelText("Toggle Claude details").click();
    await page.getByRole("button", { name: "Models" }).click();

    // The details panel used to be a tooltip, which closed on press and could
    // only be reopened by leaving and re-entering the icon.
    await page.getByRole("button", { name: "Details for Claude Sonnet 4.6" }).click();
    await expect.element(page.getByText("claude-sonnet-4-6")).toBeVisible();

    await page.getByRole("button", { name: "Details for Claude Sonnet 4.6" }).click();
    await expect.element(page.getByText("claude-sonnet-4-6")).not.toBeInTheDocument();
  });

  it("runs one-click provider updates from the provider card", async () => {
    const updateProvider = vi.fn<LocalApi["server"]["updateProvider"]>().mockResolvedValue({
      providers: [createOutdatedProvider("codex")],
    });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex")],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: /^Update (Codex|Claude) to / }).click();
    await expect.element(page.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Update now" }).click();

    expect(updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    });
  });

  it("installs a missing provider CLI from the provider card", async () => {
    const updateProvider = vi.fn<LocalApi["server"]["updateProvider"]>().mockResolvedValue({
      providers: [createMissingClaudeProvider({ canInstall: true })],
    });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createMissingClaudeProvider({ canInstall: true })],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    // The button replaces the manual recipe; the diagnosis sentence stays.
    await expect
      .element(page.getByText("Claude Agent CLI (`claude`) is not installed or not on PATH."))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "https://claude.com/product/claude-code" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Install Claude" }).click();

    expect(updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claudeAgent"),
      action: "install",
    });
  });

  it("adds another account from the header menu and starts signing it in", async () => {
    const workInstanceId = ProviderInstanceId.make("claudeAgent_work_ab12cd");
    const addProviderAccount = vi
      .fn<LocalApi["server"]["addProviderAccount"]>()
      .mockImplementation(async () => {
        // The server saves the account and its row appears, signed out.
        setServerConfigSnapshot({
          ...createBaseServerConfig(),
          providers: [
            createClaudeProvider(),
            {
              ...createClaudeProvider(),
              instanceId: workInstanceId,
              displayName: "Work",
              accentColor: "#16a34a",
              auth: { status: "unauthenticated" },
            },
          ],
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [workInstanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Work",
                accentColor: "#16a34a",
                enabled: true,
                config: { accountFolder: "/state/accounts/claudeAgent_work_ab12cd" },
              },
            },
          },
        });
        return { instanceId: workInstanceId };
      });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: { addProviderAccount },
    } as unknown as LocalApi;
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createClaudeProvider()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Add an account or provider instance" }).click();
    await page.getByRole("menuitem", { name: "Add a Claude account" }).click();

    const form = page.getByTestId("add-provider-account-form");
    await expect.element(form.getByRole("textbox", { name: "Name" })).toHaveValue("Work");
    await form.getByRole("button", { name: "Sign in to Claude" }).click();

    await vi.waitFor(() =>
      expect(addProviderAccount).toHaveBeenCalledWith({
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Work",
        accentColor: "#16a34a",
      }),
    );
    // The new row signs itself in; the agent's own row is left alone.
    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([
        { instanceId: "claudeAgent_work_ab12cd", flow: "login" },
      ]);
    });
    await expect
      .element(page.getByRole("button", { name: "Toggle Claude · Work details" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("reports a running provider install in place of the install button", async () => {
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider: vi.fn().mockResolvedValue({ providers: [] }),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        createMissingClaudeProvider({
          canInstall: true,
          updateState: {
            status: "running",
            startedAt: "2026-05-04T10:00:00.000Z",
            finishedAt: null,
            message: "Installing provider.",
            output: "added 1 package",
          },
        }),
      ],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByText("Installing… added 1 package")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Install Claude" }))
      .not.toBeInTheDocument();
  });

  it("keeps the install guide when the server derived no install command", async () => {
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider: vi.fn().mockResolvedValue({ providers: [] }),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createMissingClaudeProvider()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    // No derived install command: the full guide sentence and its link stay.
    await expect
      .element(page.getByRole("button", { name: "Install Claude" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "https://claude.com/product/claude-code" }))
      .toBeVisible();
  });

  it("runs verified native one-click updates for Windows Claude advisories", async () => {
    const updateProvider = vi.fn<LocalApi["server"]["updateProvider"]>().mockResolvedValue({
      providers: [createVerifiedNativeOutdatedClaudeProvider()],
    });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createVerifiedNativeOutdatedClaudeProvider()],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: /^Update (Codex|Claude) to / }).click();
    await expect
      .element(
        page.getByText(
          "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand <verified-native-claude-updater>",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Update now" }).click();

    expect(updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claudeAgent"),
    });
  });

  it("offers a recovery action for Windows Claude update process locks", async () => {
    const provider = createClaudeUpdateLockFailedProvider();
    const resolveProviderUpdateBlockers = vi
      .fn<LocalApi["server"]["resolveProviderUpdateBlockers"]>()
      .mockResolvedValue({
        providers: [
          {
            ...provider,
            updateState: {
              status: "unchanged",
              startedAt: "2026-05-04T10:02:00.000Z",
              finishedAt: "2026-05-04T10:02:01.000Z",
              message: "Stopped 1 process running Claude. Run the update again.",
              output: null,
            },
          },
        ],
        stoppedProcessCount: 1,
        remainingProcessCount: 0,
        message: "Stopped 1 process running Claude. Run the update again.",
      });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        resolveProviderUpdateBlockers,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [provider],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: /^Update (Codex|Claude) to / }).click();

    await expect
      .element(
        page.getByText(
          "Claude is running in the background, so Windows cannot replace claude.exe. Stop those Claude processes, then run the update again.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText("#< CLIXML")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Stop Claude processes" }).click();

    expect(resolveProviderUpdateBlockers).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claudeAgent"),
    });
  });

  it("keeps long provider update commands inside the fixed-width popover", async () => {
    const longUpdateCommand =
      "npm install -g @anthropic-ai/claude-code@latest --registry=https://registry.npmjs.org --cache=/tmp/threadlines-provider-update-cache";

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex", longUpdateCommand)],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: /^Update (Codex|Claude) to / }).click();
    await expect.element(page.getByText(longUpdateCommand)).toBeInTheDocument();

    await vi.waitFor(() => {
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
      const commandCode = Array.from(document.querySelectorAll<HTMLElement>("code")).find(
        (element) => element.textContent === longUpdateCommand,
      );
      const scrollViewport = commandCode?.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );

      expect(popup).toBeTruthy();
      expect(commandCode).toBeTruthy();
      expect(scrollViewport).toBeTruthy();

      const popupRect = popup!.getBoundingClientRect();
      const viewportRect = scrollViewport!.getBoundingClientRect();

      expect(popupRect.width).toBeGreaterThan(300);
      expect(popupRect.width).toBeLessThanOrEqual(337);
      expect(viewportRect.right).toBeLessThanOrEqual(popupRect.right + 0.5);
      expect(scrollViewport!.scrollWidth).toBeGreaterThan(scrollViewport!.clientWidth);
    });
  });
});

describe("ThreadsSettingsPanel new thread defaults", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  const codexWithAstra = (): ServerProvider => ({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [
      { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
      { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  });
  const astra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };

  const mountWith = async (settings: Partial<ServerConfig["settings"]>) => {
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: { updateSettings },
    } as unknown as LocalApi;
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [codexWithAstra()],
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
    });
    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ThreadsSettingsPanel />
      </TestAppProviders>,
    );
    return updateSettings;
  };

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    localStorage.clear();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
  });

  it("starts on the device's last used model, sets a default, and goes back to last used", async () => {
    const updateSettings = await mountWith({});

    await page.getByRole("button", { name: "Last used" }).click();
    await page.getByRole("tab", { name: "Codex" }).click();
    await page.getByRole("option", { name: /GPT-6 Astra/ }).click();
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        newThreadModelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      });
    });
    await expect
      .element(page.getByText("Every new thread starts with this model and reasoning."))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "GPT-6 Astra" }).first().click();
    await page.getByRole("button", { name: /Last used/ }).click();
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenLastCalledWith({ newThreadModelSelection: null });
    });
  });

  it("lists the room's agents, renames and removes them", async () => {
    const updateSettings = await mountWith({
      newThreadRoomAgents: [{ modelSelection: astra, role: "Reviewer" }],
    });

    const name = page.getByRole("textbox", { name: "Name for agent 1" });
    await expect.element(name).toHaveValue("Reviewer");
    await expect
      .element(page.getByText("Threads that start with other agents can't be reverted."))
      .toBeInTheDocument();

    await name.fill("Checker");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        newThreadRoomAgents: [{ modelSelection: astra, role: "Checker" }],
      });
    });

    await page.getByRole("button", { name: "Remove agent 1" }).click();
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenLastCalledWith({ newThreadRoomAgents: [] });
    });
    await expect
      .element(page.getByText("No other agents. New threads start with one agent."))
      .toBeInTheDocument();
  });

  it("holds the room back while Rooms is off", async () => {
    await mountWith({ enableRooms: false, newThreadRoomAgents: [{ modelSelection: astra }] });

    await expect
      .element(page.getByText("Turn on Rooms below to start threads with more than one agent."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Add agent" })).toBeDisabled();
  });
});

describe("SourceControlSettingsPanel discovery states", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetAppAtomRegistryForTests();
    await __resetLocalApiForTests();
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
  });

  function setSourceControlDiscoveryStub(
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>,
    updateSourceControlTool?: LocalApi["server"]["updateSourceControlTool"],
    setup: Partial<
      Pick<LocalApi["server"], "getSourceControlSetup" | "startGitHubAuth" | "cancelGitHubAuth">
    > = {},
  ) {
    resetSourceControlDiscoveryStateForTests();
    window.nativeApi = {
      server: {
        discoverSourceControl,
        getSourceControlSetup: async () => ({
          tools: [],
          githubAuth: { status: "idle", verificationUrl: null, userCode: null, message: null },
        }),
        ...setup,
        ...(updateSourceControlTool ? { updateSourceControlTool } : {}),
      },
      shell: { openExternal: vi.fn(async () => {}) },
    } as unknown as LocalApi;
  }

  it("restores an installation check and supports GitHub browser sign-in, cancellation, and safe links", async () => {
    const discovery: SourceControlDiscoveryResult = {
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("2.55.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "available",
          version: Option.some("2.98.0"),
          installHint: "Install GitHub CLI.",
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    };
    let state: SourceControlSetupState = {
      tools: [
        {
          target: "git",
          operation: "install",
          status: "checking",
          message: "Checking the installed Git version…",
        },
      ],
      githubAuth: { status: "idle", verificationUrl: null, userCode: null, message: null },
    };
    let verificationUrl = "https://github.com/login/device";
    const cancel = vi.fn(async () => {
      state = {
        ...state,
        githubAuth: { status: "cancelled", verificationUrl: null, userCode: null, message: null },
      };
    });
    setSourceControlDiscoveryStub(async () => discovery, undefined, {
      getSourceControlSetup: async () => state,
      startGitHubAuth: async () => {
        state = {
          ...state,
          githubAuth: { status: "running", verificationUrl, userCode: "ABCD-1234", message: null },
        };
        return state.githubAuth;
      },
      cancelGitHubAuth: cancel,
    });
    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );
    await expect.element(page.getByText("Checking the installed Git version…")).toBeVisible();
    await page.getByRole("button", { name: "Sign in to GitHub" }).click();
    await expect.element(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open GitHub", exact: true }))
      .toBeVisible();
    await expect
      .poll(() => vi.mocked(window.nativeApi!.shell.openExternal).mock.calls.length)
      .toBe(1);
    expect(window.nativeApi!.shell.openExternal).toHaveBeenCalledWith(
      "https://github.com/login/device",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Sign in to GitHub" })).toBeVisible();
    expect(cancel).toHaveBeenCalledOnce();
    verificationUrl = "https://github.com.evil.example/login/device";
    await page.getByRole("button", { name: "Sign in to GitHub" }).click();
    await expect.element(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open GitHub", exact: true }))
      .not.toBeInTheDocument();
    expect(window.nativeApi!.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("shows skeleton sections while the first source control scan is pending", async () => {
    setSourceControlDiscoveryStub(() => new Promise(() => {}));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByText("Version Control")).toBeInTheDocument();
    await expect.element(page.getByText("Source Control Providers")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Rescan server environment" }))
      .toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("uses the shared empty state when discovery completes without tools", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [],
      sourceControlProviders: [],
    }));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByText("Nothing detected yet")).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  });

  it("keeps discovered rows instead of showing the empty state", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("runs a verified source control tool update only after Update now is clicked", async () => {
    const discoveryResult: SourceControlDiscoveryResult = {
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.55.0.windows.4"),
          installHint: "Install Git.",
          detail: Option.none(),
          versionAdvisory: {
            status: "behind_latest",
            severity: "info",
            currentVersion: "2.55.0.windows.4",
            latestVersion: "2.56.0.windows.1",
            recommendedVersion: "2.56.0.windows.1",
            checkedAt: "2026-08-14T00:00:00.000Z",
            message: "A newer Git for Windows release is available.",
            notificationKey: null,
            actions: [],
          },
        },
      ],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "available",
          version: Option.some("gh version 2.92.0"),
          installHint: "Install GitHub CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("octocat"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
          versionAdvisory: {
            status: "recommended_update",
            severity: "warning",
            currentVersion: "2.92.0",
            latestVersion: "2.98.0",
            recommendedVersion: "2.97.0",
            checkedAt: "2026-08-14T00:00:00.000Z",
            message:
              "This GitHub CLI version can briefly open terminal windows during background telemetry on Windows and is below the recommended security-fix release.",
            notificationKey: "github-cli:2.98.0",
            actions: [
              {
                label: "Update now",
                kind: "runUpdate",
                target: "github-cli",
              },
              {
                label: "Copy WinGet command",
                kind: "copyCommand",
                value:
                  "winget upgrade --id GitHub.cli --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity",
              },
              {
                label: "Open releases",
                kind: "openUrl",
                value: "https://github.com/cli/cli/releases/latest",
              },
            ],
          },
        },
      ],
    };
    const updateSourceControlTool = vi
      .fn<LocalApi["server"]["updateSourceControlTool"]>()
      .mockResolvedValue({
        target: "github-cli",
        operation: "update",
        status: "succeeded",
        previousVersion: "2.92.0",
        currentVersion: "2.98.0",
        discovery: discoveryResult,
      });
    setSourceControlDiscoveryStub(async () => discoveryResult, updateSourceControlTool);

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    const advisoryButton = page.getByRole("button", { name: "GitHub update advisory" });
    await expect.element(advisoryButton).toBeInTheDocument();

    await advisoryButton.click();

    await expect.element(page.getByText("Update available")).toBeVisible();
    await expect.element(page.getByText("Latest")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "winget upgrade --id GitHub.cli --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update now" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open releases" })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Threadlines runs only the verified WinGet package shown above after you click Update now. Windows may ask for permission.",
        ),
      )
      .toBeVisible();
    expect(updateSourceControlTool).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Update now" }).click();
    expect(updateSourceControlTool).toHaveBeenCalledWith({ target: "github-cli" });

    const warnings = collectSourceControlToolUpdateNotices({
      discovery: discoveryResult,
      environmentKey: "environment:test-host",
    });
    expect(warnings).toHaveLength(1);
    expect(sourceControlToolUpdateNoticeSetKey(warnings)).toBe(
      "environment:test-host:github-cli:2.98.0",
    );
  });

  it("runs a verified Homebrew install only after Install now is clicked", async () => {
    const discoveryResult: SourceControlDiscoveryResult = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "missing",
          version: Option.none(),
          installHint: "Install GitHub CLI.",
          detail: Option.some("gh was not found on the server PATH."),
          auth: {
            status: "unknown",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
          versionAdvisory: {
            status: "install_available",
            severity: "info",
            currentVersion: null,
            latestVersion: null,
            recommendedVersion: null,
            checkedAt: "2026-08-14T00:00:00.000Z",
            message: "Install GitHub CLI to enable this source control integration.",
            notificationKey: null,
            actions: [
              {
                label: "Install now",
                kind: "runUpdate",
                target: "github-cli",
                operation: "install",
              },
              {
                label: "Copy Homebrew command",
                kind: "copyCommand",
                value: "brew install gh",
              },
              {
                label: "Open install guide",
                kind: "openUrl",
                value: "https://cli.github.com/",
              },
            ],
          },
        },
      ],
    };
    const updateSourceControlTool = vi
      .fn<LocalApi["server"]["updateSourceControlTool"]>()
      .mockResolvedValue({
        target: "github-cli",
        operation: "install",
        status: "succeeded",
        previousVersion: null,
        currentVersion: "2.98.0",
        discovery: discoveryResult,
      });
    setSourceControlDiscoveryStub(async () => discoveryResult, updateSourceControlTool);

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    expect(updateSourceControlTool).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Install GitHub" }).click();
    expect(updateSourceControlTool).toHaveBeenCalledWith({
      target: "github-cli",
      operation: "install",
    });
  });

  it("offers the official Git for Windows updater without waiting for WinGet", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.55.0.windows.3"),
          installHint: "Install Git.",
          detail: Option.none(),
          versionAdvisory: {
            status: "recommended_update",
            severity: "warning",
            currentVersion: "2.55.0.windows.3",
            latestVersion: "2.55.0.windows.4",
            recommendedVersion: "2.55.0.windows.4",
            checkedAt: "2026-08-14T00:00:00.000Z",
            message:
              "This Git for Windows version is below the recommended security-fix release. The official updater may close open Git Bash windows during installation.",
            notificationKey: "git-for-windows:2.56.0.windows.1",
            actions: [
              {
                label: "Update now",
                kind: "runUpdate",
                target: "git",
              },
              {
                label: "Copy Git for Windows update command",
                kind: "copyCommand",
                value: "git update-git-for-windows --yes",
              },
              {
                label: "Open official release",
                kind: "openUrl",
                value: "https://github.com/git-for-windows/git/releases/latest",
              },
            ],
          },
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await page.getByRole("button", { name: "Git update advisory" }).click();

    await expect.element(page.getByRole("button", { name: "Update now" })).toBeVisible();
    await expect.element(page.getByText("git update-git-for-windows --yes")).toBeVisible();
    await expect.element(page.getByText(/may close open Git Bash windows/i)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open official release" })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Threadlines runs Git for Windows' official updater after you click Update now. Windows may ask for permission.",
        ),
      )
      .toBeVisible();
  });

  it("shows unauthenticated source control providers as unavailable", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "available",
          version: Option.some("gh version 2.92.0"),
          installHint: "Install GitHub CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("octocat"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "bitbucket",
          label: "Bitbucket",
          status: "available",
          version: Option.none(),
          installHint: "Set THREADLINES_BITBUCKET_EMAIL and THREADLINES_BITBUCKET_API_TOKEN.",
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          },
        },
      ],
    }));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByRole("switch", { name: "GitHub availability" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("switch", { name: "Bitbucket availability" }))
      .toHaveAttribute("aria-checked", "false");
    await expect.element(page.getByText("Not authenticated")).toBeInTheDocument();
  });

  it("shows Git fetch interval settings inside the Git details dropdown", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    const toggle = page.getByRole("button", { name: "Toggle Git details" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();

    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByLabelText("Automatic Git fetch interval in seconds"))
      .toBeVisible();
    await expect
      .element(page.getByText("Automatic Git fetches run every 30 seconds"))
      .not.toBeInTheDocument();
  });

  it("does not rescan on remount while the discovery atom is fresh", async () => {
    let calls = 0;
    setSourceControlDiscoveryStub(async () => {
      calls += 1;
      return {
        versionControlSystems: [
          {
            kind: "git",
            label: "Git",
            executable: "git",
            implemented: true,
            status: "available",
            version: Option.some("git version 2.50.0"),
            installHint: "Install Git.",
            detail: Option.none(),
          },
        ],
        sourceControlProviders: [],
      };
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    expect(calls).toBe(1);

    const teardown = mounted.cleanup ?? mounted.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlSettingsPanel />
      </TestAppProviders>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    expect(calls).toBe(1);
  });
});
