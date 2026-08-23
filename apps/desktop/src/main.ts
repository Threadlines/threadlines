import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as NetService from "@threadlines/shared/Net";
import { resolveRemoteThreadlinesCliPackageSpec } from "@threadlines/ssh/command";
import type { RemoteThreadlinesRunnerOptions } from "@threadlines/ssh/tunnel";
import serverPackageJson from "../../server/package.json" with { type: "json" };

import type { DesktopSettings as DesktopSettingsValue } from "./settings/DesktopAppSettings.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as DesktopSecretStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronGlobalShortcut from "./electron/ElectronGlobalShortcut.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronSpelling from "./electron/ElectronSpelling.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronTray from "./electron/ElectronTray.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopAppIdentity from "./app/DesktopAppIdentity.ts";
import * as DesktopCrashReport from "./app/DesktopCrashReport.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopAssets from "./app/DesktopAssets.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopDatabaseRecovery from "./backend/DesktopDatabaseRecovery.ts";
import * as DesktopBackendManager from "./backend/DesktopBackendManager.ts";
import * as DesktopDataMigration from "./app/DesktopDataMigration.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopServerExposure from "./backend/DesktopServerExposure.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopSavedEnvironments from "./settings/DesktopSavedEnvironments.ts";
import * as DesktopScreenCapture from "./screenCapture/DesktopScreenCapture.ts";
import * as LocalServers from "./preview/LocalServers.ts";
import * as PreviewAutomation from "./preview/PreviewAutomation.ts";
import * as PreviewSession from "./preview/PreviewSession.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "./shell/DesktopShellEnvironment.ts";
import * as DesktopSshEnvironment from "./ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopSshRemoteApi from "./ssh/DesktopSshRemoteApi.ts";
import * as DesktopRelay from "./relay/DesktopRelay.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";
import * as DesktopStartupFailurePrompt from "./window/DesktopStartupFailurePrompt.ts";
import * as DesktopStatusIndicator from "./window/DesktopStatusIndicator.ts";
import {
  readDesktopUserDataConfigFromEnv,
  resolveDesktopUserDataLocation,
  resolveDesktopUserDataPath,
} from "./app/desktopUserData.ts";
import {
  readSingleInstanceGateConfigFromEnv,
  resolvePrimaryReadinessProbeUrl,
  resolveServerRuntimeStatePath,
  shouldRequestSingleInstanceLock,
} from "./app/singleInstanceGate.ts";

// userData must be final before Electron's "ready" event: Chromium spawns its
// sandboxed helper processes (GPU, network service) at ready with sandbox
// profiles derived from the then-current userData path, and the async startup
// effect below loses that race. See desktopUserData.ts.
Electron.app.setPath(
  "userData",
  resolveDesktopUserDataPath({
    location: resolveDesktopUserDataLocation({
      platform: process.platform,
      homeDirectory: NodeOS.homedir(),
      config: readDesktopUserDataConfigFromEnv(process.env),
      path: NodePath,
    }),
    path: NodePath,
    directoryExists: NodeFS.existsSync,
  }),
);

// Ordering matters: Electron scopes the single-instance lock to the current
// userData path and creates that directory as it acquires the lock, so the
// request has to come after the setPath above. Asking first would both lock the
// wrong path and pre-create a directory the legacy-directory probe reads.
const isPrimaryInstance = shouldRequestSingleInstanceLock(
  readSingleInstanceGateConfigFromEnv(process.env),
)
  ? Electron.app.requestSingleInstanceLock()
  : true;

// How long a denied launch waits for the primary's backend to answer before
// concluding the primary is wedged rather than merely busy.
const PRIMARY_READINESS_PROBE_TIMEOUT_MS = 2500;

/**
 * A denied secondary launch's whole job. Losing the lock already told the
 * primary to raise its window, so when that primary is demonstrably healthy the
 * right behavior is the silent hand-off every single-instance app does. The
 * dialog is reserved for the case it was designed for — a primary that holds
 * the lock but does not answer — because `showErrorBox` blocks this process
 * until dismissed, and a dialog nobody notices would otherwise leave an idle
 * Threadlines lingering in Task Manager.
 */
async function exitAfterSecondaryInstanceHandoff(): Promise<void> {
  const probeUrl = resolvePrimaryReadinessProbeUrl(
    (() => {
      try {
        return NodeFS.readFileSync(
          resolveServerRuntimeStatePath({
            env: process.env,
            homeDirectory: NodeOS.homedir(),
            path: NodePath,
          }),
          "utf8",
        );
      } catch {
        return undefined;
      }
    })(),
  );

  let primaryIsHealthy = false;
  if (probeUrl !== undefined) {
    try {
      const response = await fetch(probeUrl, {
        signal: AbortSignal.timeout(PRIMARY_READINESS_PROBE_TIMEOUT_MS),
      });
      primaryIsHealthy = response.ok;
    } catch {
      primaryIsHealthy = false;
    }
  }

  if (primaryIsHealthy) {
    Electron.app.exit(0);
    return;
  }

  // Safe before "ready": showErrorBox is the one dialog Electron allows early.
  Electron.dialog.showErrorBox(
    "Threadlines is already running",
    "Another Threadlines process is already running on this computer but is not responding. It may be showing a startup error dialog. Check the taskbar and Alt+Tab first. Otherwise quit Threadlines from Task Manager (use the Details tab on Windows) or Activity Monitor (Mac) and try again.",
  );
  Electron.app.exit(1);
}

if (!isPrimaryInstance) {
  void exitAfterSecondaryInstanceHandoff();
}

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform: process.platform,
      processArch: process.arch,
      ...metadata,
    });
  }),
);

// Keychain-backed secret storage in production; plain text in dev, where the
// ad-hoc-signed Electron binary would otherwise trigger a keychain password
// prompt on every launch (see ElectronSafeStorage.layerPlainText).
const desktopSecretStorageLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.isDevelopment
      ? DesktopSecretStorage.layerPlainText
      : DesktopSecretStorage.layer;
  }),
);

const resolveDesktopSshCliRunner = (
  environment: DesktopEnvironment.DesktopEnvironmentShape,
  settings: DesktopSettingsValue,
): RemoteThreadlinesRunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteThreadlinesServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }
  return {
    packageSpec: resolveRemoteThreadlinesCliPackageSpec({
      appVersion: environment.appVersion,
      updateChannel: settings.updateChannel,
      isDevelopment: environment.isDevelopment,
    }),
    nodeEngineRange: serverPackageJson.engines.node,
  };
};

const desktopSshEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return DesktopSshEnvironment.layer({
      resolveCliRunner: settings.get.pipe(
        Effect.map((currentSettings) => resolveDesktopSshCliRunner(environment, currentSettings)),
      ),
    });
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  ElectronGlobalShortcut.layer,
  ElectronShell.layer,
  ElectronSpelling.layer.pipe(Layer.provide(NodeServices.layer)),
  ElectronTheme.layer,
  ElectronTray.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  Layer.succeed(DesktopIpc.DesktopIpc, DesktopIpc.make(Electron.ipcMain)),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopLifecycle.layerShutdown,
  DesktopAppSettings.layer,
  DesktopClientSettings.layer,
  DesktopSavedEnvironments.layer,
  DesktopAssets.layer,
  DesktopObservability.layer.pipe(Layer.provideMerge(DesktopDataMigration.layer)),
).pipe(Layer.provideMerge(desktopSecretStorageLayer), Layer.provideMerge(desktopEnvironmentLayer));

const desktopSshLayer = Layer.mergeAll(desktopSshEnvironmentLayer, DesktopSshRemoteApi.layer).pipe(
  Layer.provideMerge(DesktopSshPasswordPrompts.layer()),
);

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(DesktopServerExposure.networkInterfacesLayer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(desktopServerExposureLayer));

const desktopBackendLayer = DesktopBackendManager.layer.pipe(
  Layer.provideMerge(DesktopStartupFailurePrompt.layer),
  Layer.provideMerge(DesktopCrashReport.layer),
  Layer.provideMerge(DesktopAppIdentity.layer),
  Layer.provideMerge(DesktopBackendConfiguration.layer),
  Layer.provideMerge(DesktopDatabaseRecovery.layer),
  Layer.provideMerge(desktopWindowLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopStatusIndicator.layer,
  DesktopScreenCapture.layer,
  PreviewAutomation.layer,
  LocalServers.layer,
  PreviewSession.layer,
  DesktopShellEnvironment.layer,
  DesktopRelay.layer,
  desktopSshLayer,
).pipe(Layer.provideMerge(DesktopUpdates.layer), Layer.provideMerge(desktopBackendLayer));

const desktopRuntimeLayer = ElectronProtocol.layerSchemePrivileges.pipe(
  Layer.flatMap(() =>
    desktopApplicationLayer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(NodeHttpClient.layerUndici),
      Layer.provideMerge(NetService.layer),
      Layer.provideMerge(electronLayer),
    ),
  ),
);

// Every layer above is a lazy description; this is the only line that builds
// them. A secondary instance must never reach it, or it would spawn a second
// backend, probe for a port, and open the shared SQLite state behind the
// running app's back.
if (isPrimaryInstance) {
  DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
}
