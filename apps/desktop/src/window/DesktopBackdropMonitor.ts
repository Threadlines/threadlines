/**
 * What a theme's live art needs from the desktop (docs/design/custom-themes.md,
 * "Performance" and "The backdrop runtime"):
 *
 * - power and heat: on battery or AC (`powerMonitor`), the macOS thermal
 *   state, and whether the OS lowered the CPU speed limit, sent to the app
 *   as they change;
 * - the CPU watchdog: while the app shows art, every 2 seconds it finds the
 *   backdrop frame (the iframe named `threadlines-backdrop`) and samples its
 *   renderer's CPU. Over 15% of a core for 10 seconds tells the app, which
 *   halves the art's rate; a verdict after the second halving makes it
 *   still. Chromium can put sandboxed sibling frames (agent
 *   pages) in the same process, so a sample is skipped whenever any other
 *   frame lives there: the watchdog never blames the art for a page's work.
 */
import * as NodeOS from "node:os";

import type { DesktopPowerState } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

/** The `name` the app gives the backdrop's iframe. */
export const BACKDROP_FRAME_NAME = "threadlines-backdrop";
export const WATCHDOG_SAMPLE_MS = 2_000;
/** Percent of one core. */
export const WATCHDOG_CPU_LIMIT = 15;
export const WATCHDOG_SUSTAINED_MS = 10_000;

export interface WatchdogSample {
  readonly at: number;
  /** Null when there is no backdrop frame, or its process is shared, so the sample says nothing. */
  readonly cpuPercent: number | null;
}

export interface WatchdogState {
  /** When the art went over the limit, counting the interval the first sample averaged. */
  readonly overSince: number | null;
}

/** One watchdog step: the state after `sample`, and whether to tell the app. */
export function stepWatchdog(
  state: WatchdogState,
  sample: WatchdogSample,
): { readonly state: WatchdogState; readonly tooHeavy: boolean } {
  if (sample.cpuPercent === null || sample.cpuPercent <= WATCHDOG_CPU_LIMIT) {
    return { state: { overSince: null }, tooHeavy: false };
  }
  // A sample is the average since the previous one, so the art was over for that long already.
  const overSince = state.overSince ?? sample.at - WATCHDOG_SAMPLE_MS;
  if (sample.at - overSince >= WATCHDOG_SUSTAINED_MS) {
    return { state: { overSince: null }, tooHeavy: true };
  }
  return { state: { overSince }, tooHeavy: false };
}

const frameKey = (frame: Electron.WebFrameMain) => frame.frameToken;

/**
 * The backdrop frame's CPU (percent of a core) in the main window, or null
 * when there is no backdrop frame or another frame shares its process.
 */
function sampleBackdropCpu(window: Electron.BrowserWindow): number | null {
  if (window.isDestroyed() || window.isMinimized() || !window.isVisible()) return null;
  const frames = window.webContents.mainFrame.framesInSubtree;
  const backdrop = frames.find((frame) => frame.name === BACKDROP_FRAME_NAME);
  if (!backdrop) return null;
  const pid = backdrop.osProcessId;
  const shared = Electron.webContents.getAllWebContents().some((contents) => {
    if (contents.isDestroyed()) return false;
    return contents.mainFrame.framesInSubtree.some(
      (frame) => frame.osProcessId === pid && frameKey(frame) !== frameKey(backdrop),
    );
  });
  if (shared) return null;
  const metric = Electron.app.getAppMetrics().find((entry) => entry.pid === pid);
  // Electron divides by the processor count (a busy loop measured 7% on 14
  // cores); the budget is per core.
  return metric ? metric.cpu.percentCPUUsage * Math.max(1, NodeOS.cpus().length) : null;
}

function readPowerState(speedLimited: boolean): DesktopPowerState {
  const monitor = Electron.powerMonitor;
  let thermal: DesktopPowerState["thermal"] = "unknown";
  if (process.platform === "darwin" && typeof monitor.getCurrentThermalState === "function") {
    try {
      thermal = monitor.getCurrentThermalState();
    } catch {
      thermal = "unknown";
    }
  }
  return {
    power: monitor.isOnBatteryPower() ? "battery" : "ac",
    thermal,
    speedLimited,
  };
}

export interface DesktopBackdropMonitorShape {
  readonly powerState: Effect.Effect<DesktopPowerState>;
  /** The app shows art (or stopped): runs or stops the watchdog. */
  readonly setBackdropActive: (active: boolean) => Effect.Effect<void>;
}

export class DesktopBackdropMonitor extends Context.Service<
  DesktopBackdropMonitor,
  DesktopBackdropMonitorShape
>()("threadlines/desktop/BackdropMonitor") {}

export const layer = Layer.effect(
  DesktopBackdropMonitor,
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
    const runFork = Effect.runForkWith(context);
    let speedLimited = false;
    let listening = false;
    let active = false;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let watchedWindow: Electron.BrowserWindow | null = null;
    let cleanupWindowListeners: (() => void) | null = null;
    let watchdogState: WatchdogState = { overSince: null };

    const broadcastPower = () => {
      runFork(
        electronWindow
          .sendAll(IpcChannels.POWER_STATE_CHANNEL, readPowerState(speedLimited))
          .pipe(Effect.ignore),
      );
    };

    // powerMonitor works only once the app is ready; the app asks long after.
    const listen = () => {
      if (listening) return;
      listening = true;
      const monitor = Electron.powerMonitor;
      monitor.on("on-battery", broadcastPower);
      monitor.on("on-ac", broadcastPower);
      monitor.on("thermal-state-change", broadcastPower);
      monitor.on("speed-limit-change", (details) => {
        speedLimited = details.limit < 100;
        broadcastPower();
      });
    };

    const pauseWatchdogTimer = () => {
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      watchdogState = { overSince: null };
    };

    const stopWatchdog = () => {
      active = false;
      pauseWatchdogTimer();
      cleanupWindowListeners?.();
      cleanupWindowListeners = null;
      watchedWindow = null;
    };

    const sample = (window: Electron.BrowserWindow) => {
      if (window.isDestroyed()) {
        stopWatchdog();
        return;
      }
      if (window.isMinimized() || !window.isVisible()) {
        pauseWatchdogTimer();
        return;
      }
      let cpuPercent: number | null = null;
      try {
        cpuPercent = sampleBackdropCpu(window);
      } catch {
        cpuPercent = null;
      }
      const step = stepWatchdog(watchdogState, { at: Date.now(), cpuPercent });
      watchdogState = step.state;
      // Sampling goes on: a verdict first slows the art, and art still too
      // heavy after that earns another. Once the art is still its frame is
      // gone, so samples say nothing.
      if (step.tooHeavy) {
        runFork(electronWindow.sendAll(IpcChannels.BACKDROP_TOO_HEAVY_CHANNEL).pipe(Effect.ignore));
      }
    };

    const ensureWatchdogTimer = (window: Electron.BrowserWindow) => {
      if (!active || watchdog !== null) return;
      if (window.isDestroyed() || window.isMinimized() || !window.isVisible()) return;
      watchdog = setInterval(() => sample(window), WATCHDOG_SAMPLE_MS);
    };

    const watchWindow = (window: Electron.BrowserWindow) => {
      if (watchedWindow === window) {
        ensureWatchdogTimer(window);
        return;
      }
      cleanupWindowListeners?.();
      watchedWindow = window;
      const onPause = () => pauseWatchdogTimer();
      const onResume = () => ensureWatchdogTimer(window);
      const onClosed = () => stopWatchdog();
      window.on("minimize", onPause);
      window.on("hide", onPause);
      window.on("restore", onResume);
      window.on("show", onResume);
      window.once("closed", onClosed);
      cleanupWindowListeners = () => {
        if (!window.isDestroyed()) {
          window.removeListener("minimize", onPause);
          window.removeListener("hide", onPause);
          window.removeListener("restore", onResume);
          window.removeListener("show", onResume);
          window.removeListener("closed", onClosed);
        }
      };
      ensureWatchdogTimer(window);
    };

    yield* Effect.addFinalizer(() => Effect.sync(stopWatchdog));

    return DesktopBackdropMonitor.of({
      powerState: Effect.sync(() => {
        listen();
        return readPowerState(speedLimited);
      }),
      setBackdropActive: (nextActive) =>
        Effect.gen(function* () {
          listen();
          if (!nextActive) {
            stopWatchdog();
            return;
          }
          active = true;
          const window = yield* electronWindow.main;
          if (window._tag === "None") return;
          watchWindow(window.value);
        }).pipe(Effect.withSpan("desktop.backdropMonitor.setBackdropActive")),
    });
  }),
);
