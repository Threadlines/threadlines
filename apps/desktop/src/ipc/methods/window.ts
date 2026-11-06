import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopCaptureScreenshotInputSchema,
  DesktopCaptureScreenshotResultSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopPowerStateSchema,
  DesktopTaskbarStatusInputSchema,
  PickFolderOptionsSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackground from "../../app/DesktopBackground.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopScreenCapture from "../../screenCapture/DesktopScreenCapture.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";
import * as DesktopStatusIndicator from "../../window/DesktopStatusIndicator.ts";
import * as DesktopBackdropMonitor from "../../window/DesktopBackdropMonitor.ts";
import * as DesktopThemeAppearance from "../../window/DesktopThemeAppearance.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export const getAppBranding = makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: Effect.fn("desktop.ipc.window.getAppBranding")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.branding;
  }),
});

export const isMarketingCaptureMode = makeSyncIpcMethod({
  channel: IpcChannels.IS_MARKETING_CAPTURE_MODE_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.isMarketingCaptureMode")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.marketingCaptureMode;
  }),
});

export const getLocalEnvironmentBootstrap = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBootstrap")(function* () {
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
    const config = yield* backendManager.currentConfig;
    return Option.match(config, {
      onNone: () => null,
      onSome: ({ bootstrap, httpBaseUrl }) => ({
        label: "Local environment",
        httpBaseUrl: httpBaseUrl.href,
        wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
        ...(bootstrap.desktopBootstrapToken
          ? { bootstrapToken: bootstrap.desktopBootstrapToken }
          : {}),
      }),
    });
  }),
});

export const pickFolder = makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const selectedPath = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: environment.resolvePickFolderDefaultPath(options),
    });
    return Option.getOrNull(selectedPath);
  }),
});

export const confirm = makeIpcMethod({
  channel: IpcChannels.CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return yield* electronWindow.focusedMainOrFirst.pipe(
      Effect.flatMap((owner) => dialog.confirm({ owner, message })),
    );
  }),
});

export const captureScreenshot = makeIpcMethod({
  channel: IpcChannels.CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopCaptureScreenshotInputSchema,
  result: DesktopCaptureScreenshotResultSchema,
  handler: Effect.fn("desktop.ipc.window.captureScreenshot")(function* (input) {
    const screenCapture = yield* DesktopScreenCapture.DesktopScreenCapture;
    return yield* screenCapture.captureScreenshot(input);
  }),
});

/**
 * The app\x27s theme for the window: the native preference, and a custom
 * theme\x27s window colors, applied at once (a same-base switch changes no
 * native setting, so nothing else would repaint the window).
 */
export const setTheme = makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeAppearance.DesktopThemeAppearancePayload,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (payload) {
    const themeAppearance = yield* DesktopThemeAppearance.DesktopThemeAppearance;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* themeAppearance.set(DesktopThemeAppearance.normalizeThemeAppearance(payload));
    yield* desktopWindow.syncAppearance;
  }),
});

export const setTaskbarStatus = makeIpcMethod({
  channel: IpcChannels.SET_TASKBAR_STATUS_CHANNEL,
  payload: DesktopTaskbarStatusInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTaskbarStatus")(function* (input) {
    const statusIndicator = yield* DesktopStatusIndicator.DesktopStatusIndicator;
    const background = yield* DesktopBackground.DesktopBackground;
    yield* statusIndicator.setStatus(input);
    yield* background.setScheduledWork({
      activeTasks: input.activeScheduledTaskCount ?? 0,
      workingRuns: input.workingScheduledRunCount ?? 0,
    });
  }),
});

export const quitConfirmationShown = makeIpcMethod({
  channel: IpcChannels.QUIT_CONFIRMATION_SHOWN_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.quitConfirmationShown")(function* (requestId) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.quitConfirmationShown(requestId);
  }),
});

export const resolveQuitConfirmation = makeIpcMethod({
  channel: IpcChannels.QUIT_CONFIRMATION_RESOLVE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.resolveQuitConfirmation")(function* (confirmed) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.resolveQuitConfirmation(confirmed);
  }),
});

export const setMenuActionsListening = makeIpcMethod({
  channel: IpcChannels.MENU_ACTION_LISTENING_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setMenuActionsListening")(function* (listening) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.setMenuActionsListening(listening);
  }),
});

export const showContextMenu = makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }

    const selectedItemId = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selectedItemId);
  }),
});

export const openExternal = makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});

export const getPowerState = makeIpcMethod({
  channel: IpcChannels.GET_POWER_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPowerStateSchema,
  handler: Effect.fn("desktop.ipc.window.getPowerState")(function* () {
    const monitor = yield* DesktopBackdropMonitor.DesktopBackdropMonitor;
    return yield* monitor.powerState;
  }),
});

/** The app shows a theme's live art, or stopped: the CPU watchdog runs only meanwhile. */
export const setBackdropActive = makeIpcMethod({
  channel: IpcChannels.SET_BACKDROP_ACTIVE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setBackdropActive")(function* (active) {
    const monitor = yield* DesktopBackdropMonitor.DesktopBackdropMonitor;
    yield* monitor.setBackdropActive(active);
  }),
});
