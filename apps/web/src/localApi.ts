import type { ContextMenuItem, LocalApi } from "@threadlines/contracts";

import { resetGitStatusStateForTests } from "./lib/gitStatusState";
import { resetSourceControlDiscoveryStateForTests } from "./lib/sourceControlDiscoveryState";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { resetServerStateForTests } from "./rpc/serverState";
import { resetWsConnectionStateForTests } from "./rpc/wsConnectionState";
import {
  readBackendEnvironmentConnection,
  resetEnvironmentServiceForTests,
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
} from "./environments/runtime";
import { type WsRpcClient } from "./rpc/wsRpcClient";
import { showContextMenuFallback } from "./contextMenuFallback";
import {
  readBrowserClientSettings,
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
  writeBrowserClientSettings,
  writeBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentSecret,
} from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

function createBrowserLocalApi(resolveRpcClient?: () => WsRpcClient | null): LocalApi {
  // Resolved per call, not captured: the hosted app's backend is whichever
  // computer is currently paired, and that can change while the app is open.
  const withClient = async <A>(run: (client: WsRpcClient) => Promise<A>): Promise<A> => {
    const client = resolveRpcClient?.() ?? null;
    if (!client) {
      throw unavailableLocalBackendError();
    }
    return run(client);
  };
  const withServer = <A>(run: (server: WsRpcClient["server"]) => Promise<A>): Promise<A> =>
    withClient((client) => run(client.server));

  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: (cwd, editor) =>
        withClient((client) => client.shell.openInEditor({ cwd, editor })),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
      getSavedEnvironmentRegistry: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentRegistry();
        }
        return readBrowserSavedEnvironmentRegistry();
      },
      setSavedEnvironmentRegistry: async (records) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentRegistry(records);
        }
        writeBrowserSavedEnvironmentRegistry(records);
      },
      getSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentSecret(environmentId);
        }
        return readBrowserSavedEnvironmentSecret(environmentId);
      },
      setSavedEnvironmentSecret: async (environmentId, secret) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentSecret(environmentId, secret);
        }
        return writeBrowserSavedEnvironmentSecret(environmentId, secret);
      },
      removeSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.removeSavedEnvironmentSecret(environmentId);
        }
        removeBrowserSavedEnvironmentSecret(environmentId);
      },
    },
    server: {
      getConfig: () => withServer((server) => server.getConfig()),
      refreshProviders: (input) =>
        withServer((server) =>
          input ? server.refreshProviders(input) : server.refreshProviders(),
        ),
      consumeProviderRateLimitResetCredit: (input) =>
        withServer((server) => server.consumeProviderRateLimitResetCredit(input)),
      updateProvider: (input) => withServer((server) => server.updateProvider(input)),
      resolveProviderUpdateBlockers: (input) =>
        withServer((server) => server.resolveProviderUpdateBlockers(input)),
      upsertKeybinding: (input) => withServer((server) => server.upsertKeybinding(input)),
      removeKeybinding: (input) => withServer((server) => server.removeKeybinding(input)),
      getSettings: () => withServer((server) => server.getSettings()),
      updateSettings: (patch) => withServer((server) => server.updateSettings(patch)),
      discoverSourceControl: () => withServer((server) => server.discoverSourceControl()),
      getTraceDiagnostics: () => withServer((server) => server.getTraceDiagnostics()),
      getProcessDiagnostics: () => withServer((server) => server.getProcessDiagnostics()),
      getProcessResourceHistory: (input) =>
        withServer((server) => server.getProcessResourceHistory(input)),
      signalProcess: (input) => withServer((server) => server.signalProcess(input)),
      resolveBackgroundRuns: (input) => withServer((server) => server.resolveBackgroundRuns(input)),
      stopBackgroundRun: (input) => withServer((server) => server.stopBackgroundRun(input)),
      getProviderExtensions: (input) => withServer((server) => server.getProviderExtensions(input)),
      startProviderExtensionMcpOAuth: (input) =>
        withServer((server) => server.startProviderExtensionMcpOAuth(input)),
      getProviderExtensionOperationStatus: (input) =>
        withServer((server) => server.getProviderExtensionOperationStatus(input)),
      reloadProviderExtensionMcpServers: (input) =>
        withServer((server) => server.reloadProviderExtensionMcpServers(input)),
      setProviderExtensionSkillEnabled: (input) =>
        withServer((server) => server.setProviderExtensionSkillEnabled(input)),
      readProviderExtensionSkill: (input) =>
        withServer((server) => server.readProviderExtensionSkill(input)),
      readProviderExtensionPlugin: (input) =>
        withServer((server) => server.readProviderExtensionPlugin(input)),
      installProviderExtensionPlugin: (input) =>
        withServer((server) => server.installProviderExtensionPlugin(input)),
      uninstallProviderExtensionPlugin: (input) =>
        withServer((server) => server.uninstallProviderExtensionPlugin(input)),
      setProviderExtensionPluginEnabled: (input) =>
        withServer((server) => server.setProviderExtensionPluginEnabled(input)),
      updateProviderExtensionPlugin: (input) =>
        withServer((server) => server.updateProviderExtensionPlugin(input)),
      refreshProviderExtensionPluginMarketplaces: (input) =>
        withServer((server) => server.refreshProviderExtensionPluginMarketplaces(input)),
      addProviderExtensionMarketplace: (input) =>
        withServer((server) => server.addProviderExtensionMarketplace(input)),
      removeProviderExtensionMarketplace: (input) =>
        withServer((server) => server.removeProviderExtensionMarketplace(input)),
      callProviderExtensionMcpTool: (input) =>
        withServer((server) => server.callProviderExtensionMcpTool(input)),
      readProviderExtensionMcpResource: (input) =>
        withServer((server) => server.readProviderExtensionMcpResource(input)),
      getProviderInstructionFiles: (input) =>
        withServer((server) => server.getProviderInstructionFiles(input)),
      writeProviderInstructionFile: (input) =>
        withServer((server) => server.writeProviderInstructionFile(input)),
    },
  };
}

export function createLocalApi(rpcClient: WsRpcClient): LocalApi {
  return createBrowserLocalApi(() => rpcClient);
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  cachedApi = createBrowserLocalApi(() => readBackendEnvironmentConnection()?.client ?? null);
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  await resetEnvironmentServiceForTests();
  resetGitStatusStateForTests();
  resetSourceControlDiscoveryStateForTests();
  resetRequestLatencyStateForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
}
