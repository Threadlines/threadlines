import type { DesktopTaskbarStatusInput } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { nativeImage } from "electron";
import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const MACOS_DOCK_PROGRESS_TICK_MS = 120;
const MACOS_DOCK_PROGRESS_MIN = 0.12;
const MACOS_DOCK_PROGRESS_MAX = 0.92;
const MACOS_DOCK_PROGRESS_STEP = 0.055;
const MACOS_COMPLETED_DOCK_BADGE = "1";
const MACOS_COMPLETED_TRAY_TITLE = "OK";

// 16x16 transparent PNG with a compact, anti-aliased blue dot.
const TASKBAR_COMPLETE_OVERLAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASklEQVR42mNQTX7NQAlmGL4GGKsmv96gmvz6GxRvgIoRZYAxVNN/NPwNmyHYDNiARTMMbyDGgG94DPhGFwMo9gLFgUhxNI60vAAACfilkKE3QbkAAAAASUVORK5CYII=";

let cachedTaskbarCompleteOverlayIcon: Electron.NativeImage | null = null;

function getTaskbarCompleteOverlayIcon(): Electron.NativeImage {
  cachedTaskbarCompleteOverlayIcon ??= nativeImage.createFromDataURL(
    TASKBAR_COMPLETE_OVERLAY_ICON_DATA_URL,
  );
  return cachedTaskbarCompleteOverlayIcon;
}

export interface DesktopStatusIndicatorShape {
  readonly configure: Effect.Effect<void>;
  readonly setStatus: (input: DesktopTaskbarStatusInput) => Effect.Effect<void>;
}

export class DesktopStatusIndicator extends Context.Service<
  DesktopStatusIndicator,
  DesktopStatusIndicatorShape
>()("threadlines/desktop/StatusIndicator") {}

type DesktopStatusIndicatorRuntimeServices = DesktopWindow.DesktopWindow | ElectronApp.ElectronApp;

const { logWarning: logStatusWarning, logError: logStatusError } =
  DesktopObservability.makeComponentLogger("desktop-status");

function isUsableWindow(window: Electron.BrowserWindow): boolean {
  return !window.isDestroyed();
}

function normalizeRunningThreadCount(input: DesktopTaskbarStatusInput): number {
  const count = input.runningThreadCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.floor(count);
}

function resolveStatusDescription(input: DesktopTaskbarStatusInput): string {
  const description = input.description?.trim();
  if (description) {
    return description;
  }

  switch (input.status) {
    case "working": {
      const count = normalizeRunningThreadCount(input);
      if (count === 1) return "One chat is working";
      if (count > 1) return `${count} chats are working`;
      return "Chats are working";
    }
    case "completed":
      return "Chat completed";
    case "idle":
      return "No chats are working";
  }
}

function resolveTrayTitle(input: DesktopTaskbarStatusInput): string {
  if (input.status === "working") {
    const count = normalizeRunningThreadCount(input);
    return count > 0 ? String(count) : "";
  }
  if (input.status === "completed") {
    return MACOS_COMPLETED_TRAY_TITLE;
  }
  return "";
}

function resolveTrayTooltip(appName: string, input: DesktopTaskbarStatusInput): string {
  return `${appName}: ${resolveStatusDescription(input)}`;
}

function resolveStatusMenuLabel(input: DesktopTaskbarStatusInput): string {
  return `Status: ${resolveStatusDescription(input)}`;
}

function createDefaultStatus(): DesktopTaskbarStatusInput {
  return { status: "idle", description: "No chats are working" };
}

function setWindowProgress(window: Electron.BrowserWindow, progress: number): boolean {
  if (!isUsableWindow(window)) {
    return false;
  }

  try {
    window.setProgressBar(progress);
    return true;
  } catch {
    return false;
  }
}

const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTray = yield* ElectronTray.ElectronTray;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopStatusIndicatorRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  const appName = yield* electronApp.name;

  let currentStatus = createDefaultStatus();
  let tray: Electron.Tray | null = null;
  let macDockProgressWindow: Electron.BrowserWindow | null = null;
  let macDockProgressTimer: ReturnType<typeof setInterval> | null = null;
  let macDockBounceId: number | null = null;

  const runTrayEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopStatusIndicatorRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.status.trayAction"),
        Effect.catchCause((cause) =>
          logStatusError("tray action failed", {
            action,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
  };

  const dispatchRendererAction = (action: string) =>
    Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      yield* desktopWindow.dispatchMenuAction(action);
    });

  const buildTrayMenuTemplate = (
    status: DesktopTaskbarStatusInput,
  ): Electron.MenuItemConstructorOptions[] => [
    {
      label: resolveStatusMenuLabel(status),
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Show Threadlines",
      click: () =>
        runTrayEffect(
          "show-threadlines",
          Effect.gen(function* () {
            const desktopWindow = yield* DesktopWindow.DesktopWindow;
            yield* desktopWindow.revealOrCreateMain;
          }),
        ),
    },
    {
      label: "New Thread",
      click: () => runTrayEffect("new-thread", dispatchRendererAction("new-thread")),
    },
    {
      label: "Settings...",
      click: () => runTrayEffect("open-settings", dispatchRendererAction("open-settings")),
    },
    { type: "separator" },
    {
      label: `Quit ${appName}`,
      click: () =>
        runTrayEffect(
          "quit",
          Effect.gen(function* () {
            const app = yield* ElectronApp.ElectronApp;
            yield* app.quit;
          }),
        ),
    },
  ];

  const updateTray = Effect.fn("desktop.status.updateTray")(function* () {
    if (environment.platform !== "darwin" || tray === null) {
      return;
    }

    const menu = yield* electronTray.buildMenu(buildTrayMenuTemplate(currentStatus));
    yield* Effect.sync(() => {
      if (tray === null) {
        return;
      }
      tray.setTitle(resolveTrayTitle(currentStatus));
      tray.setToolTip(resolveTrayTooltip(appName, currentStatus));
      tray.setContextMenu(menu);
    });
  });

  const clearMacDockProgress = () => {
    if (macDockProgressTimer !== null) {
      clearInterval(macDockProgressTimer);
      macDockProgressTimer = null;
    }

    const window = macDockProgressWindow;
    macDockProgressWindow = null;
    if (window !== null) {
      setWindowProgress(window, -1);
    }
  };

  const startMacDockProgress = (window: Electron.BrowserWindow) => {
    if (macDockProgressWindow === window && macDockProgressTimer !== null) {
      return;
    }

    clearMacDockProgress();
    macDockProgressWindow = window;
    let progress = MACOS_DOCK_PROGRESS_MIN;
    let direction = 1;

    const tick = () => {
      if (macDockProgressWindow === null || !setWindowProgress(macDockProgressWindow, progress)) {
        clearMacDockProgress();
        return;
      }

      progress += MACOS_DOCK_PROGRESS_STEP * direction;
      if (progress >= MACOS_DOCK_PROGRESS_MAX) {
        progress = MACOS_DOCK_PROGRESS_MAX;
        direction = -1;
      } else if (progress <= MACOS_DOCK_PROGRESS_MIN) {
        progress = MACOS_DOCK_PROGRESS_MIN;
        direction = 1;
      }
    };

    tick();
    macDockProgressTimer = setInterval(tick, MACOS_DOCK_PROGRESS_TICK_MS);
  };

  const cancelMacDockBounce = Effect.gen(function* () {
    if (macDockBounceId === null) {
      return;
    }

    const bounceId = macDockBounceId;
    macDockBounceId = null;
    yield* electronApp.cancelDockBounce(bounceId);
  });

  const applyWindowsStatus = Effect.fn("desktop.status.applyWindows")(function* (
    input: DesktopTaskbarStatusInput,
  ) {
    if (environment.platform !== "win32") {
      return;
    }

    const maybeWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(maybeWindow)) {
      return;
    }

    const window = maybeWindow.value;
    if (!isUsableWindow(window)) {
      return;
    }

    yield* Effect.sync(() => {
      const description = input.description ?? "";
      switch (input.status) {
        case "working":
          window.flashFrame(false);
          window.setOverlayIcon(null, "");
          window.setProgressBar(2, { mode: "indeterminate" });
          return;
        case "completed":
          window.setProgressBar(-1);
          window.setOverlayIcon(getTaskbarCompleteOverlayIcon(), description);
          if (!window.isFocused()) {
            window.flashFrame(true);
          }
          return;
        case "idle":
          window.flashFrame(false);
          window.setOverlayIcon(null, "");
          window.setProgressBar(-1);
          return;
      }
    });
  });

  const applyMacStatus = Effect.fn("desktop.status.applyMac")(function* (
    input: DesktopTaskbarStatusInput,
  ) {
    if (environment.platform !== "darwin") {
      return;
    }

    const maybeWindow = yield* electronWindow.currentMainOrFirst;
    const window = Option.getOrNull(maybeWindow);

    switch (input.status) {
      case "working":
        yield* cancelMacDockBounce;
        yield* electronApp.setDockBadge("");
        if (window !== null && isUsableWindow(window)) {
          startMacDockProgress(window);
        }
        return;
      case "completed": {
        clearMacDockProgress();
        yield* electronApp.setDockBadge(MACOS_COMPLETED_DOCK_BADGE);
        if (window !== null && isUsableWindow(window) && !window.isFocused()) {
          yield* cancelMacDockBounce;
          const bounceId = yield* electronApp.bounceDock("informational");
          macDockBounceId = Option.getOrNull(bounceId);
        }
        return;
      }
      case "idle":
        clearMacDockProgress();
        yield* cancelMacDockBounce;
        yield* electronApp.setDockBadge("");
        return;
    }
  });

  const configure = Effect.gen(function* () {
    if (environment.platform !== "darwin" || tray !== null) {
      return;
    }

    const iconPaths = yield* assets.iconPaths;
    if (Option.isNone(iconPaths.png)) {
      yield* logStatusWarning("macOS status item skipped because no PNG icon is available");
      return;
    }

    const trayImage = yield* electronTray.createTemplateImageFromPath(iconPaths.png.value);
    if (Option.isNone(trayImage)) {
      yield* logStatusWarning(
        "macOS status item skipped because the PNG icon could not be loaded",
        {
          iconPath: iconPaths.png.value,
        },
      );
      return;
    }

    tray = yield* electronTray.create(trayImage.value);
    yield* updateTray();
  }).pipe(Effect.withSpan("desktop.status.configure"));

  return DesktopStatusIndicator.of({
    configure,
    setStatus: Effect.fn("desktop.status.setStatus")(function* (input) {
      currentStatus = input;
      yield* applyWindowsStatus(input);
      yield* applyMacStatus(input);
      yield* updateTray();
    }),
  });
});

export const layer = Layer.effect(DesktopStatusIndicator, make);
