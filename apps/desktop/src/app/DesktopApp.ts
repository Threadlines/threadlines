import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopStatusIndicator from "../window/DesktopStatusIndicator.ts";
import {
  DEFAULT_DESKTOP_BACKEND_PORT,
  desktopBackendPortProbeHosts,
  resolveDesktopBackendPort,
} from "../backend/backendPort.ts";

const makeDesktopRunId = randomUUIDv4.pipe(
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

class DesktopDevelopmentBackendPortRequiredError extends Data.TaggedError(
  "DesktopDevelopmentBackendPortRequiredError",
)<{}> {
  override get message() {
    return "THREADLINES_PORT is required in desktop development.";
  }
}

// Port discovery runs before the backend manager exists, so a probe that a
// security product leaves hanging would wedge startup with no window and no
// recovery prompt. The deadline turns that into the visible fatal-startup
// error box instead.
const BACKEND_PORT_DISCOVERY_TIMEOUT = Duration.seconds(30);

class DesktopBackendPortDiscoveryTimeoutError extends Data.TaggedError(
  "DesktopBackendPortDiscoveryTimeoutError",
)<{}> {
  override get message() {
    return `Timed out selecting a local port for the Threadlines background service after ${Duration.toSeconds(BACKEND_PORT_DISCOVERY_TIMEOUT)}s. A firewall or security tool may be blocking local network probes.`;
  }
}

const { logInfo: logBootstrapInfo, logWarning: logBootstrapWarning } =
  DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logStartupInfo, logError: logStartupError } =
  DesktopObservability.makeComponentLogger("desktop-startup");

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopLifecycle.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopLifecycle.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      "Threadlines failed to start",
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

const bootstrap = Effect.gen(function* () {
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  yield* logBootstrapInfo("bootstrap start");

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const settings = yield* desktopSettings.get;
  const probeHosts = desktopBackendPortProbeHosts(settings.serverExposureMode);
  const backendPortSelection = yield* resolveDesktopBackendPort({
    configuredPort: environment.configuredBackendPort,
    probeHosts,
  }).pipe(
    Effect.timeoutOrElse({
      duration: BACKEND_PORT_DISCOVERY_TIMEOUT,
      orElse: () => new DesktopBackendPortDiscoveryTimeoutError(),
    }),
  );
  const backendPort = backendPortSelection.port;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    },
  );

  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({
    port: backendPort,
    selectedByScan: backendPortSelection.selectedByScan,
  });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (settings.serverExposureMode === "network-accessible") {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  yield* installDesktopIpcHandlers;
  yield* logBootstrapInfo("bootstrap ipc handlers registered");

  if (!(yield* Ref.get(state.quitting))) {
    yield* backendManager.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const statusIndicator = yield* DesktopStatusIndicator.DesktopStatusIndicator;

  yield* shellEnvironment.installIntoProcess;
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });
  yield* desktopSettings.load;

  if (environment.platform === "linux") {
    yield* electronApp.appendCommandLineSwitch("class", environment.linuxWmClass);
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  yield* appIdentity.configure;
  yield* applicationMenu.configure;
  yield* statusIndicator.configure;
  yield* electronProtocol.registerDesktopFileProtocol;
  yield* updates.configure;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopLifecycle.DesktopShutdown;
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;

    yield* Effect.addFinalizer(() =>
      backendManager.stop().pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
