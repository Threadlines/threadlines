/**
 * The art worker's prelude (docs/design/custom-themes.md, "The backdrop
 * runtime"): our code that runs first in every art worker, before the
 * theme's script, in the same blob.
 *
 * It takes away what art has no use for (spawning workers, scheduling its
 * own work, talking back except through the reply), defines
 * `threadlines.backdrop({...})`, and answers the frame's ticks by running the
 * theme's `draw` once per tick. Taking things away is defense in depth: the
 * frame's content policy and its tick timing are what actually hold the art
 * in, and they don't depend on this.
 *
 * `backdropWorkerPrelude` is closed (it refers to nothing outside itself) so
 * the frame can inline it as source; see backdropFrame.ts.
 *
 * The draw contract a theme script sees:
 *
 *   threadlines.backdrop({
 *     mode: "grid", cell: { width: 11, height: 15 }, glyphs: " .:+#",
 *     fontSize?, fontWeight?, background?: ["#top", ..., "#bottom"],
 *     setup?(info), draw(grid, info),
 *   })
 *   threadlines.backdrop({ mode: "pixels", width, height | scale, smooth?, background?, setup?(info), draw(pixels, info) })
 *   threadlines.backdrop({ mode: "canvas", context: "2d" | "webgl2", setup?(info), draw(ctx, info) })
 *
 * - grid: `grid.glyph` Int16Array (index into `glyphs`, -1 empty),
 *   `grid.fg` / `grid.bg` Uint8Array RGBA per cell, `grid.cols`, `grid.rows`.
 *   Buffers persist between frames.
 * - pixels: `pixels.data` Uint8ClampedArray RGBA rows from the top,
 *   `pixels.u32` the same bytes as Uint32Array (little-endian 0xAABBGGRR),
 *   `pixels.width`, `pixels.height`. A fixed `width`×`height` buffer is
 *   scaled to cover the window; with `scale` the buffer follows the window
 *   at one pixel per `scale` CSS px. `smooth: true` scales it smoothly.
 * - canvas: an OffscreenCanvas context sized to the window (pixel ratio at
 *   most 2, at most 4 megapixels); a 2d context arrives scaled so the art
 *   draws in CSS px. Draw the whole frame each time.
 * - info: `{ t, dt, frame, cols, rows, width, height, state, palette }`.
 *   `t` is seconds of art time; `cols` and `rows` the drawing target's size
 *   in its own units (cells, buffer pixels, or canvas pixels); `width` and
 *   `height` the window in CSS px; `state` `{ working, waiting, pulse,
 *   sincePulse }`: agents working and waiting across every computer, `pulse`
 *   1 right after a finished turn falling to 0 over 2 seconds, `sincePulse`
 *   the seconds since that turn (very large when none); `palette` the
 *   theme's colors by token name. Grid mode adds `cell` (CSS px), canvas
 *   mode `scale` (canvas pixels per CSS px).
 * - `setup(info)` runs before the first draw, when the window size changes,
 *   and when the art resumes after a pause (a new worker each time, its state
 *   fresh; the frame fades the last picture into it). It also gets the
 *   drawing target, second.
 */
import type {
  BackdropArtDefinition,
  BackdropArtError,
  BackdropWorkerReply,
  BackdropWorkerTick,
} from "@threadlines/contracts/themeBackdropWorker";

import type {
  BackdropBitmap,
  BackdropOffscreenCanvas,
  BackdropWorkerScope,
} from "./backdropDom.ts";

/** What the frame bakes into each worker's blob, ahead of the prelude. */
export interface BackdropWorkerConfig {
  readonly generation: number;
  readonly palette: Readonly<Record<string, string>>;
  readonly limits: {
    readonly maxGlyphs: number;
    readonly minCell: number;
    readonly maxCell: number;
    readonly maxPixelsWidth: number;
    readonly maxPixelsHeight: number;
    readonly maxBackgroundStops: number;
    readonly maxCellGap: number;
  };
}

export function backdropWorkerPrelude(config: BackdropWorkerConfig): void {
  "use strict";
  type Reply = BackdropWorkerReply;
  type Definition = {
    -readonly [
      Key in keyof Omit<BackdropArtDefinition, "type" | "generation">
    ]: BackdropArtDefinition[Key];
  } & {
    setup?: (info: unknown, target: unknown) => void;
    draw: (target: unknown, info: unknown) => void;
  };
  // The worker's global scope, typed by shape (backdropDom.ts): this module compiles without the DOM's types too.
  const scope = globalThis as unknown as BackdropWorkerScope;
  const generation = config.generation;
  // Taken before the theme's script runs, so the work each frame reports is the real clock's.
  const clockSource = (globalThis as { performance?: { now(): number } }).performance;
  const clock = clockSource ? clockSource.now.bind(clockSource) : () => Date.now();
  const post = scope.postMessage.bind(scope) as (
    message: Reply,
    transfer?: Array<ArrayBuffer | BackdropBitmap>,
  ) => void;

  // Defense in depth: the content policy blocks the network and nested
  // scripts whatever happens here.
  const remove = (target: object, name: string) => {
    try {
      Object.defineProperty(target, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {
      // Already locked by the platform: nothing to take away.
    }
  };
  const lock = (target: object, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, {
        value,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {
      // As above.
    }
  };
  const ownProto = Object.getPrototypeOf(globalThis) as object | null;
  if (ownProto && Object.prototype.hasOwnProperty.call(ownProto, "postMessage")) {
    try {
      delete (ownProto as { postMessage?: unknown }).postMessage;
    } catch {
      // Non-configurable here; the shadow below still hides it.
    }
  }
  for (const name of [
    "postMessage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "Worker",
    "SharedWorker",
    "importScripts",
    "MessageChannel",
    "BroadcastChannel",
    "scheduler",
  ]) {
    remove(globalThis, name);
  }
  // Kept for the prelude alone, before the theme's script can reach timers.
  const timerSource = (globalThis as { setTimeout?: (handler: () => void, ms?: number) => unknown })
    .setTimeout;
  const afterMicrotasks = timerSource ? timerSource.bind(globalThis) : null;
  const noTimers = () => {
    throw new Error("Backdrop art draws only when the frame asks: timers are not available.");
  };
  lock(globalThis, "setTimeout", noTimers);
  lock(globalThis, "setInterval", noTimers);

  let definition: Definition | null = null;
  /**
   * Work the art left queued after a frame (promise callbacks run once the
   * reply is posted), counted with the next frame. A zero-delay timer fires
   * only after those callbacks drain; its own delay, under a millisecond,
   * is not counted.
   */
  let trailingWork = 0;
  const TIMER_SLACK_MS = 1;
  const measureTrailing = () => {
    if (!afterMicrotasks) return;
    const postedAt = clock();
    afterMicrotasks(() => {
      trailingWork += Math.max(0, clock() - postedAt - TIMER_SLACK_MS);
    }, 0);
  };
  const takeWork = (startedAt: number) => {
    const work = clock() - startedAt + trailingWork;
    trailingWork = 0;
    return work;
  };
  let failed = false;
  let drawing = false;

  const describe = (error: unknown) => {
    const text =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : typeof error === "string"
          ? error
          : "Unknown error";
    return text.length > 480 ? `${text.slice(0, 479)}…` : text;
  };
  const fail = (phase: BackdropArtError["phase"], error: unknown) => {
    if (failed) return;
    failed = true;
    post({ type: "error", generation, phase, message: describe(error) });
  };

  // Uncaught errors in the theme's script (top level, or anything it ran
  // outside draw) are reported once, with the phase they broke.
  scope.addEventListener("error", (event) => {
    event.preventDefault();
    fail(definition ? "draw" : "define", event.error ?? event.message);
  });
  scope.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    fail(definition ? "draw" : "define", event.reason);
  });

  const isInt = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  const isNumber = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

  /** The theme's declaration, checked here so its author gets a precise message. */
  const check = (input: unknown): Definition | string => {
    if (typeof input !== "object" || input === null)
      return "Pass an object to threadlines.backdrop().";
    const raw = input as Record<string, unknown>;
    if (typeof raw.draw !== "function") return "threadlines.backdrop() needs a draw function.";
    if (raw.setup !== undefined && typeof raw.setup !== "function")
      return "setup must be a function.";
    const out: Definition = {
      mode: "grid",
      draw: raw.draw as Definition["draw"],
      ...(raw.setup ? { setup: raw.setup as NonNullable<Definition["setup"]> } : {}),
    };
    if (raw.background !== undefined) {
      const stops = raw.background;
      if (
        !Array.isArray(stops) ||
        stops.length === 0 ||
        stops.length > config.limits.maxBackgroundStops ||
        !stops.every((stop) => typeof stop === "string" && HEX.test(stop))
      ) {
        return `background must be 1 to ${config.limits.maxBackgroundStops} colors like "#0a1029".`;
      }
      if (raw.mode === "canvas")
        return "background is for grid and pixels modes; a canvas paints its own.";
      out.background = stops as string[];
    }
    if (raw.backgroundAngle !== undefined) {
      if (raw.background === undefined) return "backgroundAngle needs background colors to turn.";
      if (!isNumber(raw.backgroundAngle, 0, 360))
        return "backgroundAngle must be degrees from 0 to 360 (180 runs top to bottom).";
      out.backgroundAngle = raw.backgroundAngle;
    }
    if (raw.mode === "grid") {
      const cell = raw.cell as { width?: unknown; height?: unknown } | undefined;
      const { minCell, maxCell } = config.limits;
      if (
        !cell ||
        !isNumber(cell.width, minCell, maxCell) ||
        !isNumber(cell.height, minCell, maxCell)
      ) {
        return `grid mode needs cell: { width, height } between ${minCell} and ${maxCell} px.`;
      }
      if (typeof raw.glyphs !== "string" || raw.glyphs.length === 0) {
        return 'grid mode needs glyphs: a string like " .:+#".';
      }
      if ([...raw.glyphs].length > config.limits.maxGlyphs) {
        return `glyphs may hold at most ${config.limits.maxGlyphs} characters.`;
      }
      if (raw.fontSize !== undefined && !isNumber(raw.fontSize, minCell, maxCell)) {
        return `fontSize must be between ${minCell} and ${maxCell} px.`;
      }
      if (raw.fontWeight !== undefined && !isInt(raw.fontWeight, 100, 900)) {
        return "fontWeight must be a whole number from 100 to 900.";
      }
      if (raw.gap !== undefined && !isInt(raw.gap, 0, config.limits.maxCellGap)) {
        return `gap must be a whole number of device pixels from 0 to ${config.limits.maxCellGap}.`;
      }
      out.mode = "grid";
      out.cell = { width: cell.width, height: cell.height };
      out.glyphs = raw.glyphs;
      if (raw.fontSize !== undefined) out.fontSize = raw.fontSize;
      if (raw.fontWeight !== undefined) out.fontWeight = raw.fontWeight;
      if (raw.gap !== undefined && raw.gap > 0) out.gap = raw.gap;
      return out;
    }
    if (raw.mode === "pixels") {
      const { maxPixelsWidth, maxPixelsHeight } = config.limits;
      const fixed = raw.width !== undefined || raw.height !== undefined;
      if (fixed && raw.scale !== undefined)
        return "pixels mode takes width and height, or scale, not both.";
      if (fixed) {
        if (!isInt(raw.width, 1, maxPixelsWidth) || !isInt(raw.height, 1, maxPixelsHeight)) {
          return `pixels mode: width at most ${maxPixelsWidth} and height at most ${maxPixelsHeight}, whole numbers.`;
        }
        out.width = raw.width;
        out.height = raw.height;
      } else {
        if (!isNumber(raw.scale, 1, 64)) {
          return "pixels mode needs width and height, or scale (CSS px per pixel, 1 to 64).";
        }
        out.scale = raw.scale;
      }
      if (raw.smooth !== undefined && typeof raw.smooth !== "boolean")
        return "smooth must be true or false.";
      out.mode = "pixels";
      if (raw.smooth === true) out.smooth = true;
      return out;
    }
    if (raw.mode === "canvas") {
      if (raw.context !== "2d" && raw.context !== "webgl2")
        return 'canvas mode needs context: "2d" or "webgl2".';
      out.mode = "canvas";
      out.context = raw.context;
      return out;
    }
    return 'mode must be "grid", "pixels" or "canvas".';
  };

  const backdrop = (input: unknown) => {
    if (definition || failed) {
      fail("define", new Error("Call threadlines.backdrop() once."));
      return;
    }
    const checked = check(input);
    if (typeof checked === "string") {
      fail("define", new Error(checked));
      return;
    }
    definition = checked;
    const { draw: _draw, setup: _setup, ...declared } = checked;
    post({ type: "defined", generation, ...declared });
  };
  lock(globalThis, "threadlines", Object.freeze({ backdrop }));

  // Runs once the theme's script (the rest of this blob) has finished.
  queueMicrotask(() => {
    if (!definition) fail("define", new Error("The art never called threadlines.backdrop({...})."));
  });

  // The drawing target and what it was sized for.
  let sizedFor = "";
  let grid: {
    glyph: Int16Array;
    fg: Uint8Array;
    bg: Uint8Array;
    cols: number;
    rows: number;
  } | null = null;
  let pixels: {
    data: Uint8ClampedArray;
    u32: Uint32Array;
    width: number;
    height: number;
  } | null = null;
  let canvas: BackdropOffscreenCanvas | null = null;
  let context: object | null = null;
  /** A 2d context draws in CSS px: its transform is reset to the canvas scale before setup and each draw. */
  const scaleContext = () => {
    const target = context as { setTransform?: (...values: number[]) => void } | null;
    if (target && typeof target.setTransform === "function") {
      target.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
    }
  };
  let canvasScale = 1;

  /** Reuses a spare buffer from the frame when it fits, so frames don't allocate. */
  const copyOut = (source: ArrayBufferView, spare: ArrayBuffer | undefined): ArrayBuffer => {
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    if (spare && spare.byteLength === bytes.byteLength) {
      new Uint8Array(spare).set(bytes);
      return spare;
    }
    return bytes.slice().buffer;
  };

  const onTick = (tick: BackdropWorkerTick) => {
    const art = definition;
    if (!art || failed || drawing) return;
    const startedAt = clock();
    const info: Record<string, unknown> = {
      t: tick.t,
      dt: tick.dt,
      frame: tick.frame,
      width: tick.size.width,
      height: tick.size.height,
      state: Object.freeze({
        ...tick.state,
        pulse: Math.max(0, 1 - tick.state.sincePulse / 2),
      }),
      palette: config.palette,
    };
    let target: unknown;
    let key: string;
    if (art.mode === "grid" && tick.grid) {
      const { cols, rows } = tick.grid;
      info.cols = cols;
      info.rows = rows;
      info.cell = { width: tick.grid.cellWidth, height: tick.grid.cellHeight };
      key = `${cols}x${rows}`;
      if (!grid || key !== sizedFor) {
        const glyph = new Int16Array(cols * rows).fill(-1);
        grid = {
          glyph,
          fg: new Uint8Array(cols * rows * 4),
          bg: new Uint8Array(cols * rows * 4),
          cols,
          rows,
        };
      }
      target = grid;
    } else if (art.mode === "pixels" && tick.pixels) {
      const { width, height } = tick.pixels;
      info.cols = width;
      info.rows = height;
      key = `${width}x${height}`;
      if (!pixels || key !== sizedFor) {
        const buffer = new ArrayBuffer(width * height * 4);
        pixels = {
          data: new Uint8ClampedArray(buffer),
          u32: new Uint32Array(buffer),
          width,
          height,
        };
      }
      target = pixels;
    } else if (art.mode === "canvas" && tick.canvas) {
      const { width, height, scale } = tick.canvas;
      info.cols = width;
      info.rows = height;
      key = `${width}x${height}`;
      if (!canvas) {
        canvas = new scope.OffscreenCanvas(width, height);
        context =
          art.context === "webgl2"
            ? canvas.getContext("webgl2", {
                alpha: true,
                antialias: false,
                premultipliedAlpha: true,
              })
            : canvas.getContext("2d", { alpha: true });
        if (!context) {
          fail("setup", new Error(`This computer can't give the art a ${art.context} context.`));
          return;
        }
      } else if (key !== sizedFor) {
        canvas.width = width;
        canvas.height = height;
      }
      canvasScale = scale;
      info.scale = scale;
      target = context;
    } else {
      return;
    }
    drawing = true;
    try {
      if (key !== sizedFor) {
        sizedFor = key;
        if (art.setup) {
          try {
            scaleContext();
            art.setup(info, target);
          } catch (error) {
            fail("setup", error);
            return;
          }
        }
      }
      try {
        scaleContext();
        art.draw(target, info);
      } catch (error) {
        fail("draw", error);
        return;
      }
    } finally {
      drawing = false;
    }
    const spare = tick.spare ?? [];
    if (art.mode === "grid" && grid) {
      const glyph = copyOut(grid.glyph, spare[0]);
      const fg = copyOut(grid.fg, spare[1]);
      const bg = copyOut(grid.bg, spare[2]);
      post(
        {
          type: "grid",
          generation,
          frame: tick.frame,
          work: takeWork(startedAt),
          cols: grid.cols,
          rows: grid.rows,
          glyph,
          fg,
          bg,
        },
        [glyph, fg, bg],
      );
    } else if (art.mode === "pixels" && pixels) {
      const data = copyOut(pixels.data, spare[0]);
      post(
        {
          type: "pixels",
          generation,
          frame: tick.frame,
          work: takeWork(startedAt),
          width: pixels.width,
          height: pixels.height,
          data,
        },
        [data],
      );
    } else if (canvas) {
      const bitmap = canvas.transferToImageBitmap();
      post({ type: "canvas", generation, frame: tick.frame, work: takeWork(startedAt), bitmap }, [
        bitmap,
      ]);
    }
    measureTrailing();
  };

  scope.addEventListener("message", (event) => {
    const message = event.data as BackdropWorkerTick | undefined;
    if (!message || message.type !== "tick" || message.generation !== generation) return;
    onTick(message);
  });

  // The theme's script runs next: its time to define the art starts now.
  post({ type: "booted", generation });
}
