import "../../index.css";

import {
  type AcpRegistryCatalog,
  type AcpRegistryCatalogAgent,
  type AuthAccessStreamEvent,
  type AuthAccessSnapshot,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DesktopBridge,
  type DesktopCliCommandResult,
  type DesktopCliCommandStatus,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type EnvironmentApi,
  type LocalApi,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  type OutsideAgentAssistantSignIn,
  type OutsideAgentAssistantsState,
  type OutsideAgentConnection,
  type OutsideAgentPendingRequest,
  type OutsideAgentsSnapshot,
  ProjectId,
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
  type ServerProviderCommunity,
  type SourceControlDiscoveryResult,
  type SourceControlSetupState,
  ThreadId,
} from "@threadlines/contracts";
import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useState, type ReactNode } from "react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { __resetLocalApiForTests } from "../../localApi";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import {
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState";
import { useUiStateStore } from "../../uiStateStore";
import {
  collectSourceControlToolUpdateNotices,
  sourceControlToolUpdateNoticeSetKey,
} from "../SourceControlToolUpdateLaunchNotification.logic";
import {
  __resetComputerLinksForTests,
  __setComputerLinksClientForTests,
  type ComputerLinksClient,
  useComputerLinksStore,
} from "../../environments/links/computerLinks";
import { DeviceRenameDialogHost } from "../DeviceRenameDialog";
import { ComputerConnectionGroup } from "../fleet/ComputerConnectionGroup";
import { OutsideAgentsHost } from "../outsideAgents/OutsideAgentsHost";
import { ConnectionsSettings } from "./ConnectionsSettings";
import {
  closeConnectComputerDialog,
  ConnectComputerDialogHost,
  openConnectComputerDialog,
} from "./connections/JoinComputerDialog";
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { GeneralSettingsPanel, ProviderSettingsPanel } from "./SettingsPanels";
import { usePlaceArrival } from "../../hooks/usePlaceArrival";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSearchResultsBody } from "./SettingsSearch";
import { useSettingsSearchActive } from "./SettingsSearchField";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { useSettingsSearchStore } from "./settingsSearchStore";
import { placePage } from "@threadlines/shared/appPlaces";
import { SettingsGroup } from "./settingsLayout";
import {
  SettingsPlaceSignalsProvider,
  type SettingsPlaceSearchId,
  type SettingsRowPlaceId,
  useSettingsPlaceShown,
} from "./settingsPlaceAvailability";
import { SETTINGS_ROWS } from "./settingsRowRegistry";
import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { ThreadsSettingsPanel } from "./ThreadsSettings";
import {
  __setProviderAuthClientForTests,
  type ProviderAuthClient,
} from "../../environments/providerComputer";
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
 * Opens a provider's card and waits until its panel has finished opening. Use
 * it rather than clicking the toggle: the next click belongs inside the card,
 * and a panel that is still opening is a short clipping box whose content
 * slides as it grows. An element in it can hold still for two frames and then
 * move between a pointer's press and its release, which loses the click.
 */
async function openProviderDetails(providerName: string, instanceId?: ProviderInstanceId) {
  // Two rows can share a name (a community agent beside the built-in one it
  // became); the instance id picks one.
  const toggle = instanceId
    ? page.elementLocator(
        await vi.waitUntil(() =>
          document.querySelector<HTMLElement>(
            `[data-provider-instance-id="${instanceId}"] [aria-label="Toggle ${providerName} details"]`,
          ),
        ),
      )
    : page.getByLabelText(`Toggle ${providerName} details`);
  await toggle.click();
  const row = toggle.element().closest('[data-testid="provider-instance-row"]');
  if (!row) throw new Error(`Expected the ${providerName} toggle inside its provider row`);
  await vi.waitFor(
    () => {
      const panel = row.querySelector('[data-slot="collapsible-panel"]');
      // Open means settled: past its zero-height start, with no height
      // transition still running.
      expect(panel?.clientHeight).toBeGreaterThan(0);
      expect(panel?.getAnimations()).toHaveLength(0);
    },
    { timeout: 5_000, interval: 16 },
  );
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
    | {
        readonly type: "command";
        readonly flow: string;
        readonly command: string;
        readonly flowId?: string;
        readonly requestId?: string;
        readonly surface?: "terminal" | "browser";
        readonly opensPageItself?: boolean;
      }
    | { readonly type: "output"; readonly data: string }
    | {
        readonly type: "status";
        readonly status: string;
        readonly exitCode: number | null;
        readonly detail: string | null;
      }
    | {
        readonly type: "pageRequest";
        readonly flowId: string;
        readonly requestId: string;
        readonly url: string;
        readonly message: string | null;
        readonly code?: string;
        readonly settled: boolean;
      }
    | {
        readonly type: "question";
        readonly flowId: string;
        readonly requestId: string;
        readonly kind: "choice" | "text" | "secret";
        readonly message: string;
        readonly placeholder?: string;
        readonly options?: ReadonlyArray<{
          readonly id: string;
          readonly label: string;
          readonly detail?: string;
          readonly group?: string;
          readonly configured?: boolean;
        }>;
        readonly settled: boolean;
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
  /** Whether each start said its client answers questions. */
  const startQuestions: Array<boolean | undefined> = [];
  /** Each start's `requestId`: a command event echoing it is that client's own run. */
  const startRequestIds: Array<string | undefined> = [];
  const respondCalls: Array<{
    instanceId: string;
    flowId: string;
    requestId: string;
    accept: boolean;
    value?: string;
  }> = [];

  return {
    startCalls,
    startQuestions,
    startRequestIds,
    respondCalls,
    reset() {
      listeners.clear();
      startCalls.length = 0;
      startQuestions.length = 0;
      startRequestIds.length = 0;
      respondCalls.length = 0;
    },
    emit(event: AuthEvent) {
      for (const entry of listeners) {
        if (entry.instanceId === event.instanceId) {
          entry.listener(event);
        }
      }
    },
    client: {
      start: (input: {
        instanceId: string;
        flow: string;
        questions?: boolean;
        requestId?: string;
      }) => {
        startCalls.push({ instanceId: input.instanceId, flow: input.flow });
        startQuestions.push(input.questions);
        startRequestIds.push(input.requestId);
        return Promise.resolve();
      },
      write: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      respond: (input: {
        instanceId: string;
        flowId: string;
        requestId: string;
        accept: boolean;
        value?: string;
      }) => {
        respondCalls.push({ ...input });
        return Promise.resolve();
      },
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

/**
 * The saved computers this app uses, and what their connection actions do
 * (Fleet's Connection group, the Connect dialog's other ways).
 */
const savedComputersHarness = vi.hoisted(() => {
  const harness = {
    registryById: {} as Record<string, unknown>,
    runtimeById: {} as Record<string, unknown>,
    disconnectByUser: vi.fn(async (_environmentId: string) => undefined),
    reconnect: vi.fn(async (_environmentId: string) => undefined),
    cancelPending: vi.fn(async (_environmentId: string) => undefined),
    addSavedEnvironment: vi.fn(),
    reset: () => {
      harness.registryById = {};
      harness.runtimeById = {};
      harness.disconnectByUser.mockClear();
      harness.reconnect.mockClear();
      harness.cancelPending.mockClear();
      harness.addSavedEnvironment.mockReset();
    },
  };
  return harness;
});

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

/** This computer's agents outside Threadlines, as its server would stream and answer them. */
const outsideAgentsHarness = vi.hoisted(() => {
  let snapshot: OutsideAgentsSnapshot | null = null;
  const listeners = new Set<(snapshot: OutsideAgentsSnapshot) => void>();
  const client = {
    subscribe: (listener: (snapshot: OutsideAgentsSnapshot) => void) => {
      listeners.add(listener);
      if (snapshot) listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    approve: vi.fn(),
    deny: vi.fn(),
    denyAll: vi.fn(),
    resumeRequests: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    assistantCode: vi.fn(),
    assistantCodeCancel: vi.fn(),
    createKey: vi.fn(),
  };
  return {
    client,
    /** Streams open now. */
    listenerCount: () => listeners.size,
    reset() {
      snapshot = null;
      listeners.clear();
      for (const call of [
        client.approve,
        client.deny,
        client.denyAll,
        client.resumeRequests,
        client.update,
        client.remove,
        client.assistantCode,
        client.assistantCodeCancel,
        client.createKey,
      ]) {
        call.mockReset().mockResolvedValue(undefined);
      }
    },
    emit(next: OutsideAgentsSnapshot) {
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
      outsideAgents: outsideAgentsHarness.client,
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
    addSavedEnvironment: savedComputersHarness.addSavedEnvironment,
    cancelPendingRelayJoin: savedComputersHarness.cancelPending,
    canJoinWithCode: () => true,
    connectDesktopSshEnvironment: mockConnectDesktopSshEnvironment,
    disconnectSavedEnvironment: vi.fn(),
    disconnectSavedEnvironmentByUser: savedComputersHarness.disconnectByUser,
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readBackendEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    readEnvironmentDescriptor: () => null,
    listEnvironmentConnections: () => [primaryConnection],
    reconnectSavedEnvironment: savedComputersHarness.reconnect,
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
      selector: (state: { byId: Record<string, unknown> }) => unknown,
    ) => selector({ byId: savedComputersHarness.registryById }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, unknown> }) => unknown,
    ) => selector({ byId: savedComputersHarness.runtimeById }),
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
  readonly role: "owner" | "client" | "peer";
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
    // Settings signs in on this app's own computer.
    __setProviderAuthClientForTests(
      null,
      providerAuthHarness.client as unknown as ProviderAuthClient,
    );
    relayAccessHarness.reset();
    mockConnectDesktopSshEnvironment.mockReset();
    savedComputersHarness.reset();
    __resetComputerLinksForTests();
    closeConnectComputerDialog();
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
    __resetEnvironmentApiOverridesForTests();
    resetWsConnectionStateForTests();
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
      .element(page.getByText("Devices that can use this computer", { exact: true }))
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

  it("renames this computer and tells apart, then renames, two phones", async () => {
    window.desktopBridge = createDesktopBridgeStub();
    const iPhone = (sessionId: string, issuedAt: string, name?: string) =>
      makeClientSession({
        sessionId,
        subject: "relay-device",
        role: "client",
        method: "bearer-session-token",
        client: { label: "iPhone", deviceType: "mobile", os: "iOS", ...(name ? { name } : {}) },
        issuedAt,
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: false,
        current: false,
      });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [
        iPhone("session-first", "2036-04-02T09:00:00.000Z"),
        iPhone("session-second", "2036-04-05T18:00:00.000Z"),
      ],
    });
    const renames: Array<unknown> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/auth/clients/rename") && init?.method === "POST") {
          renames.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ renamed: true }), { status: 200 });
        }
        throw new Error(`Unhandled fetch ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const base = createBaseServerConfig();
    const named = (label: string, computerName: string | null): ServerConfig => ({
      ...base,
      environment: {
        ...base.environment,
        label,
        systemLabel: "WILFREDO",
        platform: { os: "windows", arch: "x64" },
        capabilities: { ...base.environment.capabilities, deviceNames: true },
      },
      settings: { ...base.settings, computerName },
    });
    const updateSettings = vi.fn<EnvironmentApi["settings"]["update"]>(async (patch) => ({
      ...base.settings,
      computerName: patch.computerName ?? null,
    }));
    __setEnvironmentApiOverrideForTests(base.environment.environmentId, {
      settings: { update: updateSettings },
    } as unknown as EnvironmentApi);
    // Renaming saves on the computer, so it's offered only while connected.
    recordWsConnectionOpened();
    setServerConfigSnapshot(named("WILFREDO", null));

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
        <DeviceRenameDialogHost />
      </TestAppProviders>,
    );

    // This computer: saved on it, and the new name comes back from it.
    await page.getByTestId("connections-rename-computer").click();
    await expect.element(page.getByTestId("computer-rename-dialog")).toBeInTheDocument();
    await expect
      .element(page.getByText("Leave it empty to use WILFREDO, the name Windows gives it."))
      .toBeInTheDocument();
    await page.getByTestId("computer-rename-input").fill("Windows PC");
    await page.getByTestId("computer-rename-save").click();
    await expect.element(page.getByTestId("computer-rename-dialog")).not.toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith({ computerName: "Windows PC" });
    setServerConfigSnapshot(named("Windows PC", "Windows PC"));
    await expect.element(page.getByText("Windows PC", { exact: true })).toBeInTheDocument();

    // Two iPhones nobody named say when they paired.
    const firstRow = page.getByText(/^iPhone \(paired .+\)$/).first();
    await expect.element(firstRow).toBeInTheDocument();
    await expect.element(page.getByText(/^iPhone \(paired .+\)$/).nth(1)).toBeInTheDocument();
    await page.getByTestId("device-rename-session-first").click();
    await expect.element(page.getByTestId("device-rename-input")).toHaveValue("iPhone");
    await page.getByTestId("device-rename-input").fill("Kitchen phone");
    // Enter saves, like the button.
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByTestId("device-rename-dialog")).not.toBeInTheDocument();
    expect(renames).toEqual([{ sessionId: "session-first", name: "Kitchen phone" }]);
    authAccessHarness.emitClientUpserted(
      iPhone("session-first", "2036-04-02T09:00:00.000Z", "Kitchen phone"),
    );
    await expect.element(page.getByText("Kitchen phone", { exact: true })).toBeInTheDocument();
    // The other one is the only iPhone now: its name alone tells it apart.
    await expect.element(page.getByText("iPhone", { exact: true })).toBeInTheDocument();
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

  it("says what a network change's restart would stop on this computer", async () => {
    const thisComputer = EnvironmentId.make("env-this-computer");
    writePrimaryEnvironmentDescriptor({
      environmentId: thisComputer,
      label: "This Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.1.0",
      capabilities: { repositoryIdentity: false },
    });
    const threadKey = scopedThreadKey(scopeThreadRef(thisComputer, ThreadId.make("thread-1")));
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {
        [threadKey]: {
          terminalOpen: false,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: ["default"],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
      terminalActivityCommandByKey: { [`${threadKey}\u0000default`]: "npm run dev" },
    });
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    setServerConfigSnapshot(createBaseServerConfig());

    try {
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
            "npm run dev is still running in a terminal. Restarting now will stop it.",
            {
              exact: false,
            },
          ),
        )
        .toBeInTheDocument();
    } finally {
      useTerminalStateStore.setState({
        terminalStateByThreadKey: {},
        terminalActivityCommandByKey: {},
      });
      resetPrimaryEnvironmentDescriptorForTests();
    }
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
        <ConnectComputerDialogHost />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByTestId("connections-computers-summary"))
      .toMatchTextContent("No computers yet");
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
    // Build box doesn't take links (it hasn't connected yet): plain "Connected".
    await expect
      .element(addEnvironmentDialog.getByText("Connected to Build box.", { exact: true }))
      .toBeInTheDocument();
  });

  it("walks every connection action of a saved computer on its Fleet page", async () => {
    const environmentId = EnvironmentId.make("environment-macbook");
    const record = {
      environmentId,
      label: "Denys's MacBook Pro",
      httpBaseUrl: "http://10.0.0.219:3773/",
      wsBaseUrl: "ws://10.0.0.219:3773/",
      createdAt: "2036-04-07T00:00:00.000Z",
      lastConnectedAt: "2036-04-07T00:00:00.000Z",
    };
    const runtime = {
      connectionState: "disconnected",
      authState: "unknown",
      lastError: null,
      lastErrorAt: null,
      role: null,
      descriptor: null,
      serverConfig: null,
      connectedAt: null,
      disconnectedAt: null,
      route: null,
      waitingToReconnect: false,
      disconnectedByUser: false,
    };
    setServerConfigSnapshot(createBaseServerConfig());
    const showGroup = async (
      recordPatch: Record<string, unknown>,
      runtimePatch: Record<string, unknown>,
    ) => {
      if (mounted) {
        const teardown = mounted.cleanup ?? mounted.unmount;
        await teardown?.call(mounted);
      }
      savedComputersHarness.registryById[environmentId] = { ...record, ...recordPatch };
      savedComputersHarness.runtimeById[environmentId] = { ...runtime, ...runtimePatch };
      mounted = await renderWithTestRouter(
        <TestAppProviders>
          <ComputerConnectionGroup environmentId={environmentId} />
          <ConnectComputerDialogHost />
        </TestAppProviders>,
      );
    };

    // Waiting for a computer that didn't answer: the last problem, and Stop trying.
    await showGroup(
      {},
      {
        waitingToReconnect: true,
        lastError:
          "Can't reach Denys's MacBook Pro. It may be asleep, off, or offline. Threadlines will connect when it's back.",
      },
    );
    await expect
      .element(page.getByText("Threadlines will connect when it's back.", { exact: false }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Stop trying", exact: true }).click();
    await vi.waitFor(() => {
      expect(savedComputersHarness.disconnectByUser).toHaveBeenCalledWith(environmentId);
    });

    // Connected over SSH, on another version: the route, the SSH target, the
    // version warning, and Disconnect (which keeps it saved).
    savedComputersHarness.disconnectByUser.mockClear();
    await showGroup(
      {
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      },
      {
        connectionState: "connected",
        authState: "authenticated",
        connectedAt: "2036-04-07T00:00:00.000Z",
        serverConfig: {
          ...createBaseServerConfig(),
          environment: { ...createBaseServerConfig().environment, serverVersion: "9.9.9" },
        },
      },
    );
    await expect
      .element(page.getByText("SSH julius@devbox.example.com:2222", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("It runs Threadlines 9.9.9", { exact: false }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await vi.waitFor(() => {
      expect(savedComputersHarness.disconnectByUser).toHaveBeenCalledWith(environmentId);
    });

    // Offline: when it was last connected, and Reconnect.
    await showGroup({}, {});
    await expect.element(page.getByText("Last connected", { exact: false })).toBeInTheDocument();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await vi.waitFor(() => {
      expect(savedComputersHarness.reconnect).toHaveBeenCalledWith(environmentId);
    });

    // It removed this app's access: a retry can't fix that, a new code can.
    const relay = {
      version: 2 as const,
      relayOrigin: "https://relay.example.test",
      hostId: "host-1",
      deviceId: "device-1",
    };
    await showGroup({ relay }, { authState: "requires-auth" });
    await page.getByRole("button", { name: "Connect again with a new code", exact: true }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Connect to a computer" }))
      .toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // Still being added: the number to compare, and Cancel.
    await showGroup(
      {
        relay: {
          ...relay,
          pendingRequest: {
            requestId: "request-1",
            requestSecret: "secret",
            expiresAt: "2036-04-07T00:10:00.000Z",
            matchNumber: "42",
          },
        },
      },
      {},
    );
    await expect
      .element(page.getByText("Check it shows 42.", { exact: false }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await vi.waitFor(() => {
      expect(savedComputersHarness.cancelPending).toHaveBeenCalledWith(environmentId);
    });
  });

  it("joins linked computers to their links by session, even two with one name", async () => {
    const thisComputer = EnvironmentId.make("environment-local");
    const linkedSession = AuthSessionId.make("session-linked-studio");
    const otherSession = AuthSessionId.make("session-other-studio");
    window.desktopBridge = createDesktopBridgeStub();
    const peerSession = (sessionId: AuthSessionId) =>
      makeClientSession({
        sessionId,
        subject: "relay-device",
        role: "peer",
        method: "bearer-session-token",
        client: { label: "Studio", deviceType: "desktop", os: "macOS" },
        issuedAt: "2036-04-07T00:00:00.000Z",
        expiresAt: "2036-05-07T00:00:00.000Z",
        connected: true,
        current: false,
      });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [peerSession(linkedSession), peerSession(otherSession)],
    });
    const remove = vi.fn(async () => ({ otherComputer: "not_asked" as const }));
    __setComputerLinksClientForTests(thisComputer, {
      remove,
    } as unknown as ComputerLinksClient);
    useComputerLinksStore.getState().put(thisComputer, {
      outbound: [],
      inbound: [
        {
          deviceId: "device-studio",
          environmentId: EnvironmentId.make("environment-studio"),
          label: "Studio",
          platform: "macOS",
          sessionId: linkedSession,
          access: "allowed",
          maxRuntimeMode: "auto",
          createdAt: "2036-04-07T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
      pending: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
      </TestAppProviders>,
    );

    const linkedRow = page.getByTestId(`linked-computer-row-${linkedSession}`);
    const otherRow = page.getByTestId(`linked-computer-row-${otherSession}`);
    await expect
      .element(linkedRow)
      .toMatchTextContent("Linked computer · its agents: Allowed · Connected now");
    await expect
      .element(linkedRow.getByRole("button", { name: "Manage in Fleet", exact: true }))
      .toBeInTheDocument();
    // Same name, no link of its own: it is never mistaken for the other.
    await expect.element(otherRow).toMatchTextContent("Linked computer · Connected now");
    await expect
      .element(otherRow.getByRole("button", { name: "Manage in Fleet", exact: true }))
      .not.toBeInTheDocument();

    // Removing a linked computer's access removes its link and stops its work.
    await linkedRow.getByRole("button", { name: "Remove access", exact: true }).click();
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith({
        direction: "inbound",
        deviceId: "device-studio",
        stopRunning: true,
      });
    });
  });

  it("offers to link a computer added from the hosted app only when it has another computer", async () => {
    const windows = EnvironmentId.make("environment-windows");
    const mac = EnvironmentId.make("environment-mac");
    const linksDescriptor = (environmentId: EnvironmentId, label: string) => ({
      ...createBaseServerConfig().environment,
      environmentId,
      label,
      capabilities: { ...createBaseServerConfig().environment.capabilities, computerLinks: true },
    });
    const connectedRuntime = (environmentId: EnvironmentId, label: string) => ({
      connectionState: "connected",
      authState: "authenticated",
      lastError: null,
      lastErrorAt: null,
      role: "client",
      descriptor: linksDescriptor(environmentId, label),
      serverConfig: null,
      connectedAt: "2036-04-07T00:00:00.000Z",
      disconnectedAt: null,
      route: "relay",
      waitingToReconnect: false,
      disconnectedByUser: false,
    });
    const savedRecord = (environmentId: EnvironmentId, label: string) => ({
      environmentId,
      label,
      httpBaseUrl: `https://${environmentId}.example.test/`,
      wsBaseUrl: `wss://${environmentId}.example.test/`,
      createdAt: "2036-04-07T00:00:00.000Z",
      lastConnectedAt: "2036-04-07T00:00:00.000Z",
    });
    savedComputersHarness.addSavedEnvironment.mockImplementation(async () => {
      savedComputersHarness.registryById[windows] = savedRecord(windows, "Windows PC");
      savedComputersHarness.runtimeById[windows] = connectedRuntime(windows, "Windows PC");
      return savedRecord(windows, "Windows PC");
    });
    const addWindows = async () => {
      openConnectComputerDialog();
      const dialog = page.getByRole("dialog", { name: "Connect to a computer" });
      await dialog.getByRole("button", { name: /^Other ways to connect/ }).click();
      await dialog.getByLabelText("Computer address").fill("https://windows.example.test");
      await dialog.getByLabelText("Pairing code").fill("PAIRCODE");
      await dialog.getByRole("button", { name: "Add this computer", exact: true }).click();
      return dialog;
    };
    setServerConfigSnapshot(createBaseServerConfig());

    // Its only computer: nothing to link with, so no question.
    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectComputerDialogHost />
      </TestAppProviders>,
    );
    let dialog = await addWindows();
    await expect
      .element(dialog.getByText("Connected to Windows PC.", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(dialog.getByText("Let agents on these computers start work on each other?"))
      .not.toBeInTheDocument();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();

    // With Mac saved too: the question, naming Mac, and Link makes both directions.
    savedComputersHarness.registryById[mac] = savedRecord(mac, "Mac");
    savedComputersHarness.runtimeById[mac] = connectedRuntime(mac, "Mac");
    const invite = (environmentId: EnvironmentId, label: string) => ({
      hostId: RelayHostId.make(`host-${environmentId}`),
      relayOrigin: "https://relay.example.test",
      inviteId: RelayInviteId.make(`invite-${environmentId}`),
      inviteSecret: "secret",
      hostPublicKey: "key",
      directOrigins: [],
      environmentId,
      label,
      expiresAt: "2036-04-07T00:10:00.000Z",
    });
    const clientFor = (environmentId: EnvironmentId, label: string) => ({
      createInvite: vi.fn(async () => invite(environmentId, label)),
      accept: vi.fn(async () => ({ state: "active" })),
    });
    const macClient = clientFor(mac, "Mac");
    const windowsClient = clientFor(windows, "Windows PC");
    __setComputerLinksClientForTests(mac, macClient as unknown as ComputerLinksClient);
    __setComputerLinksClientForTests(windows, windowsClient as unknown as ComputerLinksClient);
    dialog = await addWindows();
    await expect
      .element(dialog.getByText("Let agents on these computers start work on each other?"))
      .toBeInTheDocument();
    await expect
      .element(dialog.getByRole("combobox", { name: "Link with" }))
      .toMatchTextContent("Mac");
    await dialog.getByRole("button", { name: "Link (Ask first)", exact: true }).click();
    await vi.waitFor(() => {
      expect(windowsClient.accept).toHaveBeenCalledWith({ invite: invite(mac, "Mac") });
      expect(macClient.accept).toHaveBeenCalledWith({ invite: invite(windows, "Windows PC") });
    });
    await expect.element(dialog).not.toBeInTheDocument();
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

    await openProviderDetails("Claude");
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
    await openProviderDetails("Claude");
    await expect.element(page.getByText("Chat configured")).toBeVisible();
    await expect.element(page.getByText("Usage verified")).toBeVisible();
    const advancedTokenLabel = page.getByText("Advanced: headless chat token");
    await expect.element(advancedTokenLabel).toBeVisible();
    const advancedTokenToggle = advancedTokenLabel.element().closest("summary");
    if (!advancedTokenToggle) throw new Error("Claude details panel did not render");
    await page.elementLocator(advancedTokenToggle).click();
    await expect.element(page.getByText(/Optional for remote or headless chat/)).toBeVisible();
  });

  it("says a Claude row is signed out of usage and opens its sign-in from there", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          auth: {
            status: "authenticated",
            type: "maxplan",
            label: "Claude Max Subscription",
            capabilities: {
              chat: { status: "configured" },
              usage: { status: "unavailable", reason: "signed_out" },
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

    const signedOut = page.getByRole("button", {
      name: "Claude usage. Claude is signed out. Sign in to see usage.",
    });
    await expect.element(signedOut).toMatchTextContent("Usage signed out");
    // No empty meter stands in for a reading the app does not have.
    const row = signedOut.element().closest('[data-testid="provider-instance-row"]');
    expect(row?.textContent).not.toContain("0%");

    await signedOut.click();
    await expect.element(page.getByText("Account & Sign-in")).toBeVisible();
  });

  it("does not send a Claude row to sign-in over a usage check that only failed", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          auth: {
            status: "authenticated",
            type: "maxplan",
            label: "Claude Max Subscription",
            capabilities: {
              chat: { status: "configured" },
              usage: { status: "unavailable", reason: "rate_limited" },
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

    await page
      .getByRole("button", {
        name: "Claude usage. Claude is limiting usage checks. Trying again soon.",
      })
      .click();
    // The row opens on its Usage tab, which explains it; nothing asks for a sign-in.
    await expect
      .element(page.getByText("Claude is limiting usage checks. Trying again soon."))
      .toBeVisible();
    await expect.element(page.getByText("Account & Sign-in")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("signs a provider in without leaving settings", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: { openExternal },
      server: {},
    } as unknown as LocalApi;
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

    await openProviderDetails("Claude");
    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    await expect.element(signIn).toBeVisible();
    await signIn.click();

    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([
        { instanceId: "claudeAgent", flow: "login" },
      ]);
    });

    // This panel's own run, of a command that opens its page itself.
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:00.000Z",
      type: "command",
      flow: "login",
      command: "claude auth login",
      flowId: "flow-1",
      ...(providerAuthHarness.startRequestIds[0]
        ? { requestId: providerAuthHarness.startRequestIds[0] }
        : {}),
      surface: "terminal",
      opensPageItself: true,
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

    // Claude opened the page itself: the address it prints is a link, not a second tab.
    const fallbackUrl = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:01.500Z",
      type: "output",
      data: `If the browser didn't open, visit: ${fallbackUrl}\r\n`,
    });
    const openPage = page.getByRole("button", { name: "Open sign-in page" });
    await openPage.click();
    // Opened once, by the click.
    expect(openExternal.mock.calls).toEqual([[fallbackUrl]]);

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

  it("asks Pi's sign-in questions in Settings and never shows a typed key", async () => {
    const piInstanceId = ProviderInstanceId.make("pi");
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: { openExternal },
      server: {},
    } as unknown as LocalApi;
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          instanceId: piInstanceId,
          driver: ProviderDriverKind.make("pi"),
          displayName: "Pi",
          status: "error",
          auth: { status: "unauthenticated" },
          models: [],
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [piInstanceId]: { driver: ProviderDriverKind.make("pi"), enabled: true, config: {} },
        },
      },
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await openProviderDetails("Pi", piInstanceId);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([{ instanceId: "pi", flow: "login" }]);
    });
    expect(providerAuthHarness.startQuestions).toEqual([true]);

    const at = "2026-10-20T10:00:00.000Z";
    const emit = (
      event: Parameters<typeof providerAuthHarness.emit>[0] extends infer E
        ? E extends { readonly instanceId: string; readonly createdAt: string }
          ? Omit<E, "instanceId" | "createdAt">
          : never
        : never,
    ) => providerAuthHarness.emit({ instanceId: "pi", createdAt: at, ...event } as never);
    emit({
      type: "command",
      flow: "login",
      command: "Sign in to Pi",
      flowId: "flow-1",
      surface: "browser",
    });
    emit({ type: "status", status: "running", exitCode: null, detail: null });
    emit({
      type: "question",
      flowId: "flow-1",
      requestId: "choice-1",
      kind: "choice",
      message: "Choose what Pi connects to",
      options: [
        {
          id: "oauth:openai",
          label: "OpenAI (ChatGPT subscription)",
          group: "Sign in with an account",
        },
        { id: "api_key:anthropic", label: "Anthropic", group: "Use an API key", configured: true },
        { id: "api_key:groq", label: "Groq", group: "Use an API key" },
      ],
      settled: false,
    });

    await expect.element(page.getByText("Choose what Pi connects to")).toBeVisible();
    await expect.element(page.getByText("Sign in with an account")).toBeVisible();
    await expect.element(page.getByText("Connected")).toBeVisible();
    // Pi takes a pasted address in its own question, not the shared field.
    await expect
      .element(page.getByRole("textbox", { name: "Address the browser ended on" }))
      .not.toBeInTheDocument();
    await page.getByRole("option", { name: "Groq" }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.respondCalls).toEqual([
        {
          instanceId: "pi",
          flowId: "flow-1",
          requestId: "choice-1",
          accept: true,
          value: "api_key:groq",
        },
      ]);
    });

    emit({
      type: "question",
      flowId: "flow-1",
      requestId: "choice-1",
      kind: "choice",
      message: "Choose what Pi connects to",
      settled: true,
    });
    emit({
      type: "question",
      flowId: "flow-1",
      requestId: "key-1",
      kind: "secret",
      message: "Enter Groq API key",
      settled: false,
    });
    const key = page.getByLabelText("Enter Groq API key");
    await expect.element(key).toHaveAttribute("type", "password");
    await key.fill("gsk-typed-secret");
    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.respondCalls.at(-1)).toEqual({
        instanceId: "pi",
        flowId: "flow-1",
        requestId: "key-1",
        accept: true,
        value: "gsk-typed-secret",
      });
    });
    emit({
      type: "question",
      flowId: "flow-1",
      requestId: "key-1",
      kind: "secret",
      message: "Enter Groq API key",
      settled: true,
    });
    await expect.element(page.getByLabelText("Enter Groq API key")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("gsk-typed-secret");

    // A device code stays up until the run ends, and opens nothing by itself.
    emit({
      type: "pageRequest",
      flowId: "flow-1",
      requestId: "code-1",
      url: "https://github.com/login/device",
      message: null,
      code: "ABCD-1234",
      settled: false,
    });
    await expect
      .element(page.getByTestId("provider-auth-device-code"))
      .toMatchTextContent("ABCD-1234");
    expect(openExternal).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Copy code and open page" }).click();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");
    await expect.element(page.getByTestId("provider-auth-device-code")).toBeVisible();

    emit({ type: "status", status: "succeeded", exitCode: null, detail: null });
    await expect.element(page.getByText("Signed in", { exact: true })).toBeVisible();

    // Pi's own terminal sign-in is still one click away.
    await page.getByText("Prefer your own terminal?").click();
    await expect.element(page.getByText("Then type /login and pick a provider.")).toBeVisible();
    await page.getByRole("button", { name: "Open it here" }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.startQuestions).toEqual([true, false]);
    });
  });

  it("signs a signed-out provider in from its row without opening the card first", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: { openExternal },
      server: {},
    } as unknown as LocalApi;
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

    // A command that leaves its page to Threadlines (fx in WSL prints a device
    // page and waits): the row that started the run opens it, once, though
    // the card shows the same run.
    const devicePage = "https://vercel.com/oauth/device?user_code=ROWS-1234";
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:00.000Z",
      type: "command",
      flow: "login",
      command: "fx login",
      flowId: "flow-row",
      ...(providerAuthHarness.startRequestIds[0]
        ? { requestId: providerAuthHarness.startRequestIds[0] }
        : {}),
      surface: "terminal",
      opensPageItself: false,
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
      data: `Open ${devicePage}\r\nCode: ROWS-1234\r\n`,
    });
    await vi.waitFor(() => {
      expect(openExternal.mock.calls).toEqual([[devicePage]]);
    });

    // The next run prints the same page (a fixed device page): it opens again.
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:02.000Z",
      type: "status",
      status: "failed",
      exitCode: 1,
      detail: null,
    });
    await page.getByRole("button", { name: "Sign in to Claude" }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.startRequestIds).toHaveLength(2);
    });
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:03.000Z",
      type: "command",
      flow: "login",
      command: "fx login",
      flowId: "flow-row-2",
      ...(providerAuthHarness.startRequestIds[1]
        ? { requestId: providerAuthHarness.startRequestIds[1] }
        : {}),
      surface: "terminal",
      opensPageItself: false,
    });
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:03.000Z",
      type: "status",
      status: "running",
      exitCode: null,
      detail: null,
    });
    providerAuthHarness.emit({
      instanceId: "claudeAgent",
      createdAt: "2026-08-03T00:00:04.000Z",
      type: "output",
      data: `Open ${devicePage}\r\nCode: ROWS-1234\r\n`,
    });
    await vi.waitFor(() => {
      expect(openExternal.mock.calls).toEqual([[devicePage], [devicePage]]);
    });
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

    await openProviderDetails("Antigravity");
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

  it("switches Grok to an xAI API key in one save, with no Sign out for the shared login", async () => {
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
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          displayName: "Grok",
          version: "1.0.52",
          auth: { status: "authenticated", type: "subscription", label: "Grok subscription" },
        },
      ],
    });

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    await openProviderDetails("Grok");
    await expect
      .element(page.getByRole("radio", { name: /Grok subscription/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
    // The default Grok shares ~/.grok with the terminal: Threadlines never signs it out.
    expect(page.getByRole("button", { name: "Sign out" }).elements()).toHaveLength(0);

    await page.getByRole("radio", { name: /xAI API key/ }).click();
    const switchButton = page.getByRole("button", { name: "Switch to xAI API key" });
    await expect.element(switchButton).toBeDisabled();
    await page.getByLabelText("xAI API key").fill("xai-test-key-0007");
    await switchButton.click();

    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    const saved =
      updateSettings.mock.calls[0]![0].providerInstances?.[ProviderInstanceId.make("grok")];
    expect(saved?.config).toMatchObject({ authMethod: "api-key" });
    expect(saved?.environment).toEqual([
      { name: "XAI_API_KEY", value: "xai-test-key-0007", sensitive: true },
    ]);
  });

  it("opens Grok's sign-in page only on a device Grok didn't already open it on", async () => {
    // The desktop app, whose own server runs Grok on this computer.
    window.desktopBridge = createDesktopBridgeStub();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: { openExternal },
      server: {},
    } as unknown as LocalApi;
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          ...createClaudeProvider(),
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          displayName: "Grok",
          version: "1.0.52",
          auth: { status: "authenticated", type: "subscription", label: "Grok subscription" },
        },
      ],
    });
    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );
    await openProviderDetails("Grok");

    // Grok's own run of its sign-in, which opens the page on Grok's computer.
    const runGrokSignIn = (run: number, page: string) => {
      providerAuthHarness.emit({
        instanceId: "grok",
        createdAt: "2026-08-03T00:00:00.000Z",
        type: "command",
        flow: "login",
        command: "Sign in with Grok",
        flowId: `grok-${run}`,
        ...(providerAuthHarness.startRequestIds[run]
          ? { requestId: providerAuthHarness.startRequestIds[run] }
          : {}),
        surface: "browser",
        opensPageItself: true,
      });
      providerAuthHarness.emit({
        instanceId: "grok",
        createdAt: "2026-08-03T00:00:00.000Z",
        type: "status",
        status: "running",
        exitCode: null,
        detail: null,
      });
      providerAuthHarness.emit({
        instanceId: "grok",
        createdAt: "2026-08-03T00:00:01.000Z",
        type: "output",
        data: `${page}\r\nApprove the sign-in on that page. The code is already filled in.\r\n`,
      });
    };

    // On Grok's computer: Grok opened it, so Threadlines only offers the link.
    await page.getByRole("button", { name: "Sign in again" }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.startRequestIds).toHaveLength(1);
    });
    runGrokSignIn(0, "https://accounts.x.ai/device?user_code=HERE-0001");
    await expect.element(page.getByRole("button", { name: "Open sign-in page" })).toBeVisible();

    // From another device: Threadlines opens it here.
    providerAuthHarness.emit({
      instanceId: "grok",
      createdAt: "2026-08-03T00:00:02.000Z",
      type: "status",
      status: "failed",
      exitCode: null,
      detail: "Sign-in timed out after 10 minutes. Try again.",
    });
    // The Grok card's; the community agents list below has its own Try again.
    await page.getByRole("button", { name: "Try again" }).first().click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.startRequestIds).toHaveLength(2);
    });
    // Now a browser, which can't know where the server runs. Switched only
    // now: the first run's effects ran before this click.
    Reflect.deleteProperty(window, "desktopBridge");
    const remotePage = "https://accounts.x.ai/device?user_code=AWAY-0002";
    runGrokSignIn(1, remotePage);
    await vi.waitFor(() => {
      expect(openExternal.mock.calls).toEqual([[remotePage]]);
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

    await openProviderDetails("Codex");
    await page.getByRole("button", { name: "Usage", exact: true }).click();

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

    await openProviderDetails("Claude");
    await page.getByRole("button", { name: "Usage", exact: true }).click();

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

    await openProviderDetails("Claude");
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

    await openProviderDetails("Claude");
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

  it("turns an agent off from its row and keeps the row in place until the pointer leaves", async () => {
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
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );

    const codexRow = () =>
      document.querySelector<HTMLElement>('[data-provider-instance-id="codex"]')!;
    const notInUseHeading = () =>
      [...document.querySelectorAll("h2")].find((heading) => heading.textContent === "Not in use")!;
    const sitsUnderNotInUse = () =>
      Boolean(
        notInUseHeading().compareDocumentPosition(codexRow()) & Node.DOCUMENT_POSITION_FOLLOWING,
      );

    const codexSwitch = page.getByRole("switch", { name: "Use Codex" });
    await expect.element(codexSwitch).toBeChecked();
    expect(sitsUnderNotInUse()).toBe(false);

    await codexSwitch.click();

    await expect.element(codexSwitch).not.toBeChecked();
    expect(updateSettings).toHaveBeenCalled();
    // Off, but still where it was: a wrong click is one click to undo.
    expect(sitsUnderNotInUse()).toBe(false);

    // Onto the page's lede, above the list. A plain unhover can leave the
    // pointer over a lower row once the list is long, and the row never lets go.
    await userEvent.hover(page.getByText(/^Agents run on this computer/));
    await vi.waitFor(() => {
      expect(sitsUnderNotInUse()).toBe(true);
    });
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

  it("picks the branch new worktrees start from among every project's branches", async () => {
    const environmentId = createBaseServerConfig().environment.environmentId;
    const project = (id: string, title: string) => ({
      id: ProjectId.make(id),
      kind: "workspace" as const,
      title,
      workspaceRoot: `/repo/${title}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-23T00:00:00.000Z",
      updatedAt: "2026-10-23T00:00:00.000Z",
    });
    useStore.getState().syncServerShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [project("project-api", "api"), project("project-web", "web")],
        threads: [],
        updatedAt: "2026-10-23T00:00:00.000Z",
      },
      environmentId,
    );
    const ref = (name: string, remoteName?: string) => ({
      name,
      current: false,
      isDefault: name === "main",
      worktreePath: null,
      ...(remoteName ? { isRemote: true, remoteName } : {}),
    });
    const refsByCwd: Record<string, ReturnType<typeof ref>[]> = {
      "/repo/api": [ref("main"), ref("develop"), ref("threadlines/abcd1234")],
      // Only a remote copy here: it counts as the same branch.
      "/repo/web": [ref("main"), ref("origin/develop", "origin"), ref("release/2.0")],
    };
    __setEnvironmentApiOverrideForTests(environmentId, {
      vcs: {
        listRefs: async ({ cwd }: { cwd: string }) => {
          const refs = refsByCwd[cwd] ?? [];
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: refs.length,
            refs,
          };
        },
      },
    } as unknown as EnvironmentApi);

    try {
      const updateSettings = await mountWith({});
      await page.getByRole("combobox", { name: "New worktrees start from" }).click();
      await page.getByRole("option", { name: "Another branch" }).click();
      await vi.waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith({
          newWorktreeBase: { from: "named", branch: "" },
        });
      });

      // The picker opens by itself, listing each branch once with the
      // projects that have it, and no throwaway thread branches.
      const develop = page.getByRole("option", { name: /^develop/ });
      await expect.element(develop).toBeInTheDocument();
      // Shared branches first, each with its projects; the closed "New
      // worktrees from" menu keeps its own options in the page.
      expect(
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent)
          .filter((text) => !text?.endsWith(" branch")),
      ).toEqual(["mainapi, web", "developapi, web", "release/2.0web"]);

      await develop.click();
      await vi.waitFor(() => {
        expect(updateSettings).toHaveBeenLastCalledWith({
          newWorktreeBase: { from: "named", branch: "develop" },
        });
      });
    } finally {
      __resetEnvironmentApiOverridesForTests();
      useStore.setState({ environmentStateById: {}, activeEnvironmentId: null });
    }
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

    await expect.element(page.getByText("Version control")).toBeInTheDocument();
    await expect.element(page.getByText("Source control providers")).toBeInTheDocument();
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

  it("shows the Git fetch interval as a row of its own under Git", async () => {
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

    // A place of its own, so search and place links can reach it.
    await expect
      .element(page.getByLabelText("Automatic Git fetch interval in seconds"))
      .toBeVisible();
    expect(document.querySelector('[data-place="sourceControl.fetchInterval"]')).not.toBeNull();
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

const COMMUNITY_DRIVER = ProviderDriverKind.make("acpRegistry");
const PI_INSTANCE_ID = ProviderInstanceId.make("acp_pi-acp");
const digestOf = (seed: string) => seed.repeat(64).slice(0, 64);

function createCommunityCatalogAgent(
  overrides: Partial<Record<keyof AcpRegistryCatalogAgent, unknown>> & { readonly agentId: string },
): AcpRegistryCatalogAgent {
  return {
    name: overrides.agentId,
    version: "1.0.0",
    recipeDigest: digestOf("a"),
    description: "A coding agent.",
    authors: ["Someone"],
    license: "MIT",
    website: null,
    repository: null,
    iconSvg: null,
    source: "npm",
    packageSpec: `${overrides.agentId}@1.0.0`,
    host: null,
    integrity: "package",
    ...overrides,
  } as AcpRegistryCatalogAgent;
}

function createCommunityCatalog(
  agents: ReadonlyArray<AcpRegistryCatalogAgent>,
  overrides: Partial<AcpRegistryCatalog> = {},
): AcpRegistryCatalog {
  return {
    agents,
    fetchedAt: "2026-10-05T10:00:00.000Z",
    stale: false,
    quarantineKnown: true,
    unsupportedCount: 0,
    ...overrides,
  } as AcpRegistryCatalog;
}

const PI_CATALOG_AGENT = createCommunityCatalogAgent({
  agentId: "pi-acp",
  name: "Pi",
  authors: ["Mario Zechner"],
  recipeDigest: digestOf("b"),
  packageSpec: "pi-acp@0.3.0",
  version: "0.3.0",
});

/** An installed community agent, as the server reports it and as settings hold it. */
function createCommunityProvider(
  overrides: Omit<Partial<ServerProvider>, "community"> & {
    readonly community?: Partial<ServerProviderCommunity>;
  } = {},
): ServerProvider {
  const { community, ...provider } = overrides;
  return {
    instanceId: PI_INSTANCE_ID,
    driver: COMMUNITY_DRIVER,
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "0.3.0",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-05T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...provider,
    community: {
      agentId: "pi-acp",
      authors: ["Mario Zechner"],
      website: null,
      repository: null,
      iconSvg: null,
      source: "npm",
      packageSpec: "pi-acp@0.3.0",
      host: null,
      verification: "packageRegistry",
      confirmedRecipeDigest: digestOf("b"),
      updateCandidate: null,
      reportedVersionChanged: false,
      signIn: { methods: [], selected: null, canSignOut: false },
      ...community,
    } as ServerProviderCommunity,
  } as ServerProvider;
}

function communityServerConfig(provider: ServerProvider): ServerConfig {
  const base = createBaseServerConfig();
  return {
    ...base,
    providers: [provider],
    settings: {
      ...base.settings,
      providerInstances: {
        ...base.settings.providerInstances,
        [PI_INSTANCE_ID]: {
          driver: COMMUNITY_DRIVER,
          displayName: "Pi",
          enabled: true,
          config: { agentId: "pi-acp" },
        },
      },
    },
  };
}

describe("ProviderSettingsPanel community agents", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  const mountProviders = async () => {
    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ProviderSettingsPanel />
      </TestAppProviders>,
    );
  };

  const stubServer = (server: Record<string, unknown>) => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: { openExternal },
      server,
    } as unknown as LocalApi;
    return { openExternal };
  };

  beforeEach(async () => {
    resetAppAtomRegistryForTests();
    resetServerStateForTests();
    await __resetLocalApiForTests();
    providerAuthHarness.reset();
    // Settings signs in on this app's own computer.
    __setProviderAuthClientForTests(
      null,
      providerAuthHarness.client as unknown as ProviderAuthClient,
    );
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
    resetServerStateForTests();
    await __resetLocalApiForTests();
  });

  it("lists the agents that aren't added yet, filters them, and installs only what was confirmed", async () => {
    const others = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"].map(
      (agentId) => createCommunityCatalogAgent({ agentId, name: `Agent ${agentId}` }),
    );
    const listAcpRegistryAgents = vi.fn().mockResolvedValue(
      createCommunityCatalog([
        PI_CATALOG_AGENT,
        ...others,
        // Already has a row above: not offered again.
        createCommunityCatalogAgent({ agentId: "added-agent", name: "Added Agent" }),
      ]),
    );
    const addAcpRegistryAgent = vi.fn().mockResolvedValue({ instanceId: PI_INSTANCE_ID });
    stubServer({ listAcpRegistryAgents, addAcpRegistryAgent });
    const base = createBaseServerConfig();
    setServerConfigSnapshot({
      ...base,
      settings: {
        ...base.settings,
        providerInstances: {
          [ProviderInstanceId.make("acp_added-agent")]: {
            driver: COMMUNITY_DRIVER,
            displayName: "Added Agent",
            enabled: true,
            config: { agentId: "added-agent" },
          },
        },
      },
    });

    await mountProviders();

    const piRow = page.getByTestId("community-agent-pi-acp");
    await expect.element(piRow).toBeVisible();
    await expect.element(piRow).toMatchTextContent("Pi");
    await expect.element(page.getByTestId("community-agent-alpha")).toBeVisible();
    await expect.element(page.getByTestId("community-agent-added-agent")).not.toBeInTheDocument();
    // The first look takes the server's saved copy.
    expect(listAcpRegistryAgents).toHaveBeenCalledWith({ refresh: false });

    await page.getByLabelText("Search community agents").fill("pi");
    await expect.element(page.getByTestId("community-agent-alpha")).not.toBeInTheDocument();
    await expect.element(piRow).toBeVisible();

    // Install asks first, in the row, and says who made it and what it can do.
    await piRow.getByRole("button", { name: "Install", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "Pi is made by Mario Zechner. Threadlines hasn't reviewed it. It runs on this computer and can read and change files in your projects.",
        ),
      )
      .toBeVisible();
    expect(addAcpRegistryAgent).not.toHaveBeenCalled();

    await piRow.getByRole("button", { name: "Install", exact: true }).click();
    // Named by what was on screen: the listing's digest goes with the id.
    await vi.waitFor(() => {
      expect(addAcpRegistryAgent).toHaveBeenCalledWith({
        agentId: "pi-acp",
        recipeDigest: digestOf("b"),
      });
    });
    expect(addAcpRegistryAgent).toHaveBeenCalledTimes(1);
  });

  it("scrolls a long list inside its own box, which keeps its height while a search narrows it", async () => {
    const agents = Array.from({ length: 16 }, (_, index) => {
      const number = String(index).padStart(2, "0");
      return createCommunityCatalogAgent({ agentId: `agent-${number}`, name: `Agent ${number}` });
    });
    stubServer({
      listAcpRegistryAgents: vi.fn().mockResolvedValue(createCommunityCatalog(agents)),
    });
    setServerConfigSnapshot(createBaseServerConfig());

    await mountProviders();

    await expect.element(page.getByTestId("community-agent-agent-00")).toBeVisible();
    const box = page.getByTestId("community-agent-list").element();
    const viewport = box.querySelector('[data-slot="scroll-area-viewport"]');
    if (viewport === null) throw new Error("The community list has no scrolling part.");
    // More rows than the box shows: they scroll in it, and never sideways.
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
    const height = box.getBoundingClientRect().height;

    // The install question of the last row opens below the box's edge and is brought into view.
    const last = page.getByTestId("community-agent-agent-15");
    await last.getByRole("button", { name: "Install", exact: true }).click();
    const cancel = last.getByRole("button", { name: "Cancel" });
    await expect.element(cancel).toBeVisible();
    await vi.waitFor(() => {
      expect(cancel.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
        viewport.getBoundingClientRect().bottom,
      );
    });

    // A search starts at its first match and leaves the box as tall as it was.
    await page.getByLabelText("Search community agents").fill("Agent 03");
    await expect.element(page.getByTestId("community-agent-agent-03")).toBeVisible();
    await expect.element(page.getByTestId("community-agent-agent-15")).not.toBeInTheDocument();
    await expect.element(page.getByText("1 of 16")).toBeVisible();
    expect(viewport.scrollTop).toBe(0);
    expect(box.getBoundingClientRect().height).toBe(height);
  });

  it("offers no install while the registry's quarantine list is unknown", async () => {
    const addAcpRegistryAgent = vi.fn();
    stubServer({
      listAcpRegistryAgents: vi
        .fn()
        .mockResolvedValue(createCommunityCatalog([PI_CATALOG_AGENT], { quarantineKnown: false })),
      addAcpRegistryAgent,
    });
    setServerConfigSnapshot(createBaseServerConfig());

    await mountProviders();

    await expect
      .element(
        page.getByText(
          "Couldn't check the registry's quarantine list, so nothing can be installed yet.",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByTestId("community-agent-pi-acp").getByRole("button", { name: "Install" }))
      .toBeDisabled();
    expect(addAcpRegistryAgent).not.toHaveBeenCalled();
  });

  it("keeps the rest of the page when the community list can't be read", async () => {
    // A server from before community agents: it has no such request at all.
    stubServer({});
    setServerConfigSnapshot({ ...createBaseServerConfig(), providers: [createClaudeProvider()] });

    await mountProviders();

    await expect.element(page.getByText("Couldn't read the community agent list.")).toBeVisible();
    await expect.element(page.getByLabelText("Toggle Claude details")).toBeVisible();
  });

  it("offers the built-in Pi on the community Pi row while the built-in one is off", async () => {
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    stubServer({
      listAcpRegistryAgents: vi.fn().mockResolvedValue(createCommunityCatalog([])),
      updateSettings,
    });
    setServerConfigSnapshot(
      communityServerConfig(
        createCommunityProvider({ community: { builtInDriver: ProviderDriverKind.make("pi") } }),
      ),
    );

    await mountProviders();

    const communityRow = page.elementLocator(
      await vi.waitUntil(() =>
        document.querySelector<HTMLElement>(`[data-provider-instance-id="${PI_INSTANCE_ID}"]`),
      ),
    );
    await expect.element(communityRow).toMatchTextContent("Pi is now built in");
    await communityRow.getByRole("button", { name: "Use the built-in Pi" }).click();
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(
      updateSettings.mock.calls[0]![0].providerInstances?.[ProviderInstanceId.make("pi")]?.enabled,
    ).toBe(true);
  });

  it("updates an added agent to the listing it showed, and removes it only after asking", async () => {
    const updateProvider = vi.fn().mockResolvedValue({ providers: [] });
    const removeAcpRegistryAgent = vi.fn().mockResolvedValue(undefined);
    stubServer({
      listAcpRegistryAgents: vi.fn().mockResolvedValue(createCommunityCatalog([])),
      updateProvider,
      removeAcpRegistryAgent,
    });
    setServerConfigSnapshot(
      communityServerConfig(
        createCommunityProvider({
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "0.3.0",
            latestVersion: "0.4.0",
            message: "Update available.",
            checkedAt: "2026-10-05T10:00:00.000Z",
            updateCommand: "Update Pi (Threadlines downloads it)",
            canUpdate: true,
            installCommand: null,
            canInstall: false,
          },
          community: { updateCandidate: { version: "0.4.0", recipeDigest: digestOf("c") } },
        }),
      ),
    );

    await mountProviders();

    // The tag that sets it apart from the agents Threadlines tests.
    await expect
      .element(page.getByTestId("provider-instance-row").filter({ hasText: "Community" }))
      .toMatchTextContent("Pi");
    await page.getByRole("button", { name: /^Update Pi to / }).click();
    // The new version is as unreviewed as the old, and there is no command to copy.
    await expect.element(page.getByText("Threadlines hasn't reviewed this version.")).toBeVisible();
    await expect.element(page.getByText("or, update manually using")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Update now" }).click();
    await vi.waitFor(() => {
      expect(updateProvider).toHaveBeenCalledWith({
        provider: "acpRegistry",
        instanceId: PI_INSTANCE_ID,
        recipeDigest: digestOf("c"),
      });
    });

    await openProviderDetails("Pi", PI_INSTANCE_ID);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toMatchTextContent("Remove Pi?");
    expect(removeAcpRegistryAgent).not.toHaveBeenCalled();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await vi.waitFor(() => {
      expect(removeAcpRegistryAgent).toHaveBeenCalledWith({ instanceId: PI_INSTANCE_ID });
    });
  });

  it("shows a page an agent's sign-in asks for, and opens it only on a click", async () => {
    const { openExternal } = stubServer({
      listAcpRegistryAgents: vi.fn().mockResolvedValue(createCommunityCatalog([])),
    });
    setServerConfigSnapshot(
      communityServerConfig(
        createCommunityProvider({
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Sign in to Pi to use it.",
          community: {
            signIn: {
              methods: [
                {
                  id: "oauth",
                  name: "Sign in with Pi",
                  description: null,
                  kind: "agent",
                  envVars: [],
                },
              ],
              selected: "oauth",
              canSignOut: false,
            },
          },
        }),
      ),
    );

    await mountProviders();
    await openProviderDetails("Pi", PI_INSTANCE_ID);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([
        { instanceId: PI_INSTANCE_ID, flow: "login" },
      ]);
    });

    const at = "2026-10-05T10:00:00.000Z";
    providerAuthHarness.emit({
      instanceId: PI_INSTANCE_ID,
      createdAt: at,
      type: "command",
      flow: "login",
      command: "Sign in with Pi",
      flowId: "flow-1",
      surface: "browser",
    });
    providerAuthHarness.emit({
      instanceId: PI_INSTANCE_ID,
      createdAt: at,
      type: "status",
      status: "running",
      exitCode: null,
      detail: null,
    });
    // An address the agent printed is shown, never opened for it.
    providerAuthHarness.emit({
      instanceId: PI_INSTANCE_ID,
      createdAt: at,
      type: "output",
      data: "Visit https://pi.example/printed to continue\r\n",
    });
    providerAuthHarness.emit({
      instanceId: PI_INSTANCE_ID,
      createdAt: at,
      type: "pageRequest",
      flowId: "flow-1",
      requestId: "request-1",
      url: "https://pi.example/device?code=ABCD",
      message: "Open this page to sign in to Pi.",
      settled: false,
    });

    await expect.element(page.getByText("Open this page to sign in to Pi.")).toBeVisible();
    await expect.element(page.getByText("https://pi.example/device?code=ABCD")).toBeVisible();
    expect(openExternal).not.toHaveBeenCalled();
    expect(providerAuthHarness.respondCalls).toEqual([]);

    await page.getByRole("button", { name: "Open sign-in page" }).click();
    await vi.waitFor(() => {
      expect(providerAuthHarness.respondCalls).toEqual([
        { instanceId: PI_INSTANCE_ID, flowId: "flow-1", requestId: "request-1", accept: true },
      ]);
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://pi.example/device?code=ABCD");
  });
});

describe("Agents outside Threadlines", () => {
  const THIS_COMPUTER = EnvironmentId.make("environment-local");
  const WEB = ProjectId.make("project-web");
  const API = ProjectId.make("project-api");
  const ADDRESS = "http://127.0.0.1:3773/mcp/connect";
  const ASSISTANT_ADDRESS = "https://connect.threadlines.dev/mcp";
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  function pendingRequest(
    id: string,
    overrides: Partial<OutsideAgentPendingRequest> = {},
  ): OutsideAgentPendingRequest {
    return {
      requestId: OutsideAgentRequestId.make(id),
      name: "Claude Code",
      code: "K4D-82P",
      callbackPort: 51_234,
      requestedAccess: "start",
      replaces: null,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      expiresAt: new Date(Date.now() + 290_000).toISOString(),
      ...overrides,
    };
  }

  function connection(overrides: Partial<OutsideAgentConnection> = {}): OutsideAgentConnection {
    return {
      connectionId: OutsideAgentConnectionId.make("connection-claude"),
      name: "Claude Code",
      kind: "local",
      signIn: "oauth",
      identity: null,
      access: "start",
      maxRuntimeMode: "approval-required",
      projectIds: [WEB],
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      lastUsedAt: new Date(Date.now() - 2 * 60_000 - 5_000).toISOString(),
      ...overrides,
    };
  }

  /** The assistants door open, with nothing showing or waiting. */
  function assistantsState(
    parts: Partial<OutsideAgentAssistantsState> = {},
  ): OutsideAgentAssistantsState {
    return { status: "ready", address: ASSISTANT_ADDRESS, code: null, signIns: [], ...parts };
  }

  function assistantSignIn(
    id: string,
    overrides: Partial<OutsideAgentAssistantSignIn> = {},
  ): OutsideAgentAssistantSignIn {
    return {
      requestId: OutsideAgentRequestId.make(id),
      name: "Grok Bot",
      identity: { host: "cursor.sh", verified: false, known: false },
      place: "Austin, US",
      requestedAccess: "start",
      replaces: null,
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      expiresAt: new Date(Date.now() + 295_000).toISOString(),
      ...overrides,
    };
  }

  function assistantConnection(
    id: string,
    overrides: Partial<OutsideAgentConnection> = {},
  ): OutsideAgentConnection {
    return connection({
      connectionId: OutsideAgentConnectionId.make(id),
      name: "Grok Bot",
      kind: "assistant",
      identity: { host: "cursor.sh", verified: true, known: true },
      access: "see",
      projectIds: null,
      lastUsedAt: null,
      ...overrides,
    });
  }

  function snapshot(parts: Partial<OutsideAgentsSnapshot> = {}): OutsideAgentsSnapshot {
    return {
      address: ADDRESS,
      connections: [],
      pending: [],
      quietUntil: null,
      assistants: { status: "off", address: null, code: null, signIns: [] },
      ...parts,
    };
  }

  async function mountConnectionsWithHost() {
    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <ConnectionsSettings />
        <OutsideAgentsHost />
      </TestAppProviders>,
    );
  }

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    authAccessHarness.reset();
    relayAccessHarness.reset();
    savedComputersHarness.reset();
    outsideAgentsHarness.reset();
    writePrimaryEnvironmentDescriptor({
      environmentId: THIS_COMPUTER,
      label: "Local environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, outsideAgents: true },
    });
    useStore.getState().syncServerShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [WEB, API].map((id) => ({
          id,
          kind: "workspace" as const,
          title: id === WEB ? "web" : "api",
          workspaceRoot: `/repo/${id}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        })),
        threads: [],
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      THIS_COMPUTER,
    );
    // The desktop app's own window is its computer's owner.
    window.desktopBridge = createDesktopBridgeStub();
    setServerConfigSnapshot(createBaseServerConfig());
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
    resetPrimaryEnvironmentDescriptorForTests();
    useStore.setState({ environmentStateById: {}, activeEnvironmentId: null });
    resetServerStateForTests();
    await __resetLocalApiForTests();
    outsideAgentsHarness.reset();
  });

  it("allows a sign-in to start threads in the projects picked", async () => {
    outsideAgentsHarness.emit(
      snapshot({
        pending: [
          pendingRequest("request-1", {
            replaces: { connectionId: connection().connectionId, name: "Claude Code" },
          }),
        ],
      }),
    );
    outsideAgentsHarness.client.approve.mockResolvedValue(connection());
    await mountConnectionsWithHost();

    const dialog = page.getByTestId("outside-agent-dialog");
    await expect
      .element(dialog.getByRole("heading", { name: "Claude Code wants to use Threadlines" }))
      .toBeVisible();
    await expect.element(dialog.getByTestId("outside-agent-code")).toHaveTextContent("K4D-82P");
    await expect
      .element(
        dialog.getByText("Name given by the agent. It signs in on this computer (port 51234)."),
      )
      .toBeVisible();
    await expect
      .element(dialog.getByTestId("outside-agent-replaces"))
      .toHaveTextContent("Replaces your earlier Claude Code connection.");
    // A sign-in starts at the least: see threads, every project.
    await expect.element(dialog.getByTestId("outside-agent-ceiling")).not.toBeInTheDocument();

    await dialog.getByTestId("outside-agent-access-start").click();
    await expect
      .element(dialog.getByTestId("outside-agent-ceiling"))
      .toHaveTextContent("Supervised");
    await dialog.getByTestId("outside-agent-projects-some").click();
    // Nothing ticked yet: nothing to allow.
    await expect.element(dialog.getByTestId("outside-agent-allow")).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "web" }).click();
    await dialog.getByTestId("outside-agent-allow").click();

    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.approve).toHaveBeenCalledWith({
        requestId: "request-1",
        access: "start",
        maxRuntimeMode: "approval-required",
        projectIds: [WEB],
      });
    });
    await expect.element(page.getByTestId("outside-agent-dialog")).not.toBeInTheDocument();
  });

  it("denies one sign-in, denies the rest, then takes requests again", async () => {
    outsideAgentsHarness.emit(
      snapshot({
        pending: [
          pendingRequest("request-1"),
          pendingRequest("request-2", { name: "Gemini CLI", requestedAccess: "see" }),
          pendingRequest("request-3", { name: "Codex" }),
        ],
      }),
    );
    await mountConnectionsWithHost();

    const dialog = page.getByTestId("outside-agent-dialog");
    await expect.element(dialog.getByText("2 more waiting")).toBeVisible();
    await dialog.getByTestId("outside-agent-deny").click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.deny).toHaveBeenCalledWith({ requestId: "request-1" });
    });

    // The next one asked only to see threads: it can't be allowed to start them.
    await expect
      .element(dialog.getByRole("heading", { name: "Gemini CLI wants to use Threadlines" }))
      .toBeVisible();
    await expect
      .element(dialog.getByTestId("outside-agent-access-start"))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(dialog.getByText("It only asked to see threads.")).toBeVisible();
    await expect.element(dialog.getByText("1 more waiting")).toBeVisible();

    await dialog.getByTestId("outside-agent-deny-all").click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.denyAll).toHaveBeenCalledTimes(1);
    });
    await expect.element(page.getByTestId("outside-agent-dialog")).not.toBeInTheDocument();

    outsideAgentsHarness.emit(
      snapshot({ quietUntil: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString() }),
    );
    const quiet = page.getByTestId("outside-agents-quiet");
    await expect.element(quiet).toMatchTextContent("Not taking new agent sign-ins (10 min left)");
    await quiet.getByRole("button", { name: "Take requests again" }).click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.resumeRequests).toHaveBeenCalledTimes(1);
    });
    await expect.element(page.getByTestId("outside-agents-quiet")).not.toBeInTheDocument();
  });

  it("changes what a connection may do, and removes it after asking", async () => {
    const claude = connection();
    outsideAgentsHarness.emit(snapshot({ connections: [claude] }));
    outsideAgentsHarness.client.update.mockImplementation(
      async (input: { access: "see" | "start" }) => ({ ...claude, ...input }),
    );
    await mountConnectionsWithHost();

    await expect.element(page.getByTestId("outside-agents-address")).toHaveTextContent(ADDRESS);
    const row = page.getByTestId(`outside-agent-row-${claude.connectionId}`);
    await expect.element(row).toMatchTextContent("Starts threads · Supervised · web · Used 2m ago");

    await row.getByRole("button", { name: "Change", exact: true }).click();
    const dialog = page.getByTestId("outside-agent-dialog");
    await expect
      .element(dialog.getByRole("heading", { name: "Change what Claude Code can do" }))
      .toBeVisible();
    await expect.element(dialog.getByTestId("outside-agent-code")).not.toBeInTheDocument();
    await expect.element(dialog.getByRole("checkbox", { name: "web" })).toBeChecked();
    await dialog.getByTestId("outside-agent-access-see").click();
    await dialog.getByTestId("outside-agent-save").click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.update).toHaveBeenCalledWith({
        connectionId: claude.connectionId,
        access: "see",
        maxRuntimeMode: "approval-required",
        projectIds: [WEB],
      });
    });
    await expect.element(page.getByTestId("outside-agent-dialog")).not.toBeInTheDocument();
    await expect.element(row).toMatchTextContent("Sees threads · web · Used 2m ago");

    await row.getByRole("button", { name: "Remove access", exact: true }).click();
    await expect.element(page.getByText("Remove access for Claude Code?")).toBeVisible();
    expect(outsideAgentsHarness.client.remove).not.toHaveBeenCalled();
    await page.getByTestId("outside-agent-remove-confirm").click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.remove).toHaveBeenCalledWith({
        connectionId: claude.connectionId,
      });
    });
    await expect
      .element(page.getByTestId(`outside-agent-row-${claude.connectionId}`))
      .not.toBeInTheDocument();
  });

  it("installs the desktop app's threadlines command over another copy, and Cancel on Remove keeps it", async () => {
    const path = "/usr/local/bin/threadlines";
    let status: DesktopCliCommandStatus = {
      state: "other_copy",
      path,
      folderOnPath: true,
      reason: null,
      devCommand: null,
    };
    const installCliCommand = vi.fn(async (): Promise<DesktopCliCommandResult> => {
      status = { ...status, state: "installed" };
      return { outcome: "done", detail: null, status };
    });
    // The system's administrator prompt, cancelled: nothing changes.
    const removeCliCommand = vi.fn(async (): Promise<DesktopCliCommandResult> => ({
      outcome: "cancelled",
      detail: null,
      status,
    }));
    window.desktopBridge = {
      ...createDesktopBridgeStub(),
      getCliCommandStatus: async () => status,
      installCliCommand,
      removeCliCommand,
    };
    outsideAgentsHarness.emit(snapshot());
    await mountConnectionsWithHost();

    const row = page.getByTestId("threadlines-command");
    await expect.element(row).toMatchTextContent(`${path} points at another copy of Threadlines.`);
    await row.getByRole("button", { name: "Install again" }).click();
    await expect
      .element(row)
      .toMatchTextContent(`Installed at ${path}. Run threadlines connect in a new terminal`);
    expect(installCliCommand).toHaveBeenCalledTimes(1);

    await row.getByRole("button", { name: "Remove" }).click();
    await vi.waitFor(() => {
      expect(removeCliCommand).toHaveBeenCalledTimes(1);
    });
    await expect.element(row.getByRole("button", { name: "Remove" })).toBeEnabled();
    await expect.element(row).toMatchTextContent(`Installed at ${path}`);
  });

  it("shows a device that isn't the computer's owner neither the group nor a sign-in", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (String(input).endsWith("/api/auth/session")) {
          return Response.json({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "client",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          });
        }
        throw new Error(`Unhandled fetch GET ${String(input)}`);
      }),
    );
    outsideAgentsHarness.emit(
      snapshot({
        pending: [pendingRequest("request-1")],
        assistants: assistantsState({ signIns: [assistantSignIn("request-grok")] }),
      }),
    );
    await mountConnectionsWithHost();

    await expect.element(page.getByText("Owner only")).toBeVisible();
    await expect.element(page.getByTestId("outside-agents-section")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("assistants-section")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("outside-agent-dialog")).not.toBeInTheDocument();
    expect(outsideAgentsHarness.listenerCount()).toBe(0);
  });

  it("gives assistants their own group: the address to paste, and each connection with how it signs in", async () => {
    const claude = connection();
    const grok = assistantConnection("connection-grok", {
      lastUsedAt: new Date(Date.now() - 5 * 60_000 - 5_000).toISOString(),
    });
    const muse = assistantConnection("connection-muse", {
      name: "Muse",
      signIn: "key",
      identity: null,
    });
    outsideAgentsHarness.emit(
      snapshot({ connections: [grok, muse, claude], assistants: assistantsState() }),
    );
    await mountConnectionsWithHost();

    const assistants = page.getByTestId("assistants-section");
    await expect
      .element(assistants.getByTestId("assistants-address"))
      .toHaveTextContent(ASSISTANT_ADDRESS);
    await expect
      .element(assistants.getByText("Paste this into your assistant as a custom connector."))
      .toBeVisible();
    await expect
      .element(assistants.getByRole("button", { name: "Copy the address for assistants" }))
      .toBeVisible();
    // Local agents stay in the Agents group; assistants list here, with how each signs in.
    const agents = page.getByTestId("outside-agents-section");
    await expect
      .element(agents.getByTestId(`outside-agent-row-${claude.connectionId}`))
      .toBeVisible();
    await expect
      .element(agents.getByTestId(`outside-agent-row-${grok.connectionId}`))
      .not.toBeInTheDocument();
    await expect
      .element(assistants.getByTestId(`outside-agent-row-${claude.connectionId}`))
      .not.toBeInTheDocument();
    await expect
      .element(assistants.getByTestId(`outside-agent-row-${grok.connectionId}`))
      .toMatchTextContent("Signs in from cursor.sh · Sees threads · All projects · Used 5m ago");
    await expect
      .element(assistants.getByTestId(`outside-agent-row-${muse.connectionId}`))
      .toMatchTextContent("Key · Sees threads · All projects · Not used yet");

    // The door shut, or the relay out of reach: why, and nothing to press.
    outsideAgentsHarness.emit(
      snapshot({
        connections: [grok],
        assistants: assistantsState({ status: "off", address: null }),
      }),
    );
    await expect
      .element(assistants.getByText("Assistants are turned off on this computer's relay."))
      .toBeVisible();
    await expect.element(assistants.getByTestId("assistants-address")).not.toBeInTheDocument();
    await expect.element(assistants.getByTestId("assistants-connect")).toBeDisabled();
    await expect.element(assistants.getByTestId("assistants-create-key")).toBeDisabled();
    outsideAgentsHarness.emit(
      snapshot({ assistants: assistantsState({ status: "unreachable", address: null }) }),
    );
    await expect
      .element(assistants.getByText("Can't reach the relay right now. Threadlines keeps trying."))
      .toBeVisible();
    await expect.element(assistants.getByTestId("assistants-connect")).toBeDisabled();
  });

  it("shows an assistant's sign-in code with its warning, cancels it, and offers a new one once it runs out", async () => {
    outsideAgentsHarness.emit(snapshot({ assistants: assistantsState() }));
    outsideAgentsHarness.client.assistantCode.mockImplementation(async () => ({
      code: "K4D82PQX",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }));
    await mountConnectionsWithHost();

    const assistants = page.getByTestId("assistants-section");
    await assistants.getByRole("button", { name: "Connect an assistant" }).click();
    const row = assistants.getByTestId("assistant-code-row");
    await expect.element(row.getByTestId("assistant-code")).toHaveTextContent("K4D8-2PQX");
    await expect
      .element(row)
      .toMatchTextContent(
        "Type this only into the Threadlines page your assistant just opened. Never give it to anyone.",
      );
    await expect
      .element(row.getByTestId("assistant-code-countdown"))
      .toMatchTextContent(/Expires in (10:00|9:5\d)/);
    await row.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.assistantCodeCancel).toHaveBeenCalledTimes(1);
    });
    await expect.element(assistants.getByTestId("assistant-code-row")).not.toBeInTheDocument();
    await expect
      .element(assistants.getByRole("button", { name: "Connect an assistant" }))
      .toBeEnabled();

    outsideAgentsHarness.emit(
      snapshot({
        assistants: assistantsState({
          code: { code: "M7Q2R9TX", expiresAt: new Date(Date.now() - 1_000).toISOString() },
        }),
      }),
    );
    const expired = assistants.getByTestId("assistant-code-expired");
    await expect.element(expired).toMatchTextContent("This code expired.");
    await expired.getByRole("button", { name: "Show a new code" }).click();
    await expect.element(assistants.getByTestId("assistant-code")).toHaveTextContent("K4D8-2PQX");
    expect(outsideAgentsHarness.client.assistantCode).toHaveBeenCalledTimes(2);
  });

  it("turns the code into an assistant's sign-in, says who it is and where its page was opened, and allows it", async () => {
    outsideAgentsHarness.emit(
      snapshot({
        assistants: assistantsState({
          code: { code: "K4D82PQX", expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() },
        }),
      }),
    );
    outsideAgentsHarness.client.approve.mockResolvedValue(assistantConnection("connection-grok"));
    await mountConnectionsWithHost();
    await expect.element(page.getByTestId("assistant-code")).toHaveTextContent("K4D8-2PQX");

    // Its page typed the code: the server drops the code, and the sign-in
    // waits ahead of a local agent's that came after it.
    outsideAgentsHarness.emit(
      snapshot({
        pending: [
          pendingRequest("request-local", {
            createdAt: new Date(Date.now() - 1_000).toISOString(),
          }),
        ],
        assistants: assistantsState({ signIns: [assistantSignIn("request-grok")] }),
      }),
    );
    const dialog = page.getByTestId("outside-agent-dialog");
    await expect
      .element(dialog.getByRole("heading", { name: "Grok Bot wants to use Threadlines" }))
      .toBeVisible();
    await expect
      .element(dialog.getByTestId("outside-agent-identity"))
      .toHaveTextContent("Name given by the assistant. Sign-in returns to cursor.sh.");
    await expect
      .element(dialog.getByTestId("outside-agent-unknown"))
      .toHaveTextContent(
        "Threadlines doesn't know this assistant. Only allow it if you added it yourself.",
      );
    await expect
      .element(dialog.getByTestId("outside-agent-place"))
      .toHaveTextContent("The sign-in page was opened near Austin, US.");
    await expect.element(dialog.getByTestId("outside-agent-code")).not.toBeInTheDocument();
    await expect.element(dialog.getByText("1 more waiting")).toBeVisible();
    // The code was used, not run out.
    await expect.element(page.getByTestId("assistant-code-row")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("assistant-code-expired")).not.toBeInTheDocument();

    await dialog.getByTestId("outside-agent-access-start").click();
    await dialog.getByTestId("outside-agent-allow").click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.approve).toHaveBeenCalledWith({
        requestId: "request-grok",
        access: "start",
        maxRuntimeMode: "approval-required",
        projectIds: null,
      });
    });
    await expect
      .element(dialog.getByRole("heading", { name: "Claude Code wants to use Threadlines" }))
      .toBeVisible();
  });

  it("creates a key, shows it once with the address, and lets it go after Done", async () => {
    const KEY = "tlak1.host-1.connection-muse.tag.secret-value";
    const muse = assistantConnection("connection-muse", {
      name: "Muse",
      signIn: "key",
      identity: null,
    });
    outsideAgentsHarness.emit(snapshot({ assistants: assistantsState() }));
    outsideAgentsHarness.client.createKey.mockResolvedValue({
      connection: muse,
      key: KEY,
      address: ASSISTANT_ADDRESS,
    });
    await mountConnectionsWithHost();

    await page.getByTestId("assistants-create-key").click();
    const form = page.getByTestId("assistant-key-dialog");
    await expect.element(form.getByTestId("assistant-key-create")).toBeDisabled();
    await form.getByTestId("assistant-key-name").fill("  Muse ");
    await form.getByTestId("assistant-key-create").click();
    await vi.waitFor(() => {
      expect(outsideAgentsHarness.client.createKey).toHaveBeenCalledWith({
        name: "Muse",
        access: "see",
        maxRuntimeMode: "approval-required",
        projectIds: null,
      });
    });

    const made = page.getByTestId("assistant-key-made");
    await expect.element(made.getByTestId("assistant-key-value")).toHaveTextContent(KEY);
    await expect
      .element(made.getByTestId("assistant-key-address"))
      .toHaveTextContent(ASSISTANT_ADDRESS);
    await expect
      .element(made.getByText("You won't see this key again. Paste both into your assistant."))
      .toBeVisible();
    await made.getByRole("button", { name: "Done" }).click();
    await expect.element(page.getByTestId("assistant-key-made")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
    await expect
      .element(page.getByTestId(`outside-agent-row-${muse.connectionId}`))
      .toMatchTextContent("Key · Sees threads · All projects · Not used yet");

    // Opening it again starts a new key; the last one is gone.
    await page.getByTestId("assistants-create-key").click();
    await expect.element(page.getByTestId("assistant-key-name")).toHaveValue("");
    expect(document.body.textContent).not.toContain(KEY);
  });
});

describe("Settings search", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    localStorage.clear();
    useSettingsSearchStore.getState().clear();
  });

  afterEach(async () => {
    await mounted?.unmount().catch(() => {});
    mounted = null;
    useSettingsSearchStore.getState().clear();
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
  });

  it("finds settings, changes one where it stands, narrows from the menu and opens the page at a setting", async () => {
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: { updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS) },
    } as unknown as LocalApi;
    setServerConfigSnapshot(createBaseServerConfig());

    // Stands in for the settings layout: the menu, the results while there is
    // a query, and the page with its place arrival.
    function ResultsWhileSearching() {
      return useSettingsSearchActive() ? <SettingsSearchResultsBody /> : null;
    }
    function SettingsPage({ children }: { children: ReactNode }) {
      usePlaceArrival();
      return children;
    }
    const rootRoute = createRootRoute({
      component: () => (
        <TestAppProviders>
          <SidebarProvider>
            <SettingsSidebarNav pathname="/settings/general" />
            <ResultsWhileSearching />
            <Outlet />
          </SidebarProvider>
        </TestAppProviders>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/settings/general",
          component: () => (
            <SettingsPage>
              <GeneralSettingsPanel />
            </SettingsPage>
          ),
        }),
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/settings/archived",
          component: () => <div>Archives page</div>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
    });
    mounted = await render(<RouterProvider router={router} />);

    const field = page.getByRole("textbox", { name: "Search settings" });
    await field.fill("wrap");
    const results = page.getByTestId("settings-search-results");
    await expect.element(results).toBeInTheDocument();
    await expect
      .element(page.getByText("4 matches for “wrap”.", { exact: false }))
      .toBeInTheDocument();

    // A result is the setting's own switch: it changes the setting the page shows too.
    const resultSwitch = results.getByRole("switch", { name: "Wrap diff lines by default" });
    const pageSwitch = () =>
      document.querySelector<HTMLElement>(
        '[data-place="general.wrapDiffLines"]:not([data-testid="settings-search-results"] *) [role="switch"]',
      );
    const before = resultSwitch.element().getAttribute("aria-checked");
    await resultSwitch.click();
    await vi.waitFor(() => {
      expect(resultSwitch.element().getAttribute("aria-checked")).not.toBe(before);
      expect(pageSwitch()?.getAttribute("aria-checked")).not.toBe(before);
    });

    // The menu keeps every section; one with matches narrows the results to itself.
    const menuButton = (label: string) =>
      page.elementLocator(
        [...document.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]')].find((button) =>
          button.textContent?.startsWith(label),
        )!,
      );
    expect(menuButton("Threads").element().textContent).toBe("Threads3");
    await menuButton("Threads").click();
    await expect
      .element(page.getByText("3 of 4 matches for “wrap”, in Threads.", { exact: false }))
      .toBeInTheDocument();

    // One without matches leaves the search for its page.
    await menuButton("Archives").click();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/archived"));
    expect(useSettingsSearchStore.getState().query).toBe("");

    // The line under a result opens its page at the setting, highlighted there.
    await router.navigate({ to: "/settings/general" });
    await field.fill("font size");
    await page.getByRole("button", { name: "Open General › Terminal" }).click();
    await vi.waitFor(() => {
      expect(router.state.location.hash).toContain("place=general.terminalTextSize");
      expect(
        document.querySelector('[data-place="general.terminalTextSize"] > .place-arrival-overlay'),
      ).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="settings-search-results"]')).toBeNull();
  });
});

describe("Settings search rows", () => {
  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    resetSourceControlDiscoveryStateForTests();
    localStorage.clear();
  });

  afterEach(async () => {
    Reflect.deleteProperty(window, "nativeApi");
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
  });

  // The drift check's rendered half (docs/design/settings-search.md): every
  // live row draws its own place, alone as a result does, and a page draws
  // exactly the live rows the search says are shown here.
  it("draws every live row as its own place, alone and on its page", async () => {
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
        discoverSourceControl: async (): Promise<SourceControlDiscoveryResult> => ({
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
          sourceControlProviders: [],
        }),
        getSourceControlSetup: async () => ({
          tools: [],
          githubAuth: { status: "idle", verificationUrl: null, userCode: null, message: null },
        }),
      },
    } as unknown as LocalApi;
    setServerConfigSnapshot(createBaseServerConfig());

    let shown: ((id: SettingsPlaceSearchId) => boolean) | null = null;
    function ReadShown() {
      shown = useSettingsPlaceShown();
      return null;
    }
    const liveRows = Object.entries(SETTINGS_ROWS).flatMap(([id, entry]) =>
      entry.kind === "live" ? [{ id: id as SettingsRowPlaceId, Row: entry.Row }] : [],
    );
    const drawn = (id: string) => document.querySelector(`[data-place="${id}"]`) !== null;

    for (const [page, Panel] of [
      ["settings.general", GeneralSettingsPanel],
      ["settings.threads", ThreadsSettingsPanel],
      ["settings.sourceControl", SourceControlSettingsPanel],
    ] as const) {
      const screen = await renderWithTestRouter(
        <TestAppProviders>
          <SettingsPlaceSignalsProvider>
            <ReadShown />
            <Panel />
          </SettingsPlaceSignalsProvider>
        </TestAppProviders>,
      );
      const onPage = liveRows.filter(({ id }) => placePage(id).id === page);
      await vi.waitFor(() => {
        for (const { id } of onPage) expect(drawn(id), id).toBe(shown!(id));
      });
      await screen.unmount();
    }

    // Alone, as a result draws it: every live row, whatever this fixture's
    // pages show, so a registry entry naming the wrong component can't hide.
    // The background rows read the desktop app's options, so they get one.
    const desktopBackground = new Set<string>([
      "general.keepAwakeForScheduledTasks",
      "general.runInBackground",
    ]);
    const backgroundOptions = {
      keepAwakeForScheduledTasks: false,
      runInBackground: false,
      runInBackgroundSupported: true,
    };
    // Drawn only while a speech model is downloaded, which only the dictation
    // server's stream reports; the pages above cover its rule.
    const cannotDrawAlone = new Set<string>(["general.downloadedModels"]);
    let drawnAlone = 0;
    for (const { id, Row } of liveRows) {
      if (cannotDrawAlone.has(id)) continue;
      if (desktopBackground.has(id)) {
        window.desktopBridge = {
          getBackgroundOptions: async () => backgroundOptions,
          setBackgroundOptions: async () => backgroundOptions,
        } as unknown as DesktopBridge;
      }
      const alone = await renderWithTestRouter(
        <TestAppProviders>
          <SettingsGroup data-testid="alone">
            <Row />
          </SettingsGroup>
        </TestAppProviders>,
      );
      await vi.waitFor(() =>
        expect(
          document.querySelector(`[data-testid="alone"] [data-place="${id}"]`),
          id,
        ).not.toBeNull(),
      );
      drawnAlone += 1;
      await alone.unmount();
      Reflect.deleteProperty(window, "desktopBridge");
    }
    expect(drawnAlone).toBe(liveRows.length - cannotDrawAlone.size);
  });
});
