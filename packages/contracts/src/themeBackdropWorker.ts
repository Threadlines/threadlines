import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * The messages between the backdrop frame and the art worker it runs
 * (docs/design/custom-themes.md, "The backdrop runtime"). The frame (our
 * code) bakes the worker's generation and the theme's palette into the
 * worker's script, then pulls frames: it sends a `tick`, and the worker's
 * prelude runs the theme's `draw` once and answers with its buffers,
 * transferred, or an ImageBitmap. Every message carries the worker
 * generation it belongs to; the frame drops replies from any generation but
 * the current one.
 *
 * The frame runs in a walled-off document that can't import anything, so it
 * checks these shapes by hand with the same bounds; the schemas are the
 * written contract and the types the runtime is checked against.
 */

/** Most cells a grid may have; a larger window draws bigger cells. */
export const BACKDROP_MAX_GRID_CELLS = 20_000;
/** Most glyphs a grid's glyph set may hold. */
export const BACKDROP_MAX_GLYPHS = 128;
/** Grid cells are this many CSS px at least and at most, each way. */
export const BACKDROP_MIN_CELL_PX = 4;
export const BACKDROP_MAX_CELL_PX = 64;
/** Largest pixel buffer, each way. */
export const BACKDROP_MAX_PIXELS_WIDTH = 640;
export const BACKDROP_MAX_PIXELS_HEIGHT = 400;
/** Largest canvas backing store, in device pixels, and the highest pixel ratio it draws at. */
export const BACKDROP_MAX_CANVAS_PIXELS = 4_000_000;
export const BACKDROP_MAX_CANVAS_DPR = 2;
/** Most stops in a backdrop's background gradient. */
export const BACKDROP_MAX_BACKGROUND_STOPS = 8;
/** Widest gap between grid cells' backgrounds, in device pixels. */
export const BACKDROP_MAX_CELL_GAP = 2;

const Finite = Schema.Number.check(Schema.isFinite());
const Generation = NonNegativeInt;
const CssColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/));
const CellPx = Schema.Number.check(
  Schema.isBetween({ minimum: BACKDROP_MIN_CELL_PX, maximum: BACKDROP_MAX_CELL_PX }),
);

/**
 * Activity across every connected computer, nothing else: what the frame
 * sends with each tick. `draw` sees it as `state`, with `pulse` added (1
 * right after a finished turn, falling to 0 over 2 seconds).
 */
export const BackdropArtState = Schema.Struct({
  working: NonNegativeInt,
  waiting: NonNegativeInt,
  /** Seconds since the last finished turn; very large when there hasn't been one. */
  sincePulse: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BackdropArtState = typeof BackdropArtState.Type;

/** The window in CSS px and its device pixel ratio. */
export const BackdropArtSize = Schema.Struct({
  width: Finite.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  height: Finite.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  dpr: Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 8 })),
});
export type BackdropArtSize = typeof BackdropArtSize.Type;

/** The grid the frame draws: cell size after the cell cap, in CSS px. */
export const BackdropGridGeometry = Schema.Struct({
  cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BACKDROP_MAX_GRID_CELLS })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BACKDROP_MAX_GRID_CELLS })),
  cellWidth: Finite,
  cellHeight: Finite,
});
export type BackdropGridGeometry = typeof BackdropGridGeometry.Type;

export const BackdropPixelsGeometry = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BACKDROP_MAX_PIXELS_WIDTH })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BACKDROP_MAX_PIXELS_HEIGHT })),
});
export type BackdropPixelsGeometry = typeof BackdropPixelsGeometry.Type;

/** The canvas backing store in device px, and device px per CSS px. */
export const BackdropCanvasGeometry = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  scale: Finite.check(Schema.isBetween({ minimum: 0.01, maximum: BACKDROP_MAX_CANVAS_DPR })),
});
export type BackdropCanvasGeometry = typeof BackdropCanvasGeometry.Type;

/**
 * Asks for one frame. Exactly one geometry matches the art's mode. `spare`
 * hands back buffers of an earlier frame (transferred) for the worker to
 * reuse, so drawing doesn't allocate every frame; their contents are stale.
 */
export const BackdropWorkerTick = Schema.Struct({
  type: Schema.Literal("tick"),
  generation: Generation,
  frame: NonNegativeInt,
  /** Art time in seconds; it only runs while the art does, and continues after a pause. */
  t: Finite,
  /** Seconds since the previous frame. */
  dt: Finite,
  state: BackdropArtState,
  size: BackdropArtSize,
  grid: Schema.optional(BackdropGridGeometry),
  pixels: Schema.optional(BackdropPixelsGeometry),
  canvas: Schema.optional(BackdropCanvasGeometry),
  spare: Schema.optional(Schema.Array(Schema.instanceOf(ArrayBuffer)).check(Schema.isMaxLength(3))),
});
export type BackdropWorkerTick = typeof BackdropWorkerTick.Type;

/**
 * What the theme declared with `threadlines.backdrop({...})`, minus `setup`
 * and `draw`. Sent once, as soon as the theme's script has run.
 */
export const BackdropArtDefinition = Schema.Struct({
  type: Schema.Literal("defined"),
  generation: Generation,
  mode: Schema.Literals(["grid", "pixels", "canvas"]),
  /** Grid: cell size in CSS px. */
  cell: Schema.optional(Schema.Struct({ width: CellPx, height: CellPx })),
  /** Grid: the glyph set, one glyph per code point; `glyph` values index it. */
  glyphs: Schema.optional(Schema.String.check(Schema.isMaxLength(BACKDROP_MAX_GLYPHS * 2))),
  /** Grid: glyph size in CSS px (default: 80% of the cell height) and weight. */
  fontSize: Schema.optional(CellPx),
  fontWeight: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900 }))),
  /** Pixels: a fixed buffer, scaled to cover the window... */
  width: Schema.optional(BackdropPixelsGeometry.fields.width),
  height: Schema.optional(BackdropPixelsGeometry.fields.height),
  /** ...or one CSS px-per-pixel scale, the buffer following the window's shape. */
  scale: Schema.optional(Finite.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  /** Pixels: scale smoothly (painterly low-res art) instead of crisp. */
  smooth: Schema.optional(Schema.Boolean),
  /** Canvas: the context the art draws with. */
  context: Schema.optional(Schema.Literals(["2d", "webgl2"])),
  /** Grid and pixels: a gradient under the art, top to bottom unless angled; the theme background otherwise. */
  background: Schema.optional(
    Schema.Array(CssColor).check(Schema.isMaxLength(BACKDROP_MAX_BACKGROUND_STOPS)),
  ),
  /** Grid and pixels: the gradient's direction in degrees, as CSS linear-gradient reads it (180, top to bottom, by default). */
  backgroundAngle: Schema.optional(Finite.check(Schema.isBetween({ minimum: 0, maximum: 360 }))),
  /** Grid: device pixels left open between neighboring cells' backgrounds, where the gradient shows through (0 by default). */
  gap: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: BACKDROP_MAX_CELL_GAP })),
  ),
});
export type BackdropArtDefinition = typeof BackdropArtDefinition.Type;

/** Milliseconds the worker spent on a frame (the prelude's clock around setup, draw and packing). */
const FrameWork = Schema.optional(Finite.check(Schema.isGreaterThanOrEqualTo(0)));

/** A grid frame: `glyph` is Int16 (index into the glyph set, -1 empty), `fg` and `bg` RGBA bytes per cell. */
export const BackdropGridFrame = Schema.Struct({
  type: Schema.Literal("grid"),
  generation: Generation,
  frame: NonNegativeInt,
  work: FrameWork,
  cols: BackdropGridGeometry.fields.cols,
  rows: BackdropGridGeometry.fields.rows,
  glyph: Schema.instanceOf(ArrayBuffer),
  fg: Schema.instanceOf(ArrayBuffer),
  bg: Schema.instanceOf(ArrayBuffer),
});
export type BackdropGridFrame = typeof BackdropGridFrame.Type;

/** A pixel frame: RGBA bytes, row by row from the top. */
export const BackdropPixelsFrame = Schema.Struct({
  type: Schema.Literal("pixels"),
  generation: Generation,
  frame: NonNegativeInt,
  work: FrameWork,
  width: BackdropPixelsGeometry.fields.width,
  height: BackdropPixelsGeometry.fields.height,
  data: Schema.instanceOf(ArrayBuffer),
});
export type BackdropPixelsFrame = typeof BackdropPixelsFrame.Type;

/**
 * An ImageBitmap, described by shape: contracts compile without the DOM's
 * types (the server, scripts), and the check never names a global that may
 * not exist.
 */
export interface BackdropBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}
const isBitmap = (input: unknown): input is BackdropBitmap => {
  const constructor = (globalThis as { ImageBitmap?: abstract new () => unknown }).ImageBitmap;
  return constructor !== undefined && input instanceof constructor;
};
const Bitmap = Schema.declare(isBitmap, { title: "ImageBitmap" });

export const BackdropCanvasFrame = Schema.Struct({
  type: Schema.Literal("canvas"),
  generation: Generation,
  frame: NonNegativeInt,
  work: FrameWork,
  bitmap: Bitmap,
});
export type BackdropCanvasFrame = typeof BackdropCanvasFrame.Type;

/** The theme's script, `setup` or `draw` threw, or it broke the contract. */
export const BackdropArtError = Schema.Struct({
  type: Schema.Literal("error"),
  generation: Generation,
  phase: Schema.Literals(["define", "setup", "draw"]),
  message: Schema.String.check(Schema.isMaxLength(500)),
});
export type BackdropArtError = typeof BackdropArtError.Type;

/**
 * The prelude has run and the theme's script starts. Sent once, first: the
 * frame gives the script its time to call `threadlines.backdrop({...})` from
 * here, so a worker slow to launch on a busy machine isn't blamed on the art.
 */
export const BackdropWorkerBooted = Schema.Struct({
  type: Schema.Literal("booted"),
  generation: Generation,
});
export type BackdropWorkerBooted = typeof BackdropWorkerBooted.Type;

export const BackdropWorkerReply = Schema.Union([
  BackdropWorkerBooted,
  BackdropArtDefinition,
  BackdropGridFrame,
  BackdropPixelsFrame,
  BackdropCanvasFrame,
  BackdropArtError,
]);
export type BackdropWorkerReply = typeof BackdropWorkerReply.Type;
