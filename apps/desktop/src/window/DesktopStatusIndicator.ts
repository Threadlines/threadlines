import type { DesktopMenuActionPayload, DesktopTaskbarStatusInput } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopStatusGlyphs from "./DesktopStatusGlyphs.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const THREAD_COUNT_DISPLAY_MAX = 99;
const MACOS_TRAY_TITLE_OPTIONS = { fontType: "monospacedDigit" } as const;
const MACOS_TRAY_MENU_THREAD_LIMIT = 5;
const MACOS_TRAY_MENU_TITLE_MAX_LENGTH = 44;

export interface DesktopStatusIndicatorShape {
  readonly configure: Effect.Effect<void>;
  readonly setStatus: (input: DesktopTaskbarStatusInput) => Effect.Effect<void>;
}

export class DesktopStatusIndicator extends Context.Service<
  DesktopStatusIndicator,
  DesktopStatusIndicatorShape
>()("threadlines/desktop/StatusIndicator") {}

type DesktopStatusIndicatorRuntimeServices = DesktopWindow.DesktopWindow | ElectronApp.ElectronApp;

interface MacTrayImages {
  readonly idle: Electron.NativeImage;
  readonly workingFrames: readonly Electron.NativeImage[];
  readonly completedFrames: readonly Electron.NativeImage[];
  readonly menuRunning: Electron.NativeImage;
  readonly menuCompleted: Electron.NativeImage;
}

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

function normalizeCompletedThreadCount(input: DesktopTaskbarStatusInput): number {
  const count = input.completedThreadCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    // A completed status always represents at least one finished thread.
    return 1;
  }
  return Math.floor(count);
}

function resolveStatusDescription(input: DesktopTaskbarStatusInput): string {
  const description = input.description?.trim();
  if (description) {
    return description;
  }

  switch (input.status) {
    case "working":
    case "completed":
      return resolveStatusMenuLabel(input);
    case "idle":
      return "No active agent sessions";
  }
}

function formatThreadCount(count: number): string {
  return count > THREAD_COUNT_DISPLAY_MAX ? `${THREAD_COUNT_DISPLAY_MAX}+` : String(count);
}

function resolveTrayTitle(input: DesktopTaskbarStatusInput): string {
  if (input.status === "working") {
    const count = normalizeRunningThreadCount(input);
    return count > 0 ? formatThreadCount(count) : "";
  }
  return "";
}

function resolveTrayTooltip(appName: string, input: DesktopTaskbarStatusInput): string {
  return `${appName}: ${resolveStatusMenuLabel(input)}`;
}

function resolveStatusMenuLabel(input: DesktopTaskbarStatusInput): string {
  switch (input.status) {
    case "working": {
      const count = normalizeRunningThreadCount(input);
      if (count === 1) return "1 thread running";
      if (count > 1) return `${count} threads running`;
      return "Threads running";
    }
    case "completed": {
      const count = normalizeCompletedThreadCount(input);
      return count > 1 ? `${count} threads completed` : "Thread completed";
    }
    case "idle":
      return "Ready";
  }
}

function resolveStatusMenuSublabel(input: DesktopTaskbarStatusInput): string {
  switch (input.status) {
    case "working":
      return "Coding agents are active";
    case "completed":
      return "Latest work finished";
    case "idle":
      return "No active agent sessions";
  }
}

function createDefaultStatus(): DesktopTaskbarStatusInput {
  return { status: "idle", description: "No active agent sessions" };
}

function truncateThreadMenuLabel(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return "Untitled thread";
  }
  if (trimmed.length <= MACOS_TRAY_MENU_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MACOS_TRAY_MENU_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTray = yield* ElectronTray.ElectronTray;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopStatusIndicatorRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  const appName = environment.displayName;

  let currentStatus = createDefaultStatus();
  let tray: Electron.Tray | null = null;
  let macTrayImages: MacTrayImages | null = null;
  let macTrayAnimationTimer: ReturnType<typeof setInterval> | null = null;
  let macTrayRenderedStatus: DesktopTaskbarStatusInput["status"] | null = null;
  let macDockBounceId: number | null = null;
  const taskbarOverlayIcons = new Map<DesktopStatusGlyphs.TrayGlyph, Electron.NativeImage>();

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

  const dispatchRendererAction = (action: string, payload?: DesktopMenuActionPayload) =>
    Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      yield* desktopWindow.dispatchMenuAction(action, payload);
    });

  const createTrayImageFrames = (glyphs: readonly DesktopStatusGlyphs.TrayGlyph[]) =>
    Effect.gen(function* () {
      const frames: Electron.NativeImage[] = [];
      for (const glyph of glyphs) {
        const frame = yield* electronTray.createTemplateImage(glyph.representations);
        if (Option.isNone(frame)) {
          return Option.none<Electron.NativeImage[]>();
        }
        frames.push(frame.value);
      }
      return Option.some(frames);
    });

  const createMacTrayImages = Effect.gen(function* () {
    const glyphs = DesktopStatusGlyphs.makeMacTrayGlyphSet();
    const menuGlyphs = DesktopStatusGlyphs.makeMacMenuStateGlyphs();
    const idle = yield* createTrayImageFrames([glyphs.idle]);
    const workingFrames = yield* createTrayImageFrames(glyphs.workingFrames);
    const completedFrames = yield* createTrayImageFrames(glyphs.completedFrames);
    const menuIcons = yield* createTrayImageFrames([menuGlyphs.running, menuGlyphs.completed]);
    if (
      Option.isNone(idle) ||
      Option.isNone(workingFrames) ||
      Option.isNone(completedFrames) ||
      Option.isNone(menuIcons) ||
      idle.value[0] === undefined ||
      menuIcons.value[0] === undefined ||
      menuIcons.value[1] === undefined
    ) {
      return Option.none<MacTrayImages>();
    }

    return Option.some({
      idle: idle.value[0],
      workingFrames: workingFrames.value,
      completedFrames: completedFrames.value,
      menuRunning: menuIcons.value[0],
      menuCompleted: menuIcons.value[1],
    });
  });

  const setMacTrayImage = (image: Electron.NativeImage) => {
    const currentTray = tray;
    if (currentTray === null) {
      return;
    }

    try {
      currentTray.setImage(image);
    } catch {
      clearMacTrayAnimation();
    }
  };

  const clearMacTrayAnimation = () => {
    if (macTrayAnimationTimer !== null) {
      clearInterval(macTrayAnimationTimer);
      macTrayAnimationTimer = null;
    }
  };

  const playMacTrayFrames = (
    frames: readonly Electron.NativeImage[],
    input: { readonly loop: boolean; readonly frameMs: number },
  ) => {
    clearMacTrayAnimation();
    const first = frames[0];
    if (first === undefined) {
      return;
    }

    setMacTrayImage(first);
    if (frames.length === 1) {
      return;
    }

    let frameIndex = 1;
    macTrayAnimationTimer = setInterval(() => {
      const frame = frames[frameIndex];
      if (frame === undefined || tray === null) {
        clearMacTrayAnimation();
        return;
      }

      setMacTrayImage(frame);
      frameIndex += 1;
      if (frameIndex >= frames.length) {
        if (input.loop) {
          frameIndex = 0;
        } else {
          clearMacTrayAnimation();
        }
      }
    }, input.frameMs);
  };

  const syncMacTrayImage = () => {
    const images = macTrayImages;
    if (tray === null || images === null) {
      return;
    }

    // Count or description updates within the same status must not restart the
    // running animation.
    if (currentStatus.status === macTrayRenderedStatus) {
      return;
    }
    macTrayRenderedStatus = currentStatus.status;

    switch (currentStatus.status) {
      case "working":
        playMacTrayFrames(images.workingFrames, {
          loop: true,
          frameMs: DesktopStatusGlyphs.TRAY_WORKING_FRAME_INTERVAL_MS,
        });
        return;
      case "completed":
        playMacTrayFrames(images.completedFrames, {
          loop: false,
          frameMs: DesktopStatusGlyphs.TRAY_COMPLETED_FRAME_INTERVAL_MS,
        });
        return;
      case "idle":
        clearMacTrayAnimation();
        setMacTrayImage(images.idle);
        return;
    }
  };

  const buildThreadMenuItems = (
    status: DesktopTaskbarStatusInput,
  ): Electron.MenuItemConstructorOptions[] => {
    const images = macTrayImages;
    const threads = status.threads ?? [];
    if (threads.length === 0 || images === null) {
      return [];
    }

    const items: Electron.MenuItemConstructorOptions[] = threads
      .slice(0, MACOS_TRAY_MENU_THREAD_LIMIT)
      .map((thread) => ({
        label: truncateThreadMenuLabel(thread.title),
        icon: thread.state === "completed" ? images.menuCompleted : images.menuRunning,
        toolTip: `${thread.title.trim()} — ${thread.state === "completed" ? "completed" : "running"}`,
        click: () =>
          runTrayEffect(
            "open-thread",
            dispatchRendererAction("open-thread", {
              environmentId: thread.environmentId,
              threadId: thread.threadId,
            }),
          ),
      }));

    const hiddenThreadCount = threads.length - items.length;
    if (hiddenThreadCount > 0) {
      items.push({
        label: hiddenThreadCount === 1 ? "1 more thread" : `${hiddenThreadCount} more threads`,
        enabled: false,
      });
    }

    return [...items, { type: "separator" }];
  };

  const buildTrayMenuTemplate = (
    status: DesktopTaskbarStatusInput,
  ): Electron.MenuItemConstructorOptions[] => [
    {
      label: resolveStatusMenuLabel(status),
      sublabel: resolveStatusMenuSublabel(status),
      enabled: false,
      toolTip: resolveStatusDescription(status),
    },
    { type: "separator" },
    ...buildThreadMenuItems(status),
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
      label: "Settings…",
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
      tray.setTitle(resolveTrayTitle(currentStatus), MACOS_TRAY_TITLE_OPTIONS);
      tray.setToolTip(resolveTrayTooltip(appName, currentStatus));
      tray.setContextMenu(menu);
      syncMacTrayImage();
    });
  });

  const cancelMacDockBounce = Effect.gen(function* () {
    if (macDockBounceId === null) {
      return;
    }

    const bounceId = macDockBounceId;
    macDockBounceId = null;
    yield* electronApp.cancelDockBounce(bounceId);
  });

  const getTaskbarOverlayIcon = (input: DesktopStatusGlyphs.TaskbarOverlayChipInput) =>
    Effect.gen(function* () {
      const glyph = DesktopStatusGlyphs.makeTaskbarOverlayChip(input);
      const cached = taskbarOverlayIcons.get(glyph);
      if (cached !== undefined) {
        return Option.some(cached);
      }
      const icon = yield* electronTray.createImage(glyph.representations);
      if (Option.isSome(icon)) {
        taskbarOverlayIcons.set(glyph, icon.value);
      }
      return icon;
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

    const description = input.description ?? "";
    switch (input.status) {
      case "working": {
        const count = normalizeRunningThreadCount(input);
        const overlay =
          count > 0
            ? yield* getTaskbarOverlayIcon({ kind: "running", count })
            : Option.none<Electron.NativeImage>();
        yield* Effect.sync(() => {
          window.flashFrame(false);
          window.setOverlayIcon(
            Option.getOrNull(overlay),
            Option.isSome(overlay) ? description : "",
          );
          window.setProgressBar(2, { mode: "indeterminate" });
        });
        return;
      }
      case "completed": {
        const overlay = yield* getTaskbarOverlayIcon({
          kind: "completed",
          count: normalizeCompletedThreadCount(input),
        });
        yield* Effect.sync(() => {
          window.setProgressBar(-1);
          window.setOverlayIcon(Option.getOrNull(overlay), description);
          if (!window.isFocused()) {
            window.flashFrame(true);
          }
        });
        return;
      }
      case "idle":
        yield* Effect.sync(() => {
          window.flashFrame(false);
          window.setOverlayIcon(null, "");
          window.setProgressBar(-1);
        });
        return;
    }
  });

  const applyMacStatus = Effect.fn("desktop.status.applyMac")(function* (
    input: DesktopTaskbarStatusInput,
  ) {
    if (environment.platform !== "darwin") {
      return;
    }

    const maybeWindow = yield* electronWindow.currentMainOrFirst;
    const window = Option.getOrNull(maybeWindow);

    // The Dock stays quiet while working — the menu bar status item is the
    // macOS activity surface. The badge is reserved for finished work that
    // has not been seen yet, mirroring Mail's unread semantics.
    switch (input.status) {
      case "working":
        yield* cancelMacDockBounce;
        yield* electronApp.setDockBadge("");
        return;
      case "completed": {
        yield* electronApp.setDockBadge(formatThreadCount(normalizeCompletedThreadCount(input)));
        if (window !== null && isUsableWindow(window) && !window.isFocused()) {
          yield* cancelMacDockBounce;
          const bounceId = yield* electronApp.bounceDock("informational");
          macDockBounceId = Option.getOrNull(bounceId);
        }
        return;
      }
      case "idle":
        yield* cancelMacDockBounce;
        yield* electronApp.setDockBadge("");
        return;
    }
  });

  const configure = Effect.gen(function* () {
    if (environment.platform !== "darwin" || tray !== null) {
      return;
    }

    const trayImages = yield* createMacTrayImages;
    if (Option.isNone(trayImages)) {
      yield* logStatusWarning(
        "macOS status item skipped because the generated tray icons could not be loaded",
      );
      return;
    }

    macTrayImages = trayImages.value;
    tray = yield* electronTray.create(trayImages.value.idle);
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
