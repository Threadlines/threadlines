/**
 * The backdrop frame (docs/design/custom-themes.md, "The backdrop runtime"):
 * the document the app loads into a sandboxed iframe behind the window. It
 * holds only Threadlines' own runtime (backdropRuntime.ts, with the tint math
 * from backdropTint.ts and the worker prelude from backdropWorkerPrelude.ts):
 * no theme content is ever written into it. The theme's script arrives in
 * the `init` message and runs in a dedicated worker the frame can terminate.
 *
 * Driving it (ThemeBackdropHost does this; anything else hosting the frame,
 * like the theme specimen, must too): load the document with
 * `sandbox="allow-scripts"`; when it posts `ready` (it listens from then
 * on), post `init`, `viewport`, `zones`, `activity` and `conditions`
 * (BackdropHostMessage) to its window. The art starts once a `conditions`
 * message says it may run. With no zones the art shows raw, with no frost or
 * tint. After `init` the frame posts a `heartbeat` every second, `stats`
 * every 2 seconds, `still` for each `capture-still`, and `failure`
 * (BackdropFrameMessage).
 *
 * Stills are the art alone, without frost or tint: a still is shown under
 * any layout and as a thumbnail, so it can't carry one layout's frosted
 * zones, and the app tints whatever sits over it itself.
 *
 * The runtime's source reaches the document as text (Function.prototype
 * .toString, the pattern packages/ssh's tunnel uses), so each function
 * inlined here must stay closed: it may use platform globals and its
 * arguments, nothing it imports. backdrop.test.ts runs the tint math from
 * source and the browser tests (apps/web backdropFrame.browser.tsx) run the
 * whole document, which keeps that true.
 */
import {
  BACKDROP_MAX_SLOWDOWN,
  BACKDROP_MAX_ZONES,
  THEME_MAX_FPS,
  THEME_MAX_SCRIPT_CHARS,
  THEME_MAX_STILL_CHARS,
} from "@threadlines/contracts";
import {
  BACKDROP_MAX_BACKGROUND_STOPS,
  BACKDROP_MAX_CELL_GAP,
  BACKDROP_MAX_CANVAS_DPR,
  BACKDROP_MAX_CANVAS_PIXELS,
  BACKDROP_MAX_CELL_PX,
  BACKDROP_MAX_GLYPHS,
  BACKDROP_MAX_GRID_CELLS,
  BACKDROP_MAX_PIXELS_HEIGHT,
  BACKDROP_MAX_PIXELS_WIDTH,
  BACKDROP_MIN_CELL_PX,
} from "@threadlines/contracts/themeBackdropWorker";

import { scriptLiteral } from "../framedDocument.ts";
import {
  backdropFrameRuntime,
  type BackdropFrameRuntimeOptions,
  type BackdropRuntimeLimits,
  type BackdropRuntimeTiming,
} from "./backdropRuntime.ts";
import { backdropTintMath } from "./backdropTint.ts";
import { backdropWorkerPrelude } from "./backdropWorkerPrelude.ts";

/** The iframe's sandbox: scripts only, so the frame has an opaque origin. */
export const BACKDROP_FRAME_SANDBOX = "allow-scripts";

/**
 * The frame's content policy. Nothing loads from anywhere: the runtime is
 * inline, the art worker comes from a blob it makes, and the worker inherits
 * this policy, so the art has no network, no nested scripts and no fonts.
 * `img-src data: blob:` lets art decode images it carries in its own script;
 * neither can reach the network.
 */
export const BACKDROP_FRAME_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; img-src data: blob:";

/**
 * How the runtime paces and judges the art (docs/design/custom-themes.md,
 * "Performance").
 *
 * - Frame rate: the theme's own maximum while the window is in front and
 *   for `burstMs` after a finished turn; behind another app, `idleFps` with
 *   no agent working and `workingFps` while one works. Never above the
 *   theme's maximum or `batteryFps` on battery, halved per throttle step,
 *   and never below `minFps` (the app's watchdog expects a new frame within
 *   3 seconds while the art runs).
 * - The art holds while the app is busy (the window resizing, a divider
 *   dragged) and resumes `busyResumeMs` after. Typing, scrolling and a reply
 *   streaming in don't hold or slow it.
 * - After a pause the art restarts in a new worker, its own state fresh: the
 *   picture on screen dissolves into the restarted art over `resumeFadeMs`.
 *   A theme's first frame fades the same way from its still (what the app
 *   shows until then), when one comes with `init`: the art waits up to
 *   `stillWaitMs` for it to decode.
 * - Budget: a frame's cost is the work the worker reports (its prelude's
 *   clock, or the round trip when a reply carries none) plus the frame's own
 *   work. When the work per second over `budgetWindowMs` passes
 *   `budgetMsPerSecond` (the heavy energy label's line), the rate halves (a
 *   throttle step, at most `maxThrottle`); under half of it, it steps back
 *   up. Over budget only slows the art. A new worker's first
 *   `budgetWarmupMs` (setup, unoptimized code) don't count.
 * - Missed ticks: a tick not answered within two frame intervals is a miss;
 *   `missesToStepDown` in a row take a throttle step, `missesToFail` in a
 *   row stop the art ("too-heavy").
 * - Energy label from the work per second over the budget window: light
 *   under `energyMediumMsPerSecond`, heavy from `energyHeavyMsPerSecond`,
 *   medium between (1.5% and 6% of one core).
 * - Tint follows the frost every frame, patch by patch (TINT_MAP_FS).
 * - The visible canvas draws at most at `maxFrameDpr` and
 *   `maxFrameDevicePixels` (a 4K screen's worth).
 */
export const BACKDROP_RUNTIME_TIMING: BackdropRuntimeTiming = {
  idleFps: 10,
  workingFps: 15,
  batteryFps: 20,
  burstMs: 2_000,
  busyResumeMs: 400,
  resumeFadeMs: 500,
  stillWaitMs: 1_000,
  budgetWindowMs: 5_000,
  budgetWarmupMs: 1_500,
  budgetMsPerSecond: 60,
  maxThrottle: 2,
  missesToStepDown: 3,
  missesToFail: 6,
  heartbeatMs: 1_000,
  statsMs: 2_000,
  defineTimeoutMs: 2_000,
  restoreTimeoutMs: 1_500,
  energyMediumMsPerSecond: 15,
  energyHeavyMsPerSecond: 60,
  maxFrameDevicePixels: 3_840 * 2_160,
  maxFrameDpr: 2,
  minFps: 1,
};

const LIMITS: BackdropRuntimeLimits = {
  maxScriptChars: THEME_MAX_SCRIPT_CHARS,
  maxFps: THEME_MAX_FPS,
  maxZones: BACKDROP_MAX_ZONES,
  maxTextColors: 32,
  maxGridCells: BACKDROP_MAX_GRID_CELLS,
  maxGlyphs: BACKDROP_MAX_GLYPHS,
  minCell: BACKDROP_MIN_CELL_PX,
  maxCell: BACKDROP_MAX_CELL_PX,
  maxPixelsWidth: BACKDROP_MAX_PIXELS_WIDTH,
  maxPixelsHeight: BACKDROP_MAX_PIXELS_HEIGHT,
  maxCanvasPixels: BACKDROP_MAX_CANVAS_PIXELS,
  maxCanvasDpr: BACKDROP_MAX_CANVAS_DPR,
  maxBackgroundStops: BACKDROP_MAX_BACKGROUND_STOPS,
  maxCellGap: BACKDROP_MAX_CELL_GAP,
  maxStillChars: THEME_MAX_STILL_CHARS,
  maxSlowdown: BACKDROP_MAX_SLOWDOWN,
};

export interface BackdropFrameDocumentOptions {
  /**
   * Adds the browser tests' `test:*` messages (backdropRuntime.ts
   * `onTestMessage`). Never on in the app.
   */
  readonly testHooks?: boolean;
}

const documents = new Map<boolean, string>();

/** The frame's whole document, for `srcdoc`. */
export function buildBackdropFrameDocument(options?: BackdropFrameDocumentOptions): string {
  const testHooks = options?.testHooks === true;
  const cached = documents.get(testHooks);
  if (cached) return cached;
  const runtimeOptions: BackdropFrameRuntimeOptions = {
    prelude: `(${backdropWorkerPrelude.toString()})`,
    testHooks,
    limits: LIMITS,
    timing: BACKDROP_RUNTIME_TIMING,
  };
  const script = `(${backdropFrameRuntime.toString()})((${backdropTintMath.toString()})(), ${scriptLiteral(runtimeOptions)});`;
  // The source goes into a <script> element as is: it must not be able to end it.
  if (/<\/script|<!--/i.test(script)) {
    throw new Error("The backdrop runtime's source can't be inlined into its frame.");
  }
  const built =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${BACKDROP_FRAME_CONTENT_SECURITY_POLICY}">` +
    `</head><body><script>${script}</script></body></html>`;
  documents.set(testHooks, built);
  return built;
}
