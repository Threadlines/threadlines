import * as NodeZlib from "node:zlib";

/**
 * Procedurally generated desktop status glyphs.
 *
 * macOS status item: the mark mirrors the Threadlines brand glyph
 * (docs/brand/svg) — a main thread line with a commit dot, and a branch curving
 * down to an accent node. Template rendering only reads the alpha channel,
 * which lets the glyph keep the brand's opacity hierarchy (faint line, gradient
 * branch, full-strength node).
 *
 * Windows taskbar: colored overlay chips (accent while running, green when
 * completed) carrying a thread count drawn with a small vector digit set.
 *
 * Shapes are rasterized as signed-distance fields so edges stay anti-aliased,
 * and each glyph carries 1x and 2x PNG representations so it stays crisp on
 * high-DPI displays.
 */

export const TRAY_GLYPH_SIZE_PT = 18;
export const TASKBAR_OVERLAY_SIZE_PT = 16;
export const TRAY_WORKING_FRAME_INTERVAL_MS = 120;
export const TRAY_COMPLETED_FRAME_INTERVAL_MS = 70;

const GLYPH_SCALE_FACTORS = [1, 2] as const;
const TRAY_WORKING_FRAME_COUNT = 12;
const BEZIER_FLATTEN_STEPS = 24;

export interface TrayGlyphRepresentation {
  readonly scaleFactor: number;
  readonly dataUrl: string;
}

export interface TrayGlyph {
  readonly representations: readonly TrayGlyphRepresentation[];
}

export interface MacTrayGlyphSet {
  readonly idle: TrayGlyph;
  readonly workingFrames: readonly TrayGlyph[];
  readonly completedFrames: readonly TrayGlyph[];
}

interface Vec {
  readonly x: number;
  readonly y: number;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface StrokeShape {
  readonly kind: "stroke";
  readonly points: readonly Vec[];
  readonly width: number;
  readonly alphaStart: number;
  readonly alphaEnd: number;
  /** Only used by layered (color) rendering; mask rendering stays black. */
  readonly color?: Rgb;
}

interface CircleShape {
  readonly kind: "circle";
  readonly center: Vec;
  readonly radius: number;
  readonly alpha: number;
  readonly color?: Rgb;
}

type GlyphShape = StrokeShape | CircleShape;

interface RenderOptions {
  readonly sizePt: number;
  /**
   * "mask": alpha-only template output; overlapping translucent shapes merge
   * via max so intersections do not darken.
   * "layered": shapes composite source-over in order with their colors.
   */
  readonly compositing: "mask" | "layered";
}

// Brand-glyph geometry in 18x18 point space, scaled from
// docs/brand/svg/threadlines-icon-small.svg (the small-size variant that drops
// to a single commit dot and exaggerates stroke weight).
const MAIN_LINE_Y = 5.6;
const MAIN_LINE_START: Vec = { x: 1.7, y: MAIN_LINE_Y };
const MAIN_LINE_END: Vec = { x: 16.3, y: MAIN_LINE_Y };
const MAIN_LINE_ALPHA = 0.5;
const COMMIT_DOT: CircleShape = {
  kind: "circle",
  center: { x: 4.8, y: MAIN_LINE_Y },
  radius: 0.95,
  alpha: 0.85,
};
const BRANCH_Y = 11.1;
const BRANCH_FORK: Vec = { x: 7.2, y: MAIN_LINE_Y };
const BRANCH_CONTROL_1: Vec = { x: 9.2, y: MAIN_LINE_Y };
const BRANCH_CONTROL_2: Vec = { x: 9.2, y: BRANCH_Y };
const BRANCH_CURVE_END: Vec = { x: 11.2, y: BRANCH_Y };
const BRANCH_TAIL_END: Vec = { x: 12.4, y: BRANCH_Y };
const BRANCH_ALPHA_START = 0.55;
const THREAD_STROKE_WIDTH = 1.5;
const NODE_CENTER: Vec = { x: 14.1, y: BRANCH_Y };
const NODE_RADIUS = 1.7;
const NODE_HALO_RADIUS = 2.5;
const NODE_HALO_ALPHA = 0.22;

// Working animation: a comet bead emerges from the main line just before the
// fork, travels down the branch, and merges into the node, which answers with
// a soft halo pulse that decays before the loop wraps.
const WORKING_NODE_PULSE_CENTER = 0.82;
const WORKING_NODE_PULSE_SIGMA = 0.09;
const WORKING_BEAD_START: Vec = { x: 5.9, y: MAIN_LINE_Y };
const WORKING_BEADS = [
  { progressOffset: 0, radius: 1.25, alpha: 1 },
  { progressOffset: 0.07, radius: 0.95, alpha: 0.4 },
  { progressOffset: 0.14, radius: 0.75, alpha: 0.18 },
] as const;

const COMPLETED_CHECK_POINTS: readonly Vec[] = [
  { x: 4.7, y: 9.9 },
  { x: 7.6, y: 12.8 },
  { x: 13.3, y: 5.8 },
];
const COMPLETED_CHECK_STROKE_WIDTH = 1.9;
// One-shot pop: the check scales in with a slight overshoot and settles.
const COMPLETED_POP_FRAMES = [
  { scale: 0.55, alpha: 0.4 },
  { scale: 0.85, alpha: 0.8 },
  { scale: 1.1, alpha: 1 },
  { scale: 1, alpha: 1 },
] as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function easeInOutSine(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
}

function flattenCubic(from: Vec, control1: Vec, control2: Vec, to: Vec): Vec[] {
  const points: Vec[] = [];
  for (let step = 0; step <= BEZIER_FLATTEN_STEPS; step += 1) {
    const t = step / BEZIER_FLATTEN_STEPS;
    const u = 1 - t;
    points.push({
      x:
        u * u * u * from.x +
        3 * u * u * t * control1.x +
        3 * u * t * t * control2.x +
        t * t * t * to.x,
      y:
        u * u * u * from.y +
        3 * u * u * t * control1.y +
        3 * u * t * t * control2.y +
        t * t * t * to.y,
    });
  }
  return points;
}

const BRANCH_POINTS: readonly Vec[] = [
  ...flattenCubic(BRANCH_FORK, BRANCH_CONTROL_1, BRANCH_CONTROL_2, BRANCH_CURVE_END),
  BRANCH_TAIL_END,
];

// Path the working bead travels: out of the main line, down the branch, into
// the node.
const BEAD_PATH_POINTS: readonly Vec[] = [WORKING_BEAD_START, ...BRANCH_POINTS, NODE_CENTER];

interface CompiledSegment {
  readonly from: Vec;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly lengthSquared: number;
  readonly length: number;
  readonly startLength: number;
}

interface CompiledPath {
  readonly segments: readonly CompiledSegment[];
  readonly totalLength: number;
}

function compilePath(points: readonly Vec[]): CompiledPath {
  const segments: CompiledSegment[] = [];
  let runningLength = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    const deltaX = to.x - from.x;
    const deltaY = to.y - from.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    if (lengthSquared === 0) {
      continue;
    }
    const length = Math.sqrt(lengthSquared);
    segments.push({ from, deltaX, deltaY, lengthSquared, length, startLength: runningLength });
    runningLength += length;
  }
  return { segments, totalLength: runningLength };
}

const COMPILED_BEAD_PATH = compilePath(BEAD_PATH_POINTS);

function pointAlongPath(path: CompiledPath, t: number): Vec {
  const target = clamp01(t) * path.totalLength;
  for (const segment of path.segments) {
    if (target <= segment.startLength + segment.length) {
      const local = segment.length === 0 ? 0 : (target - segment.startLength) / segment.length;
      return {
        x: segment.from.x + segment.deltaX * local,
        y: segment.from.y + segment.deltaY * local,
      };
    }
  }
  const last = path.segments.at(-1);
  return last === undefined
    ? { x: 0, y: 0 }
    : { x: last.from.x + last.deltaX, y: last.from.y + last.deltaY };
}

interface CompiledShape {
  readonly shape: GlyphShape;
  readonly path: CompiledPath | null;
}

function compileShape(shape: GlyphShape): CompiledShape {
  return { shape, path: shape.kind === "stroke" ? compilePath(shape.points) : null };
}

// Signed distance from the sample point, minus an alpha for the nearest spot on
// the shape (strokes fade along their length between alphaStart and alphaEnd).
function sampleShape(
  compiled: CompiledShape,
  x: number,
  y: number,
): { distance: number; alpha: number } {
  const { shape, path } = compiled;
  if (shape.kind === "circle") {
    const distance = Math.hypot(x - shape.center.x, y - shape.center.y) - shape.radius;
    return { distance, alpha: shape.alpha };
  }

  if (path === null || path.segments.length === 0) {
    return { distance: Number.POSITIVE_INFINITY, alpha: 0 };
  }

  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let lengthAtBest = 0;
  for (const segment of path.segments) {
    const local = clamp01(
      ((x - segment.from.x) * segment.deltaX + (y - segment.from.y) * segment.deltaY) /
        segment.lengthSquared,
    );
    const nearestX = segment.from.x + segment.deltaX * local;
    const nearestY = segment.from.y + segment.deltaY * local;
    const distanceSquared = (x - nearestX) * (x - nearestX) + (y - nearestY) * (y - nearestY);
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      lengthAtBest = segment.startLength + segment.length * local;
    }
  }

  const distance = Math.sqrt(bestDistanceSquared) - shape.width / 2;
  const alphaT = path.totalLength === 0 ? 0 : lengthAtBest / path.totalLength;
  return { distance, alpha: lerp(shape.alphaStart, shape.alphaEnd, alphaT) };
}

function renderShapes(
  shapes: readonly GlyphShape[],
  scaleFactor: number,
  options: RenderOptions,
): Buffer {
  const size = options.sizePt * scaleFactor;
  const compiledShapes = shapes.map(compileShape);
  const rgba = Buffer.alloc(size * size * 4);
  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    const y = (pixelY + 0.5) / scaleFactor;
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      const x = (pixelX + 0.5) / scaleFactor;
      // Premultiplied accumulators; mask mode only uses `alpha`.
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const compiled of compiledShapes) {
        const sample = sampleShape(compiled, x, y);
        // One-device-pixel smoothstep across the shape edge for anti-aliasing.
        const coverage = clamp01(0.5 - sample.distance * scaleFactor);
        const sourceAlpha = coverage * sample.alpha;
        if (options.compositing === "mask") {
          alpha = Math.max(alpha, sourceAlpha);
          continue;
        }
        if (sourceAlpha <= 0) {
          continue;
        }
        const color = compiled.shape.color ?? { r: 0, g: 0, b: 0 };
        red = (color.r / 255) * sourceAlpha + red * (1 - sourceAlpha);
        green = (color.g / 255) * sourceAlpha + green * (1 - sourceAlpha);
        blue = (color.b / 255) * sourceAlpha + blue * (1 - sourceAlpha);
        alpha = sourceAlpha + alpha * (1 - sourceAlpha);
      }
      if (alpha > 0) {
        const offset = (pixelY * size + pixelX) * 4;
        // PNG stores straight (non-premultiplied) color.
        rgba[offset] = Math.round((red / alpha) * 255);
        rgba[offset + 1] = Math.round((green / alpha) * 255);
        rgba[offset + 2] = Math.round((blue / alpha) * 255);
        rgba[offset + 3] = Math.round(alpha * 255);
      }
    }
  }
  return rgba;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) {
    return crcTable;
  }
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let row = 0; row < size; row += 1) {
    rgba.copy(raw, row * (1 + size * 4) + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildGlyph(shapes: readonly GlyphShape[], options: RenderOptions): TrayGlyph {
  return {
    representations: GLYPH_SCALE_FACTORS.map((scaleFactor) => {
      const size = options.sizePt * scaleFactor;
      const png = encodePng(size, renderShapes(shapes, scaleFactor, options));
      return { scaleFactor, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
    }),
  };
}

const TRAY_RENDER_OPTIONS: RenderOptions = { sizePt: TRAY_GLYPH_SIZE_PT, compositing: "mask" };

function threadShapes(input: {
  readonly nodeRadius: number;
  readonly haloRadius: number;
  readonly haloAlpha: number;
}): GlyphShape[] {
  return [
    { kind: "circle", center: NODE_CENTER, radius: input.haloRadius, alpha: input.haloAlpha },
    {
      kind: "stroke",
      points: [MAIN_LINE_START, MAIN_LINE_END],
      width: THREAD_STROKE_WIDTH,
      alphaStart: MAIN_LINE_ALPHA,
      alphaEnd: MAIN_LINE_ALPHA,
    },
    COMMIT_DOT,
    {
      kind: "stroke",
      points: BRANCH_POINTS,
      width: THREAD_STROKE_WIDTH,
      alphaStart: BRANCH_ALPHA_START,
      alphaEnd: 1,
    },
    { kind: "circle", center: NODE_CENTER, radius: input.nodeRadius, alpha: 1 },
  ];
}

function idleShapes(): GlyphShape[] {
  return threadShapes({
    nodeRadius: NODE_RADIUS,
    haloRadius: NODE_HALO_RADIUS,
    haloAlpha: NODE_HALO_ALPHA,
  });
}

function workingShapes(frameIndex: number): GlyphShape[] {
  const progress = frameIndex / TRAY_WORKING_FRAME_COUNT;
  const pulseDelta = progress - WORKING_NODE_PULSE_CENTER;
  const pulse = Math.exp(
    -(pulseDelta * pulseDelta) / (2 * WORKING_NODE_PULSE_SIGMA * WORKING_NODE_PULSE_SIGMA),
  );
  const shapes = threadShapes({
    nodeRadius: NODE_RADIUS + 0.45 * pulse,
    haloRadius: NODE_HALO_RADIUS + 0.7 * pulse,
    haloAlpha: NODE_HALO_ALPHA + 0.3 * pulse,
  });

  for (const bead of WORKING_BEADS) {
    const beadProgress = progress - bead.progressOffset;
    if (beadProgress < 0) {
      continue;
    }
    // Fade the bead in as it leaves the line start and out as it merges into
    // the node, so the loop wrap reads as a pulse being emitted.
    const fade = clamp01(Math.min(beadProgress / 0.12, (1 - beadProgress) / 0.1));
    if (fade === 0) {
      continue;
    }
    shapes.push({
      kind: "circle",
      center: pointAlongPath(COMPILED_BEAD_PATH, easeInOutSine(beadProgress)),
      radius: bead.radius,
      alpha: bead.alpha * fade,
    });
  }

  return shapes;
}

function completedShapes(frame: { readonly scale: number; readonly alpha: number }): GlyphShape[] {
  const centerX =
    (Math.min(...COMPLETED_CHECK_POINTS.map((point) => point.x)) +
      Math.max(...COMPLETED_CHECK_POINTS.map((point) => point.x))) /
    2;
  const centerY =
    (Math.min(...COMPLETED_CHECK_POINTS.map((point) => point.y)) +
      Math.max(...COMPLETED_CHECK_POINTS.map((point) => point.y))) /
    2;
  return [
    {
      kind: "stroke",
      points: COMPLETED_CHECK_POINTS.map((point) => ({
        x: centerX + (point.x - centerX) * frame.scale,
        y: centerY + (point.y - centerY) * frame.scale,
      })),
      width: COMPLETED_CHECK_STROKE_WIDTH * frame.scale,
      alphaStart: frame.alpha,
      alphaEnd: frame.alpha,
    },
  ];
}

// --- Windows taskbar overlay chips ---------------------------------------

const OVERLAY_CHIP_CENTER: Vec = { x: 8, y: 8 };
const OVERLAY_CHIP_RADIUS = 7.5;
const OVERLAY_RUNNING_RGB: Rgb = { r: 0x6e, g: 0x94, b: 0xfa }; // brand accent
const OVERLAY_COMPLETED_RGB: Rgb = { r: 0x2a, g: 0xa1, b: 0x52 };
const OVERLAY_GLYPH_RGB: Rgb = { r: 0xff, g: 0xff, b: 0xff };
const OVERLAY_MAX_COUNT = 9; // a 16px chip only stays legible up to one digit
const OVERLAY_CHECK_POINTS: readonly Vec[] = [
  { x: 4.5, y: 8.4 },
  { x: 7.0, y: 10.8 },
  { x: 11.5, y: 5.7 },
];
const OVERLAY_CHECK_STROKE_WIDTH = 2;

function arcPoints(
  center: Vec,
  radius: number,
  startDeg: number,
  endDeg: number,
  steps = 18,
): Vec[] {
  const points: Vec[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = (lerp(startDeg, endDeg, step / steps) * Math.PI) / 180;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return points;
}

function flattenQuadratic(from: Vec, control: Vec, to: Vec, steps = 14): Vec[] {
  const points: Vec[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push({
      x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
    });
  }
  return points;
}

// Minimal stroke-centerline digit set on a 10x14 grid (y down), just enough
// for overlay chip counts.
const DIGIT_GRID_WIDTH = 10;
const DIGIT_GRID_HEIGHT = 14;
const DIGIT_GRID_STROKE_WIDTH = 2.4;
const DIGIT_STROKES: Readonly<Record<string, readonly (readonly Vec[])[]>> = {
  "1": [
    [
      { x: 2.8, y: 2.9 },
      { x: 5.4, y: 0.7 },
      { x: 5.4, y: 13.3 },
    ],
  ],
  "2": [[...arcPoints({ x: 5, y: 4.0 }, 3.5, 185, 350), { x: 1.4, y: 13.3 }, { x: 8.6, y: 13.3 }]],
  "3": [
    [...arcPoints({ x: 5, y: 3.9 }, 3.3, 210, 430), ...arcPoints({ x: 5, y: 10 }, 3.5, 285, 515)],
  ],
  "4": [
    [
      { x: 6.8, y: 0.7 },
      { x: 1.0, y: 9.0 },
      { x: 9.4, y: 9.0 },
    ],
    [
      { x: 6.8, y: 0.7 },
      { x: 6.8, y: 13.3 },
    ],
  ],
  "5": [
    [
      { x: 8.4, y: 0.7 },
      { x: 2.1, y: 0.7 },
      { x: 1.8, y: 6.3 },
      ...arcPoints({ x: 4.9, y: 9.5 }, 3.8, 205, 495),
    ],
  ],
  "6": [
    [...flattenQuadratic({ x: 7.2, y: 0.7 }, { x: 3.4, y: 1.7 }, { x: 2.0, y: 7.8 })],
    [...arcPoints({ x: 5, y: 9.7 }, 3.6, 0, 360, 22)],
  ],
  "7": [
    [
      { x: 1.4, y: 0.7 },
      { x: 8.6, y: 0.7 },
      { x: 4.6, y: 13.3 },
    ],
  ],
  "8": [
    [...arcPoints({ x: 5, y: 4.0 }, 3.2, 0, 360, 20)],
    [...arcPoints({ x: 5, y: 10.1 }, 3.6, 0, 360, 20)],
  ],
  "9": [
    [...arcPoints({ x: 5, y: 4.3 }, 3.6, 0, 360, 22)],
    [...flattenQuadratic({ x: 8.5, y: 5.2 }, { x: 7.4, y: 11.6 }, { x: 2.9, y: 13.3 })],
  ],
  "+": [
    [
      { x: 1.7, y: 7 },
      { x: 8.3, y: 7 },
    ],
    [
      { x: 5, y: 3.7 },
      { x: 5, y: 10.3 },
    ],
  ],
};

function overlayLabelShapes(label: string): GlyphShape[] {
  const height = label.length > 1 ? 7.0 : 8.6;
  const gap = 0.6;
  const scale = height / DIGIT_GRID_HEIGHT;
  const advance = DIGIT_GRID_WIDTH * scale;
  const totalWidth = label.length * advance + (label.length - 1) * gap;
  const originY = OVERLAY_CHIP_CENTER.y - height / 2;
  let originX = OVERLAY_CHIP_CENTER.x - totalWidth / 2;

  const shapes: GlyphShape[] = [];
  for (const character of label) {
    for (const stroke of DIGIT_STROKES[character] ?? []) {
      shapes.push({
        kind: "stroke",
        points: stroke.map((point) => ({
          x: originX + point.x * scale,
          y: originY + point.y * scale,
        })),
        width: DIGIT_GRID_STROKE_WIDTH * scale,
        alphaStart: 1,
        alphaEnd: 1,
        color: OVERLAY_GLYPH_RGB,
      });
    }
    originX += advance + gap;
  }
  return shapes;
}

export interface TaskbarOverlayChipInput {
  readonly kind: "running" | "completed";
  readonly count: number;
}

const overlayChipCache = new Map<string, TrayGlyph>();

export function makeTaskbarOverlayChip(input: TaskbarOverlayChipInput): TrayGlyph {
  const count = Math.max(1, Math.floor(input.count));
  const label = count > OVERLAY_MAX_COUNT ? `${OVERLAY_MAX_COUNT}+` : String(count);
  // A single completion reads better as a check than a "1".
  const useCheck = input.kind === "completed" && count === 1;
  const key = `${input.kind}:${useCheck ? "check" : label}`;
  const cached = overlayChipCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const shapes: GlyphShape[] = [
    {
      kind: "circle",
      center: OVERLAY_CHIP_CENTER,
      radius: OVERLAY_CHIP_RADIUS,
      alpha: 1,
      color: input.kind === "running" ? OVERLAY_RUNNING_RGB : OVERLAY_COMPLETED_RGB,
    },
    ...(useCheck
      ? [
          {
            kind: "stroke",
            points: OVERLAY_CHECK_POINTS,
            width: OVERLAY_CHECK_STROKE_WIDTH,
            alphaStart: 1,
            alphaEnd: 1,
            color: OVERLAY_GLYPH_RGB,
          } satisfies StrokeShape,
        ]
      : overlayLabelShapes(label)),
  ];
  const glyph = buildGlyph(shapes, { sizePt: TASKBAR_OVERLAY_SIZE_PT, compositing: "layered" });
  overlayChipCache.set(key, glyph);
  return glyph;
}

let cachedGlyphSet: MacTrayGlyphSet | null = null;

export function makeMacTrayGlyphSet(): MacTrayGlyphSet {
  cachedGlyphSet ??= {
    idle: buildGlyph(idleShapes(), TRAY_RENDER_OPTIONS),
    workingFrames: Array.from({ length: TRAY_WORKING_FRAME_COUNT }, (_, frameIndex) =>
      buildGlyph(workingShapes(frameIndex), TRAY_RENDER_OPTIONS),
    ),
    completedFrames: COMPLETED_POP_FRAMES.map((frame) =>
      buildGlyph(completedShapes(frame), TRAY_RENDER_OPTIONS),
    ),
  };
  return cachedGlyphSet;
}
