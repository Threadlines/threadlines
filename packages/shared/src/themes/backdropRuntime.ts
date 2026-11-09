/**
 * The backdrop frame's runtime (docs/design/custom-themes.md, "The backdrop
 * runtime" and "Performance"): our code, the only code in the frame
 * document. It owns the clock and the visible canvas, starts and terminates
 * the art worker, draws what the worker returns with WebGL2, frosts the
 * zones the app sends, and tints each zone as much as the text in it needs
 * over the pixels just drawn. Toward Clear (`clarity`) the frost and that
 * tint fade out together, so at 1 the zones show the art as it is.
 *
 * `backdropFrameRuntime` is closed (it refers to nothing outside itself
 * except platform globals) so backdropFrame.ts can inline its source into
 * the walled-off frame. The tint math and the worker prelude come in as
 * arguments for the same reason.
 *
 * Conversation with the app (packages/contracts themes.ts): the frame takes
 * only messages whose source is its parent, checked by hand against the
 * BackdropHostMessage shapes and bounds, and answers with
 * BackdropFrameMessage. It posts `ready` as soon as it listens; the app
 * then sends `init` and the rest. The art doesn't run until a `conditions`
 * message says it may.
 */
import type {
  BackdropActivity,
  BackdropConditions,
  BackdropFailureReason,
  BackdropFrameMessage,
  ThemeBackdropMode,
} from "@threadlines/contracts";
import type {
  BackdropArtDefinition,
  BackdropWorkerReply,
  BackdropWorkerTick,
} from "@threadlines/contracts/themeBackdropWorker";

import type {
  BackdropBitmap,
  BackdropGL,
  BackdropWindow,
  BackdropWorker,
  GLHandle,
} from "./backdropDom.ts";
import type { BackdropTintBox, BackdropTintMath } from "./backdropTint.ts";

/** The runtime's tuning, passed in from backdropFrame.ts (where each value is documented). */
export interface BackdropRuntimeTiming {
  readonly idleFps: number;
  readonly workingFps: number;
  readonly batteryFps: number;
  readonly burstMs: number;
  readonly busyResumeMs: number;
  readonly resumeFadeMs: number;
  readonly stillWaitMs: number;
  readonly budgetWindowMs: number;
  readonly budgetWarmupMs: number;
  readonly budgetMsPerSecond: number;
  readonly maxThrottle: number;
  readonly missesToStepDown: number;
  readonly missesToFail: number;
  readonly heartbeatMs: number;
  readonly statsMs: number;
  readonly launchTimeoutMs: number;
  readonly defineTimeoutMs: number;
  readonly restoreTimeoutMs: number;
  readonly energyMediumMsPerSecond: number;
  readonly energyHeavyMsPerSecond: number;
  readonly maxFrameDevicePixels: number;
  readonly maxFrameDpr: number;
  readonly minFps: number;
}

export interface BackdropRuntimeLimits {
  readonly maxScriptChars: number;
  readonly maxFps: number;
  readonly maxZones: number;
  readonly maxTextColors: number;
  readonly maxGridCells: number;
  readonly maxGlyphs: number;
  readonly minCell: number;
  readonly maxCell: number;
  readonly maxPixelsWidth: number;
  readonly maxPixelsHeight: number;
  readonly maxCanvasPixels: number;
  readonly maxCanvasDpr: number;
  readonly maxBackgroundStops: number;
  readonly maxCellGap: number;
  readonly maxStillChars: number;
  readonly maxSlowdown: number;
}

export interface BackdropFrameRuntimeOptions {
  /** The worker prelude's source, a parenthesized function expression taking its config. */
  readonly prelude: string;
  /** Extra `test:*` messages for the browser tests (backdropFrame.ts documents them). */
  readonly testHooks: boolean;
  readonly limits: BackdropRuntimeLimits;
  readonly timing: BackdropRuntimeTiming;
}

export function backdropFrameRuntime(
  math: BackdropTintMath,
  options: BackdropFrameRuntimeOptions,
): void {
  "use strict";
  const { limits, timing } = options;
  // The frame's window, typed by shape (backdropDom.ts): this module compiles without the DOM's types too.
  const win = globalThis as unknown as BackdropWindow;
  const doc = win.document;
  const parentWindow = win.parent;
  const now = () => performance.now();

  // WebRTC is the one way out no content policy governs.
  for (const name of [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "RTCDataChannel",
    "RTCSessionDescription",
    "RTCIceCandidate",
  ]) {
    try {
      Object.defineProperty(win, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // Already gone.
    }
  }

  type FrameMessage = BackdropFrameMessage;
  const send = (message: FrameMessage | { readonly type: `test:${string}` }) => {
    parentWindow.postMessage(message, "*");
  };

  // ---------------------------------------------------------------------
  // Checking what the parent sends.

  type Rgb = { r: number; g: number; b: number };
  interface Init {
    mode: ThemeBackdropMode;
    script: string;
    maxFps: number;
    palette: Record<string, string>;
    base: Rgb;
    texts: Array<{ luminance: number; ratio: number }>;
    blur: number;
    /** 0 to 1: how much of the frost and the readability tint fade (BackdropClarity). */
    clarity: number;
    /** The still the app shows until the art's first frame, a data URL. */
    still: string | null;
  }
  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  interface Zone {
    id: string;
    soft: boolean;
    ellipse: boolean;
    rect: Rect;
    core: Rect;
    /** A hard rectangle's corners: top left, top right, bottom right, bottom left. */
    radii: [number, number, number, number];
    tint: number;
    color: Rgb;
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isNum = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const isInt = (value: unknown, min: number, max: number): value is number =>
    isNum(value, min, max) && Number.isInteger(value);
  const isId = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
  const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
  const hexToRgb = (hex: string): Rgb => ({
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  });
  /** A CSS gradient angle as a unit direction in CSS px, y down: 0 points up, 90 right, 180 down. */
  const gradientDirection = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return { x: Math.sin(radians), y: -Math.cos(radians) };
  };
  const readRect = (value: unknown): Rect | null => {
    if (!isRecord(value)) return null;
    const { x, y, w, h } = value;
    if (!isNum(x, -1e5, 1e5) || !isNum(y, -1e5, 1e5) || !isNum(w, 0, 1e5) || !isNum(h, 0, 1e5)) {
      return null;
    }
    return { x, y, w, h };
  };

  /** Text colors with the contrast each needs over the art, from `init` or `texts`. */
  const readTexts = (textColors: unknown, textRatios: unknown): Init["texts"] | null => {
    if (!Array.isArray(textColors) || !Array.isArray(textRatios)) return null;
    if (textColors.length > limits.maxTextColors || textColors.length !== textRatios.length)
      return null;
    const texts: Init["texts"] = [];
    for (let index = 0; index < textColors.length; index++) {
      const hex: unknown = textColors[index];
      const ratio: unknown = textRatios[index];
      // From 3:1 up: a ratio near 1:1 leaves a band of failing tints too thin
      // for the tint map's search to be sure of stepping on it.
      if (typeof hex !== "string" || !HEX.test(hex) || !isNum(ratio, 3, 21)) return null;
      const rgb = hexToRgb(hex);
      texts.push({ luminance: math.luminance(rgb.r, rgb.g, rgb.b), ratio });
    }
    return texts;
  };

  const readInit = (message: Record<string, unknown>): Init | null => {
    const { mode, script, maxFps, base, palette, textColors, textRatios, blur } = message;
    if (mode !== "grid" && mode !== "pixels" && mode !== "canvas") return null;
    if (typeof script !== "string" || script.length > limits.maxScriptChars) return null;
    if (!isInt(maxFps, 1, limits.maxFps) || !isInt(blur, 8, 48)) return null;
    if (base !== "light" && base !== "dark") return null;
    if (!isRecord(palette)) return null;
    const paletteEntries = Object.entries(palette);
    if (paletteEntries.length > 128) return null;
    const cleanPalette: Record<string, string> = {};
    for (const [key, value] of paletteEntries) {
      if (!/^[a-z0-9-]{1,40}$/.test(key) || typeof value !== "string" || value.length > 64)
        return null;
      cleanPalette[key] = value;
    }
    const texts = readTexts(textColors, textRatios);
    if (!texts) return null;
    const clarity = message.clarity === undefined ? 0 : message.clarity;
    if (!isNum(clarity, 0, 1)) return null;
    const solid = cleanPalette["surface-solid"] ?? cleanPalette.background;
    const baseColor =
      solid !== undefined && HEX.test(solid)
        ? hexToRgb(solid)
        : base === "dark"
          ? { r: 0.086, g: 0.086, b: 0.086 }
          : { r: 1, g: 1, b: 1 };
    // A still that doesn't parse only costs the fade into the first frame.
    const still =
      typeof message.still === "string" &&
      message.still.length <= limits.maxStillChars &&
      /^data:image\/(?:png|jpeg|webp);base64,/.test(message.still)
        ? message.still
        : null;
    return {
      mode,
      script,
      maxFps,
      palette: cleanPalette,
      base: baseColor,
      texts,
      blur,
      clarity,
      still,
    };
  };

  const readZones = (value: unknown): Zone[] | null => {
    if (!Array.isArray(value) || value.length > limits.maxZones) return null;
    const out: Zone[] = [];
    for (const raw of value) {
      if (!isRecord(raw) || !isId(raw.id, 40)) return null;
      if (raw.edge !== "hard" && raw.edge !== "soft") return null;
      if (raw.shape !== "rect" && raw.shape !== "ellipse") return null;
      const rect = readRect(raw.rect);
      const core = readRect(raw.core);
      if (!rect || !core || !isNum(raw.tint, 0, 1)) return null;
      if (typeof raw.tintColor !== "string" || !HEX.test(raw.tintColor)) return null;
      let radii: [number, number, number, number] = [0, 0, 0, 0];
      if (raw.radii !== undefined) {
        const value = raw.radii;
        if (!Array.isArray(value) || value.length !== 4) return null;
        const [topLeft, topRight, bottomRight, bottomLeft] = value as unknown[];
        if (
          !isNum(topLeft, 0, 10_000) ||
          !isNum(topRight, 0, 10_000) ||
          !isNum(bottomRight, 0, 10_000) ||
          !isNum(bottomLeft, 0, 10_000)
        ) {
          return null;
        }
        radii = [topLeft, topRight, bottomRight, bottomLeft];
      }
      out.push({
        id: raw.id,
        soft: raw.edge === "soft",
        ellipse: raw.shape === "ellipse",
        rect,
        core,
        radii,
        tint: raw.tint,
        color: hexToRgb(raw.tintColor),
      });
    }
    return out;
  };

  const readConditions = (value: unknown): BackdropConditions | null => {
    if (!isRecord(value)) return null;
    const { motion, visible, busy, idle, focused, power, thermal, slowdown } = value;
    if (motion !== "live" && motion !== "still") return null;
    if (
      typeof visible !== "boolean" ||
      typeof busy !== "boolean" ||
      typeof idle !== "boolean" ||
      typeof focused !== "boolean"
    ) {
      return null;
    }
    if (power !== "ac" && power !== "battery" && power !== "unknown") return null;
    if (
      thermal !== "nominal" &&
      thermal !== "fair" &&
      thermal !== "serious" &&
      thermal !== "critical" &&
      thermal !== "unknown"
    ) {
      return null;
    }
    if (!isInt(slowdown, 0, limits.maxSlowdown)) return null;
    return { motion, visible, busy, idle, focused, power, thermal, slowdown };
  };

  // ---------------------------------------------------------------------
  // State.

  let theme: Init | null = null;
  let zones: Zone[] = [];
  let activity: BackdropActivity = { working: 0, waiting: 0 };
  // Until the app says otherwise, the art doesn't run.
  let conditions: BackdropConditions | null = null;
  let viewport = {
    width: Math.max(1, win.innerWidth),
    height: Math.max(1, win.innerHeight),
    dpr: Math.min(timing.maxFrameDpr, win.devicePixelRatio || 1),
  };
  let lastPulseAt = Number.NEGATIVE_INFINITY;
  let busyUntil = 0;
  let failed = false;
  let throttle = 0;
  let generation = 0;
  let tickSequence = 0;
  let drawnFrames = 0;
  let artTime = 0;
  let lastTickAt: number | null = null;
  let staleDropped = 0;
  /** Frame cost samples (the worker's work plus the frame's own) for the budget. */
  let budgetSamples: Array<{ at: number; cost: number }> = [];
  let budgetStart = 0;
  /** The same, never reset, for stats and the energy label; `own` is the frame's own share. */
  let costSamples: Array<{ at: number; cost: number; own: number }> = [];
  let pendingStills: Array<{ requestId: string; width: number; height: number }> = [];

  interface Outstanding {
    frame: number;
    sentAt: number;
    interval: number;
    late: boolean;
    timer: number;
    grid?: { cols: number; rows: number; cellWidth: number; cellHeight: number };
    pixels?: { width: number; height: number };
    canvas?: { width: number; height: number; scale: number };
  }
  interface Art {
    worker: BackdropWorker;
    /** Aborted when the worker ends, removing its listeners. */
    listening: AbortController;
    generation: number;
    url: string | null;
    definition: Omit<BackdropArtDefinition, "type" | "generation"> | null;
    outstanding: Outstanding | null;
    misses: number;
    /** Whether the prelude said it ran ("booted"): the theme's script runs next. */
    booted: boolean;
    /** The worker's time to boot, then the script's time to define the art. */
    startTimer: number;
  }
  let art: Art | null = null;
  let tickTimer: number | null = null;
  let resumeTimer: number | null = null;
  let nextTickAt = 0;

  /** The frame on screen, kept for re-measuring and recompositing while paused. */
  let shown:
    | {
        kind: "grid";
        cols: number;
        rows: number;
        cellWidth: number;
        cellHeight: number;
        glyph: Int16Array;
        fg: Uint8Array;
        bg: Uint8Array;
        glyphCount: number;
        background: Rgb[] | null;
        /** The background's direction, CSS degrees. */
        angle: number;
        /** Device px left open along each cell's top and left edges. */
        gap: number;
      }
    | {
        kind: "pixels";
        width: number;
        height: number;
        data: Uint8Array;
        smooth: boolean;
        /** uv = css * map[0..1] + map[2..3] */
        map: [number, number, number, number];
        background: Rgb[] | null;
        angle: number;
      }
    | { kind: "canvas"; width: number; height: number; scale: number }
    | null = null;
  /** Buffers of an earlier frame, handed back to the worker with the next tick. */
  let spare: ArrayBuffer[] = [];
  /** The window changed size since the last frame: one standing for Still is redrawn. */
  let stillStale = false;
  /** The art target holds a drawn frame: the picture on screen. */
  let artHeld = false;
  /** A restarted worker's first frame fades in over the picture on screen. */
  let fadeNext = false;
  /** The picture on screen when the art resumed, fading out over the restarted art. */
  let fadeFrom: Target | null = null;
  let fadeStartedAt = 0;
  /** When the fade froze: the art paused or held still mid-fade, so the picture holds too. */
  let fadeHeldAt: number | null = null;
  let fadeTimer: number | null = null;
  let fadeMs = timing.resumeFadeMs;
  let launchTimeoutMs = timing.launchTimeoutMs;
  /** The theme's still, decoded: the art's very first frame fades in from it. */
  let stillImage: BackdropBitmap | null = null;
  /** The still is decoding: the art waits for it, at most `stillWaitMs`. */
  let stillDecoding = false;

  // ---------------------------------------------------------------------
  // WebGL2.

  const canvas = doc.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.display = "block";
  doc.documentElement.style.margin = "0";
  doc.documentElement.style.overflow = "hidden";
  doc.body.style.margin = "0";
  doc.body.style.overflow = "hidden";
  doc.body.appendChild(canvas);

  let gl: BackdropGL | null = null;
  let contextLost = false;
  let losses = 0;
  let restoreTimer: number | null = null;

  interface Program {
    program: GLHandle;
    uniform: (name: string) => GLHandle | null;
  }
  interface Target {
    texture: GLHandle;
    framebuffer: GLHandle;
    width: number;
    height: number;
  }
  let gpu: {
    empty: GLHandle;
    gridVao: GLHandle;
    corner: GLHandle;
    glyphBuffer: GLHandle;
    fgBuffer: GLHandle;
    bgBuffer: GLHandle;
    gridCells: number;
    background: Program;
    grid: Program;
    quad: Program;
    downsample: Program;
    blur: Program;
    composite: Program;
    tint: Program;
    fade: Program;
    atlas: GLHandle | null;
    atlasKey: string;
    atlasCols: number;
    atlasRows: number;
    source: GLHandle;
    sourceSize: string;
    art: Target | null;
    artLevels: number;
    quarterA: Target | null;
    quarterB: Target | null;
    /** The tint each patch of glass needs, per tint color (one per channel), an eighth of the window. */
    tintMap: Target | null;
    still: Target | null;
  } | null = null;

  const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const BACKGROUND_FS = `#version 300 es
precision highp float;
uniform vec3 uStops[8];
uniform int uStopCount;
uniform vec2 uSize;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  if (uStopCount <= 1) { outColor = vec4(uStops[0], 1.0); return; }
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) - uSize * 0.5;
  float span = abs(uSize.x * uDir.x) + abs(uSize.y * uDir.y);
  float y = clamp(dot(p, uDir) / span + 0.5, 0.0, 1.0) * float(uStopCount - 1);
  int i = int(min(floor(y), float(uStopCount - 2)));
  outColor = vec4(mix(uStops[i], uStops[i + 1], y - float(i)), 1.0);
}`;
  const GRID_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aGlyph;
layout(location = 2) in vec4 aFg;
layout(location = 3) in vec4 aBg;
uniform int uCols;
uniform vec2 uCell;
uniform vec2 uView;
uniform vec2 uAtlas;
uniform vec2 uSlot;
uniform float uGlyphCount;
out vec2 vUv;
out vec4 vFg;
out vec4 vBg;
out float vHas;
out vec2 vLocal;
void main() {
  int col = gl_InstanceID % uCols;
  int row = gl_InstanceID / uCols;
  vLocal = aCorner * uCell;
  vec2 pos = (vec2(float(col), float(row)) + aCorner) * uCell;
  gl_Position = vec4(pos.x / uView.x * 2.0 - 1.0, 1.0 - pos.y / uView.y * 2.0, 0.0, 1.0);
  float g = aGlyph;
  vHas = (g >= 0.0 && g < uGlyphCount) ? 1.0 : 0.0;
  float gi = max(g, 0.0);
  vec2 slot = vec2(mod(gi, uAtlas.x), floor(gi / uAtlas.x));
  vUv = (slot + 0.5 + (aCorner - 0.5) * uSlot) / uAtlas;
  vFg = aFg;
  vBg = aBg;
}`;
  const GRID_FS = `#version 300 es
precision highp float;
uniform sampler2D uAtlasTexture;
uniform float uGap;
in vec2 vUv;
in vec4 vFg;
in vec4 vBg;
in float vHas;
in vec2 vLocal;
out vec4 outColor;
void main() {
  float coverage = vHas > 0.5 ? texture(uAtlasTexture, vUv).a : 0.0;
  float fa = coverage * vFg.a;
  // The gap: the cell's leading edges leave its background out, so the ground shows.
  float ba = (vLocal.x < uGap || vLocal.y < uGap) ? 0.0 : vBg.a;
  vec3 rgb = vFg.rgb * fa + vBg.rgb * ba * (1.0 - fa);
  outColor = vec4(rgb, fa + ba * (1.0 - fa));
}`;
  const QUAD_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform float uDpr;
uniform float uDeviceHeight;
uniform vec4 uMap;
out vec4 outColor;
void main() {
  vec2 css = vec2(gl_FragCoord.x, uDeviceHeight - gl_FragCoord.y) / uDpr;
  vec4 c = texture(uSource, css * uMap.xy + uMap.zw);
  outColor = vec4(c.rgb * c.a, c.a);
}`;
  /** A kept picture at `uAlpha`, premultiplied: over the art it fades out, at 1 it copies. */
  const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uSize;
uniform float uAlpha;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uSource, gl_FragCoord.xy / uSize).rgb * uAlpha, uAlpha);
}`;
  const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform sampler2D uArt;
uniform float uLod;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  outColor = vec4(textureLod(uArt, gl_FragCoord.xy * uStep, uLod).rgb, 1.0);
}`;
  const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uCenter;
uniform float uOffsets[32];
uniform float uWeights[32];
uniform int uTaps;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 c = texture(uSource, uv).rgb * uCenter;
  for (int i = 0; i < 32; i++) {
    if (i >= uTaps) break;
    vec2 d = uDirection * uTexel * uOffsets[i];
    c += (texture(uSource, uv + d).rgb + texture(uSource, uv - d).rgb) * uWeights[i];
  }
  outColor = vec4(c, 1.0);
}`;
  const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uArt;
uniform sampler2D uFrost;
uniform vec2 uDevice;
uniform vec2 uView;
uniform float uDpr;
uniform vec2 uFrostScale;
uniform sampler2D uTintMap;
uniform vec2 uMapScale;
uniform int uZoneCount;
uniform vec4 uRect[24];
uniform vec4 uCore[24];
uniform vec4 uZone[24];
uniform vec4 uRadii[24];
uniform vec3 uTint[24];
uniform float uChannel[24];
// Toward Clear: the frost and the tint readability adds fade by this much.
uniform float uClarity;
out vec4 outColor;
bool inside(vec2 p, vec4 r) {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.z && p.y <= r.y + r.w;
}
// Signed distance in CSS px from the rectangle r with corner radii k
// (top left, top right, bottom right, bottom left): negative inside.
float roundedDistance(vec2 p, vec4 r, vec4 k) {
  vec2 halfSize = r.zw * 0.5;
  vec2 q = p - (r.xy + halfSize);
  float radius = q.x < 0.0 ? (q.y < 0.0 ? k.x : k.w) : (q.y < 0.0 ? k.y : k.z);
  radius = min(radius, min(halfSize.x, halfSize.y));
  vec2 d = abs(q) - halfSize + radius;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 css = vec2(frag.x, uDevice.y - frag.y) / uDpr;
  vec3 art = textureLod(uArt, frag / uDevice, 0.0).rgb;
  vec2 below = vec2(css.x, uView.y - css.y);
  vec4 needs = texture(uTintMap, below * uMapScale);
  float m = 0.0;
  float tintAlpha = 0.0;
  vec3 tintColor = vec3(0.0);
  bool inCore = false;
  float coreAlpha = 0.0;
  vec3 coreColor = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    if (i >= uZoneCount) break;
    vec4 r = uRect[i];
    vec4 c = uCore[i];
    vec4 z = uZone[i];
    float mi;
    bool hard = z.x < 0.5;
    if (hard) {
      // Its edge antialiased over a device px, its corners rounded like its surface.
      mi = clamp(0.5 - roundedDistance(css, r, uRadii[i]) * uDpr, 0.0, 1.0);
    } else if (inside(css, c)) {
      mi = 1.0;
    } else if (z.y < 0.5) {
      float fx = css.x < c.x ? (c.x - css.x) / max(c.x - r.x, 1.0)
        : css.x > c.x + c.z ? (css.x - c.x - c.z) / max(r.x + r.z - c.x - c.z, 1.0) : 0.0;
      float fy = css.y < c.y ? (c.y - css.y) / max(c.y - r.y, 1.0)
        : css.y > c.y + c.w ? (css.y - c.y - c.w) / max(r.y + r.w - c.y - c.w, 1.0) : 0.0;
      mi = 1.0 - smoothstep(0.0, 1.0, length(vec2(fx, fy)));
    } else {
      vec2 radius = max(r.zw * 0.5, vec2(1.0));
      float e = length((css - (r.xy + r.zw * 0.5)) / radius);
      mi = 1.0 - smoothstep(z.w, 1.0, e);
    }
    m = max(m, mi);
    // The patch's tint for this zone's color and floor; a zone the map holds no channel for is opaque.
    float k = uChannel[i];
    float need = k < -0.5 ? 1.0 : k < 0.5 ? needs.r : k < 1.5 ? needs.g : k < 2.5 ? needs.b : needs.a;
    float full = max(z.z, need * (1.0 - uClarity));
    if (hard ? mi >= 0.5 : inside(css, c)) {
      // Text can be here: a core's own color at its full tint, never another
      // zone's color at a strength worked out for a different one. (A hard
      // zone's core is its own shape.)
      inCore = true;
      if (full > coreAlpha) { coreAlpha = full; coreColor = uTint[i]; }
    } else if (full * mi > tintAlpha) {
      tintAlpha = full * mi;
      tintColor = uTint[i];
    }
  }
  if (inCore) { m = 1.0; tintAlpha = coreAlpha; tintColor = coreColor; }
  if (m <= 0.0) { outColor = vec4(art, 1.0); return; }
  vec2 frostUv = below * uFrostScale;
  vec3 frost = texture(uFrost, frostUv).rgb;
  vec3 color = mix(art, frost, m * (1.0 - uClarity));
  outColor = vec4(mix(color, tintColor, tintAlpha), 1.0);
}`;

  /**
   * Each patch of glass (8 × 8 CSS px) gets the lowest tint that keeps every
   * glass text color at its ratio over every frosted color that can show in
   * it, one tint color and floor per channel. The box spans the frost texels
   * the composite can sample anywhere a bilinear read of this patch's tint
   * reaches, so reading the map between patches never dips under what a pixel
   * needs. The search steps up from the floor, as minimumTint does, since
   * a text color can pass at a low tint, fail higher and pass again.
   */
  const TINT_MAP_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrost;
uniform ivec2 uFrostSize;
uniform vec3 uTintColor;
uniform float uFloor;
uniform float uDarkFloor;
uniform float uLightCeiling;
uniform vec2 uEither[8];
uniform int uEitherCount;
out vec4 outColor;
float toLinear(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float luminance(vec3 c) { return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b); }
// Dark text needs the glass at least uDarkFloor bright, light text at most uLightCeiling;
// a text color near the middle can pass either way (uEither: its floor, its ceiling).
bool passes(vec3 lo, vec3 hi, float a) {
  float low = luminance(mix(lo, uTintColor, a));
  if (low < uDarkFloor) return false;
  float high = luminance(mix(hi, uTintColor, a));
  if (high > uLightCeiling) return false;
  for (int i = 0; i < 8; i++) {
    if (i >= uEitherCount) break;
    if (low < uEither[i].x && high > uEither[i].y) return false;
  }
  return true;
}
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 2;
  vec3 lo = vec3(1.0);
  vec3 hi = vec3(0.0);
  for (int y = -3; y <= 4; y++) {
    for (int x = -3; x <= 4; x++) {
      vec3 c = texelFetch(uFrost, clamp(base + ivec2(x, y), ivec2(0), uFrostSize - 1), 0).rgb;
      lo = min(lo, c);
      hi = max(hi, c);
    }
  }
  // The map is read between patches, so a patch stores a tint above which
  // every tint passes, not just one that does. When the tint pulls every
  // constraint the same way (lighter than the darkest frost for dark text,
  // darker than the brightest for light text), passing never stops once it
  // starts: search up from the floor, by eighths, then eighths of the step
  // that passed. Otherwise walk down from opaque, in 64ths, to the last pass
  // before a failure.
  bool darkRises = uDarkFloor <= 0.0 || all(greaterThanEqual(uTintColor, lo));
  bool lightFalls = uLightCeiling >= 1.0 || all(lessThanEqual(uTintColor, hi));
  bool eitherHolds = uEitherCount == 0 || (all(greaterThanEqual(uTintColor, lo)) && all(lessThanEqual(uTintColor, hi)));
  float tint = 1.0;
  if (darkRises && lightFalls && eitherHolds) {
    float coarse = (1.0 - uFloor) / 8.0;
    float a = uFloor;
    float refineTo = -1.0;
    for (int i = 0; i < 16; i++) {
      if (passes(lo, hi, a)) {
        tint = a;
        if (i == 0 || refineTo >= 0.0) break;
        refineTo = a;
        a -= coarse * 7.0 / 8.0;
        continue;
      }
      a += refineTo >= 0.0 ? coarse / 8.0 : coarse;
      if (refineTo >= 0.0 ? a >= refineTo - 1e-5 : a > 1.0 + 1e-5) break;
    }
  } else {
    float fine = (1.0 - uFloor) / 64.0;
    for (int i = 64; i >= 0; i--) {
      float a = uFloor + fine * float(i);
      if (!passes(lo, hi, a)) break;
      tint = a;
    }
  }
  // Stored as 8 bits: round up, so the stored tint is never under the one that passed.
  outColor = vec4(ceil(tint * 255.0) / 255.0);
}`;

  const QUARTER = 4;
  /** How often a resume fade recomposites, about 30 times a second. */
  const FADE_STEP_MS = 33;

  const buildGpu = (context: BackdropGL) => {
    const compile = (type: number, source: string) => {
      const shader = context.createShader(type);
      if (!shader) throw new Error("createShader failed");
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        throw new Error(context.getShaderInfoLog(shader) ?? "shader compile failed");
      }
      return shader;
    };
    const link = (vs: string, fs: string): Program => {
      const program = context.createProgram();
      if (!program) throw new Error("createProgram failed");
      context.attachShader(program, compile(context.VERTEX_SHADER, vs));
      context.attachShader(program, compile(context.FRAGMENT_SHADER, fs));
      context.linkProgram(program);
      if (!context.getProgramParameter(program, context.LINK_STATUS)) {
        throw new Error(context.getProgramInfoLog(program) ?? "program link failed");
      }
      const locations = new Map<string, GLHandle | null>();
      return {
        program,
        uniform: (name) => {
          if (!locations.has(name)) locations.set(name, context.getUniformLocation(program, name));
          return locations.get(name) ?? null;
        },
      };
    };
    const buffer = () => {
      const created = context.createBuffer();
      if (!created) throw new Error("createBuffer failed");
      return created;
    };
    const empty = context.createVertexArray();
    const gridVao = context.createVertexArray();
    const source = context.createTexture();
    if (!empty || !gridVao || !source) throw new Error("WebGL objects unavailable");
    const corner = buffer();
    const glyphBuffer = buffer();
    const fgBuffer = buffer();
    const bgBuffer = buffer();
    context.bindVertexArray(gridVao);
    context.bindBuffer(context.ARRAY_BUFFER, corner);
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      context.STATIC_DRAW,
    );
    context.enableVertexAttribArray(0);
    context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);
    context.bindBuffer(context.ARRAY_BUFFER, glyphBuffer);
    context.enableVertexAttribArray(1);
    context.vertexAttribPointer(1, 1, context.SHORT, false, 0, 0);
    context.vertexAttribDivisor(1, 1);
    context.bindBuffer(context.ARRAY_BUFFER, fgBuffer);
    context.enableVertexAttribArray(2);
    context.vertexAttribPointer(2, 4, context.UNSIGNED_BYTE, true, 0, 0);
    context.vertexAttribDivisor(2, 1);
    context.bindBuffer(context.ARRAY_BUFFER, bgBuffer);
    context.enableVertexAttribArray(3);
    context.vertexAttribPointer(3, 4, context.UNSIGNED_BYTE, true, 0, 0);
    context.vertexAttribDivisor(3, 1);
    context.bindVertexArray(null);
    context.pixelStorei(context.UNPACK_ALIGNMENT, 1);
    context.pixelStorei(context.PACK_ALIGNMENT, 1);
    gpu = {
      empty,
      gridVao,
      corner,
      glyphBuffer,
      fgBuffer,
      bgBuffer,
      gridCells: 0,
      background: link(FULLSCREEN_VS, BACKGROUND_FS),
      grid: link(GRID_VS, GRID_FS),
      quad: link(FULLSCREEN_VS, QUAD_FS),
      downsample: link(FULLSCREEN_VS, DOWNSAMPLE_FS),
      blur: link(FULLSCREEN_VS, BLUR_FS),
      composite: link(FULLSCREEN_VS, COMPOSITE_FS),
      tint: link(FULLSCREEN_VS, TINT_MAP_FS),
      fade: link(FULLSCREEN_VS, FADE_FS),
      atlas: null,
      atlasKey: "",
      atlasCols: 1,
      atlasRows: 1,
      source,
      sourceSize: "",
      art: null,
      artLevels: 1,
      quarterA: null,
      quarterB: null,
      tintMap: null,
      still: null,
    };
  };

  const makeTarget = (
    context: BackdropGL,
    width: number,
    height: number,
    levels: number,
  ): Target => {
    const texture = context.createTexture();
    const framebuffer = context.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("WebGL objects unavailable");
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texStorage2D(context.TEXTURE_2D, levels, context.RGBA8, width, height);
    context.texParameteri(
      context.TEXTURE_2D,
      context.TEXTURE_MIN_FILTER,
      levels > 1 ? context.LINEAR_MIPMAP_LINEAR : context.LINEAR,
    );
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(
      context.FRAMEBUFFER,
      context.COLOR_ATTACHMENT0,
      context.TEXTURE_2D,
      texture,
      0,
    );
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  };
  const dropTarget = (context: BackdropGL, target: Target | null) => {
    if (!target) return;
    context.deleteTexture(target.texture);
    context.deleteFramebuffer(target.framebuffer);
  };

  /** How much of the picture from before still shows over the art: 1 down to 0, eased. */
  const fadeAlpha = () => {
    if (!fadeFrom) return 0;
    const k = Math.min(1, Math.max(0, ((fadeHeldAt ?? now()) - fadeStartedAt) / fadeMs));
    return 1 - k * k * (3 - 2 * k);
  };

  const endFade = () => {
    if (fadeTimer !== null) win.clearTimeout(fadeTimer);
    fadeTimer = null;
    fadeHeldAt = null;
    if (gl && fadeFrom) dropTarget(gl, fadeFrom);
    fadeFrom = null;
  };

  /** Device size of the visible canvas: the window at the frame's pixel ratio, capped. */
  const deviceSize = () => {
    let dpr = viewport.dpr;
    if (viewport.width * viewport.height * dpr * dpr > timing.maxFrameDevicePixels) {
      dpr = Math.sqrt(timing.maxFrameDevicePixels / (viewport.width * viewport.height));
    }
    return {
      dpr,
      width: Math.max(1, Math.round(viewport.width * dpr)),
      height: Math.max(1, Math.round(viewport.height * dpr)),
      quarterWidth: Math.max(1, Math.ceil(viewport.width / QUARTER)),
      quarterHeight: Math.max(1, Math.ceil(viewport.height / QUARTER)),
    };
  };

  /** Sizes the canvas and its render targets to the window. */
  const sizeTargets = () => {
    if (!gl || !gpu || contextLost) return;
    const size = deviceSize();
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    if (!gpu.art || gpu.art.width !== size.width || gpu.art.height !== size.height) {
      dropTarget(gl, gpu.art);
      gpu.artLevels = Math.floor(Math.log2(Math.max(size.width, size.height))) + 1;
      gpu.art = makeTarget(gl, size.width, size.height, gpu.artLevels);
      artHeld = false;
    }
    if (
      !gpu.quarterA ||
      gpu.quarterA.width !== size.quarterWidth ||
      gpu.quarterA.height !== size.quarterHeight
    ) {
      dropTarget(gl, gpu.quarterA);
      dropTarget(gl, gpu.quarterB);
      gpu.quarterA = makeTarget(gl, size.quarterWidth, size.quarterHeight, 1);
      gpu.quarterB = makeTarget(gl, size.quarterWidth, size.quarterHeight, 1);
    }
    const mapWidth = Math.ceil(size.quarterWidth / 2);
    const mapHeight = Math.ceil(size.quarterHeight / 2);
    if (!gpu.tintMap || gpu.tintMap.width !== mapWidth || gpu.tintMap.height !== mapHeight) {
      dropTarget(gl, gpu.tintMap);
      gpu.tintMap = makeTarget(gl, mapWidth, mapHeight, 1);
    }
  };

  /** The glyph atlas: every glyph drawn once at device resolution, white on clear. */
  const ensureAtlas = (
    glyphs: string[],
    cellWidth: number,
    cellHeight: number,
    fontSize: number,
    fontWeight: number,
    dpr: number,
  ) => {
    if (!gl || !gpu) return;
    const key = `${glyphs.join("")}|${cellWidth}|${cellHeight}|${fontSize}|${fontWeight}|${dpr}`;
    if (gpu.atlasKey === key && gpu.atlas) return;
    const slotWidth = Math.max(1, Math.round(cellWidth * dpr)) + 2;
    const slotHeight = Math.max(1, Math.round(cellHeight * dpr)) + 2;
    const cols = Math.min(16, Math.max(1, glyphs.length));
    const rows = Math.max(1, Math.ceil(glyphs.length / cols));
    const drawing = doc.createElement("canvas");
    drawing.width = cols * slotWidth;
    drawing.height = rows * slotHeight;
    const context = drawing.getContext("2d");
    if (!context) throw new Error("2d canvas unavailable");
    context.font = `${fontWeight} ${Math.max(1, Math.round(fontSize * dpr))}px "SF Mono", ui-monospace, Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#ffffff";
    glyphs.forEach((glyph, index) => {
      const x = (index % cols) * slotWidth + slotWidth / 2;
      const y = Math.floor(index / cols) * slotHeight + slotHeight / 2;
      context.fillText(glyph, x, y);
    });
    if (gpu.atlas) gl.deleteTexture(gpu.atlas);
    const atlas = gl.createTexture();
    if (!atlas) throw new Error("WebGL objects unavailable");
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawing);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gpu.atlas = atlas;
    gpu.atlasKey = key;
    gpu.atlasCols = cols;
    gpu.atlasRows = rows;
  };

  // ---------------------------------------------------------------------
  // Failure and status.

  const failWith = (reason: BackdropFailureReason, detail?: string) => {
    if (failed) return;
    failed = true;
    stopArt();
    endFade();
    stillImage?.close();
    stillImage = null;
    if (resumeTimer !== null) win.clearTimeout(resumeTimer);
    if (restoreTimer !== null) win.clearTimeout(restoreTimer);
    const clipped = detail === undefined ? undefined : detail.slice(0, 500);
    send(
      clipped === undefined
        ? { type: "failure", reason }
        : { type: "failure", reason, detail: clipped },
    );
  };

  // ---------------------------------------------------------------------
  // The art worker.

  const stopArt = () => {
    if (tickTimer !== null) win.clearTimeout(tickTimer);
    tickTimer = null;
    lastTickAt = null;
    const current = art;
    if (!current) return;
    art = null;
    if (current.outstanding) win.clearTimeout(current.outstanding.timer);
    win.clearTimeout(current.startTimer);
    // Stop listening first: nothing an ended worker queued reaches the handlers.
    current.listening.abort();
    current.worker.terminate();
    if (current.url) URL.revokeObjectURL(current.url);
  };

  const startArt = () => {
    if (!theme || art || failed) return;
    generation += 1;
    // A new worker starts the art's own state over (setup reruns): rather
    // than snap to it, the picture on screen (the last frame, or before the
    // first one the still the app shows) dissolves into its first frames.
    fadeNext = artHeld || stillImage !== null;
    const config = {
      generation,
      palette: theme.palette,
      limits: {
        maxGlyphs: limits.maxGlyphs,
        minCell: limits.minCell,
        maxCell: limits.maxCell,
        maxPixelsWidth: limits.maxPixelsWidth,
        maxPixelsHeight: limits.maxPixelsHeight,
        maxBackgroundStops: limits.maxBackgroundStops,
        maxCellGap: limits.maxCellGap,
      },
    };
    const source = `${options.prelude}(${JSON.stringify(config)});\n${theme.script}\n`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    let worker: BackdropWorker;
    try {
      worker = new win.Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      failWith("worker-error", error instanceof Error ? error.message : String(error));
      return;
    }
    const started: Art = {
      worker,
      listening: new AbortController(),
      generation,
      url,
      definition: null,
      outstanding: null,
      misses: 0,
      booted: false,
      // Launching a worker can take seconds on a busy machine, and that
      // isn't the script's time: its own clock starts on "booted". A worker
      // that never boots (or a script that keeps the prelude's reply from
      // getting out) still fails, later.
      startTimer: win.setTimeout(() => {
        if (art === started && !started.booted) {
          failWith("script-error", "The art didn't start: its worker never reported in.");
        }
      }, launchTimeoutMs),
    };
    art = started;
    const { signal } = started.listening;
    worker.addEventListener("message", (event) => onWorkerMessage(started, event.data), { signal });
    worker.addEventListener(
      "error",
      (event) => {
        event.preventDefault();
        if (art !== started) return;
        const message = event.message || "The art worker stopped.";
        if (started.definition) failWith("worker-error", message);
        else failWith("script-error", message);
      },
      { signal },
    );
    worker.addEventListener(
      "messageerror",
      () => {
        if (art === started)
          failWith("bad-output", "The art sent a message that couldn't be read.");
      },
      { signal },
    );
  };

  /** The art's frame geometry for the current window. */
  const geometry = (definition: NonNullable<Art["definition"]>) => {
    if (definition.mode === "grid" && definition.cell) {
      let cellWidth = definition.cell.width;
      let cellHeight = definition.cell.height;
      let cols = Math.max(1, Math.ceil(viewport.width / cellWidth));
      let rows = Math.max(1, Math.ceil(viewport.height / cellHeight));
      let grow = Math.sqrt((cols * rows) / limits.maxGridCells);
      while (cols * rows > limits.maxGridCells) {
        grow = Math.max(grow, 1.01);
        cellWidth = definition.cell.width * grow;
        cellHeight = definition.cell.height * grow;
        cols = Math.max(1, Math.ceil(viewport.width / cellWidth));
        rows = Math.max(1, Math.ceil(viewport.height / cellHeight));
        grow *= 1.01;
      }
      return { grid: { cols, rows, cellWidth, cellHeight } };
    }
    if (definition.mode === "pixels") {
      if (definition.width !== undefined && definition.height !== undefined) {
        return { pixels: { width: definition.width, height: definition.height } };
      }
      let scale = definition.scale ?? 4;
      scale = Math.max(
        scale,
        viewport.width / limits.maxPixelsWidth,
        viewport.height / limits.maxPixelsHeight,
      );
      return {
        pixels: {
          width: Math.min(limits.maxPixelsWidth, Math.max(1, Math.ceil(viewport.width / scale))),
          height: Math.min(limits.maxPixelsHeight, Math.max(1, Math.ceil(viewport.height / scale))),
        },
      };
    }
    let scale = Math.min(limits.maxCanvasDpr, viewport.dpr);
    if (viewport.width * viewport.height * scale * scale > limits.maxCanvasPixels) {
      scale = Math.sqrt(limits.maxCanvasPixels / (viewport.width * viewport.height));
    }
    return {
      canvas: {
        width: Math.max(1, Math.floor(viewport.width * scale)),
        height: Math.max(1, Math.floor(viewport.height * scale)),
        scale,
      },
    };
  };

  /** Checks the theme's declaration again here: the worker is untrusted. */
  const readDefinition = (raw: Record<string, unknown>): Art["definition"] | string => {
    const mode = raw.mode;
    if (!theme) return "no theme";
    if (mode !== theme.mode) {
      return `The script draws in ${String(mode)} mode but the theme says ${theme.mode}.`;
    }
    const background = raw.background;
    if (background !== undefined) {
      if (
        !Array.isArray(background) ||
        background.length === 0 ||
        background.length > limits.maxBackgroundStops ||
        !background.every((stop) => typeof stop === "string" && HEX.test(stop))
      ) {
        return "bad background";
      }
    }
    const angle = raw.backgroundAngle;
    if (angle !== undefined && (background === undefined || !isNum(angle, 0, 360))) {
      return "bad backgroundAngle";
    }
    const base =
      background === undefined
        ? {}
        : {
            background: background as string[],
            ...(angle === undefined ? {} : { backgroundAngle: angle }),
          };
    if (mode === "grid") {
      const cell = raw.cell;
      if (!isRecord(cell) || !isNum(cell.width, limits.minCell, limits.maxCell)) return "bad cell";
      if (!isNum(cell.height, limits.minCell, limits.maxCell)) return "bad cell";
      if (typeof raw.glyphs !== "string" || raw.glyphs.length === 0) return "bad glyphs";
      if ([...raw.glyphs].length > limits.maxGlyphs) return "too many glyphs";
      if (raw.fontSize !== undefined && !isNum(raw.fontSize, limits.minCell, limits.maxCell)) {
        return "bad fontSize";
      }
      if (raw.fontWeight !== undefined && !isInt(raw.fontWeight, 100, 900)) return "bad fontWeight";
      if (raw.gap !== undefined && !isInt(raw.gap, 0, limits.maxCellGap)) return "bad gap";
      return {
        mode,
        ...base,
        cell: { width: cell.width, height: cell.height },
        glyphs: raw.glyphs,
        ...(raw.fontSize === undefined ? {} : { fontSize: raw.fontSize }),
        ...(raw.fontWeight === undefined ? {} : { fontWeight: raw.fontWeight }),
        ...(raw.gap === undefined ? {} : { gap: raw.gap }),
      };
    }
    if (mode === "pixels") {
      const smooth = raw.smooth === true ? { smooth: true } : {};
      if (raw.width !== undefined || raw.height !== undefined) {
        if (
          !isInt(raw.width, 1, limits.maxPixelsWidth) ||
          !isInt(raw.height, 1, limits.maxPixelsHeight)
        ) {
          return "bad pixel size";
        }
        return { mode, ...base, ...smooth, width: raw.width, height: raw.height };
      }
      if (!isNum(raw.scale, 1, 64)) return "bad pixel scale";
      return { mode, ...base, ...smooth, scale: raw.scale };
    }
    if (raw.context !== "2d" && raw.context !== "webgl2") return "bad context";
    return { mode: "canvas", context: raw.context };
  };

  const onWorkerMessage = (from: Art, data: unknown) => {
    if (options.testHooks && isRecord(data) && data.type !== "defined") lastReplies.set(from, data);
    if (art !== from || !isRecord(data) || data.generation !== from.generation) {
      staleDropped += 1;
      if (isRecord(data) && data.bitmap instanceof win.ImageBitmap) data.bitmap.close();
      return;
    }
    if (from.url) {
      URL.revokeObjectURL(from.url);
      from.url = null;
    }
    const message = data as unknown as BackdropWorkerReply;
    switch (message.type) {
      case "booted": {
        if (from.booted || from.definition) {
          failWith("bad-output", "The art's worker started twice.");
          return;
        }
        from.booted = true;
        win.clearTimeout(from.startTimer);
        from.startTimer = win.setTimeout(() => {
          if (art === from && !from.definition) {
            failWith(
              "script-error",
              "The art didn't start: threadlines.backdrop({...}) wasn't called in time.",
            );
          }
        }, timing.defineTimeoutMs);
        return;
      }
      case "defined": {
        if (from.definition) {
          failWith("bad-output", "The art defined itself twice.");
          return;
        }
        const definition = readDefinition(data);
        if (typeof definition === "string") {
          failWith("script-error", definition);
          return;
        }
        from.definition = definition;
        win.clearTimeout(from.startTimer);
        schedule();
        return;
      }
      case "error": {
        const text =
          typeof data.message === "string" ? data.message.slice(0, 480) : "The art failed.";
        const phase = data.phase === "setup" || data.phase === "draw" ? data.phase : "script";
        failWith("script-error", `${phase}: ${text}`);
        return;
      }
      case "grid":
      case "pixels":
      case "canvas": {
        onFrame(from, data);
        return;
      }
      default:
        failWith("bad-output", "The art sent a message it shouldn't have.");
    }
  };

  const onFrame = (from: Art, data: Record<string, unknown>) => {
    const pending = from.outstanding;
    if (!pending || data.frame !== pending.frame || !from.definition) {
      if (data.bitmap instanceof win.ImageBitmap) data.bitmap.close();
      return;
    }
    const arrived = now();
    win.clearTimeout(pending.timer);
    from.outstanding = null;
    if (!pending.late) from.misses = 0;
    const definition = from.definition;
    const renderStart = now();
    const previous = shown;
    if (data.type === "grid" && pending.grid) {
      const { cols, rows } = pending.grid;
      const cells = cols * rows;
      const { glyph, fg, bg } = data;
      if (
        data.cols !== cols ||
        data.rows !== rows ||
        !(glyph instanceof ArrayBuffer) ||
        !(fg instanceof ArrayBuffer) ||
        !(bg instanceof ArrayBuffer) ||
        glyph.byteLength !== cells * 2 ||
        fg.byteLength !== cells * 4 ||
        bg.byteLength !== cells * 4
      ) {
        failWith("bad-output", "A grid frame didn't match the grid's size.");
        return;
      }
      const glyphs = [...(definition.glyphs ?? " ")];
      shown = {
        kind: "grid",
        cols,
        rows,
        cellWidth: pending.grid.cellWidth,
        cellHeight: pending.grid.cellHeight,
        glyph: new Int16Array(glyph),
        fg: new Uint8Array(fg),
        bg: new Uint8Array(bg),
        glyphCount: glyphs.length,
        background: definition.background ? definition.background.map(hexToRgb) : null,
        angle: definition.backgroundAngle ?? 180,
        gap: definition.gap ?? 0,
      };
      if (previous && previous.kind === "grid") {
        spare = [previous.glyph.buffer, previous.fg.buffer, previous.bg.buffer] as ArrayBuffer[];
      } else {
        spare = [];
      }
      if (gl && gpu && !contextLost) {
        // Cells grown past the cell cap grow their glyphs with them.
        const declared = definition.cell ?? {
          width: pending.grid.cellWidth,
          height: pending.grid.cellHeight,
        };
        const grown = pending.grid.cellWidth / declared.width;
        ensureAtlas(
          glyphs,
          pending.grid.cellWidth,
          pending.grid.cellHeight,
          (definition.fontSize ?? declared.height * 0.8) * grown,
          definition.fontWeight ?? 500,
          deviceSize().dpr,
        );
        uploadGrid();
      }
    } else if (data.type === "pixels" && pending.pixels) {
      const { width, height } = pending.pixels;
      const buffer = data.data;
      if (
        data.width !== width ||
        data.height !== height ||
        !(buffer instanceof ArrayBuffer) ||
        buffer.byteLength !== width * height * 4
      ) {
        failWith("bad-output", "A pixel frame didn't match its size.");
        return;
      }
      shown = {
        kind: "pixels",
        width,
        height,
        data: new Uint8Array(buffer),
        smooth: definition.smooth === true,
        map: pixelMap(definition, width, height),
        background: definition.background ? definition.background.map(hexToRgb) : null,
        angle: definition.backgroundAngle ?? 180,
      };
      spare = previous && previous.kind === "pixels" ? [previous.data.buffer as ArrayBuffer] : [];
      if (gl && gpu && !contextLost) uploadPixels();
    } else if (data.type === "canvas" && pending.canvas) {
      const bitmap = data.bitmap;
      if (!(bitmap instanceof win.ImageBitmap)) {
        failWith("bad-output", "A canvas frame carried no image.");
        return;
      }
      if (bitmap.width !== pending.canvas.width || bitmap.height !== pending.canvas.height) {
        bitmap.close();
        failWith("bad-output", "A canvas frame didn't match the canvas size.");
        return;
      }
      shown = { kind: "canvas", ...pending.canvas };
      spare = [];
      if (gl && gpu && !contextLost) uploadBitmap(bitmap);
      bitmap.close();
    } else {
      failWith("bad-output", "A frame didn't match the art's mode.");
      return;
    }
    if (fadeNext) {
      fadeNext = false;
      beginFade();
    }
    render();
    drawnFrames += 1;
    stillStale = false;
    // The first frame is announced at once: the app shows the art on it, and
    // the next heartbeat could be a second away.
    if (drawnFrames === 1) send({ type: "heartbeat", frame: drawnFrames });
    const own = now() - renderStart;
    // The worker's own measure of its work, when it sent one: the round trip
    // also holds time spent waiting on a busy page, which isn't the art's
    // cost. Late replies still count as missed ticks.
    const work = isNum(data.work, 0, 60_000) ? data.work : arrived - pending.sentAt;
    recordCost(work + own, own);
    answerStills();
    if (!failed) schedule();
  };

  /** Pixel-space mapping: a fixed buffer covers the window; a scaled one follows it. */
  const pixelMap = (
    definition: NonNullable<Art["definition"]>,
    width: number,
    height: number,
  ): [number, number, number, number] => {
    if (definition.width !== undefined && definition.height !== undefined) {
      const scale = Math.max(viewport.width / width, viewport.height / height);
      const offsetX = (viewport.width - width * scale) / 2;
      const offsetY = (viewport.height - height * scale) / 2;
      return [
        1 / (scale * width),
        1 / (scale * height),
        -offsetX / (scale * width),
        -offsetY / (scale * height),
      ];
    }
    const scaleX = viewport.width / width;
    const scaleY = viewport.height / height;
    const scale = Math.max(scaleX, scaleY);
    return [1 / (scale * width), 1 / (scale * height), 0, 0];
  };

  const uploadGrid = () => {
    if (!gl || !gpu || !shown || shown.kind !== "grid") return;
    const cells = shown.cols * shown.rows;
    const upload = (buffer: GLHandle, data: ArrayBufferView) => {
      if (!gl) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      if (gpu && gpu.gridCells !== cells) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      else gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    };
    upload(gpu.glyphBuffer, shown.glyph);
    upload(gpu.fgBuffer, shown.fg);
    upload(gpu.bgBuffer, shown.bg);
    gpu.gridCells = cells;
  };

  const uploadPixels = () => {
    if (!gl || !gpu || !shown || shown.kind !== "pixels") return;
    gl.bindTexture(gl.TEXTURE_2D, gpu.source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const size = `${shown.width}x${shown.height}`;
    if (gpu.sourceSize !== size) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        shown.width,
        shown.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        shown.data,
      );
      gpu.sourceSize = size;
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        shown.width,
        shown.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        shown.data,
      );
    }
    const filter = shown.smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  const uploadBitmap = (bitmap: BackdropBitmap) => {
    if (!gl || !gpu) return;
    gl.bindTexture(gl.TEXTURE_2D, gpu.source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gpu.sourceSize = `${bitmap.width}x${bitmap.height}`;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  // ---------------------------------------------------------------------
  // Measuring: the per-channel box of the frosted colors each zone's core shows.

  const emptyBox = (): BackdropTintBox => ({
    minR: 1,
    minG: 1,
    minB: 1,
    maxR: 0,
    maxG: 0,
    maxB: 0,
  });
  const addColor = (box: BackdropTintBox, r: number, g: number, b: number) => {
    if (r < box.minR) box.minR = r;
    if (g < box.minG) box.minG = g;
    if (b < box.minB) box.minB = b;
    if (r > box.maxR) box.maxR = r;
    if (g > box.maxG) box.maxG = g;
    if (b > box.maxB) box.maxB = b;
  };

  /**
   * Tests: each zone's box over the frost its core shows (read back, two
   * texels more each way as the composite samples them) and the one tint
   * that would cover all of it. The live tint is per patch (TINT_MAP_FS) and
   * never below this.
   */
  const measureZonesForTests = () => {
    const result = new Map<string, { tint: number; box: BackdropTintBox }>();
    const frost = gpu?.quarterA;
    if (!gl || !theme || !frost || contextLost) return result;
    const pixels = new Uint8Array(frost.width * frost.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, frost.framebuffer);
    gl.readPixels(0, 0, frost.width, frost.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (const zone of zones) {
      const x0 = Math.max(0, Math.floor(zone.core.x / QUARTER) - 2);
      const x1 = Math.min(frost.width - 1, Math.floor((zone.core.x + zone.core.w) / QUARTER) + 2);
      const y0 = Math.max(
        0,
        Math.floor((viewport.height - zone.core.y - zone.core.h) / QUARTER) - 2,
      );
      const y1 = Math.min(
        frost.height - 1,
        Math.floor((viewport.height - zone.core.y) / QUARTER) + 2,
      );
      if (x1 < x0 || y1 < y0) continue;
      const box = emptyBox();
      for (let y = y0; y <= y1; y++) {
        let at = (y * frost.width + x0) * 4;
        for (let x = x0; x <= x1; x++, at += 4) {
          addColor(box, pixels[at]! / 255, pixels[at + 1]! / 255, pixels[at + 2]! / 255);
        }
      }
      // As the composite does: what readability adds over the floor fades toward Clear.
      const needed = math.minimumTint(zone.color, box, theme.texts, zone.tint);
      const tint = Math.max(zone.tint, needed * (1 - theme.clarity));
      result.set(zone.id, { tint, box });
    }
    return result;
  };

  // ---------------------------------------------------------------------
  // Drawing.

  let lastShownCapture: Map<string, { low: number; high: number }> | null = null;
  let captureShown = false;
  /** Tests: the darkest and brightest luminance shown in each zone's core since capturing began. */
  const shownWorst = new Map<string, { low: number; high: number }>();

  /**
   * Keeps a copy of the picture on screen, before the restarted art draws
   * over it: the art target's last frame, or before the first frame the still
   * (covering the window, as the app shows it). Then recomposites about 30
   * times a second until it has faded, whatever the art's own rate.
   */
  const beginFade = () => {
    endFade();
    const still = stillImage;
    stillImage = null;
    if (!gl || !gpu || contextLost || !gpu.art || (!artHeld && !still)) {
      still?.close();
      return;
    }
    const { art: artTarget } = gpu;
    fadeFrom = makeTarget(gl, artTarget.width, artTarget.height, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fadeFrom.framebuffer);
    gl.viewport(0, 0, fadeFrom.width, fadeFrom.height);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(gpu.empty);
    gl.activeTexture(gl.TEXTURE0);
    if (artHeld) {
      gl.useProgram(gpu.fade.program);
      gl.bindTexture(gl.TEXTURE_2D, artTarget.texture);
      gl.uniform1i(gpu.fade.uniform("uSource"), 0);
      gl.uniform2f(gpu.fade.uniform("uSize"), fadeFrom.width, fadeFrom.height);
      gl.uniform1f(gpu.fade.uniform("uAlpha"), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (still) {
      const texture = gl.createTexture();
      if (texture) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, still);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Cover, centered: uv = css * map.xy + map.zw.
        const cover = Math.max(viewport.width / still.width, viewport.height / still.height);
        const shownWidth = still.width * cover;
        const shownHeight = still.height * cover;
        gl.useProgram(gpu.quad.program);
        gl.uniform1i(gpu.quad.uniform("uSource"), 0);
        gl.uniform1f(gpu.quad.uniform("uDpr"), deviceSize().dpr);
        gl.uniform1f(gpu.quad.uniform("uDeviceHeight"), fadeFrom.height);
        gl.uniform4f(
          gpu.quad.uniform("uMap"),
          1 / shownWidth,
          1 / shownHeight,
          -(viewport.width - shownWidth) / 2 / shownWidth,
          -(viewport.height - shownHeight) / 2 / shownHeight,
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.deleteTexture(texture);
      }
    }
    still?.close();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fadeStartedAt = now();
    fadeTimer = win.setTimeout(fadeStep, FADE_STEP_MS);
  };

  /** One step of a fade. It freezes while the art isn't running (`continueFade` picks it up). */
  const fadeStep = () => {
    fadeTimer = null;
    if (!fadeFrom) return;
    if (contextLost || failed) {
      endFade();
      return;
    }
    // Held still or out of sight, the fade waits; standing for Motion: Still,
    // it finishes, since the picture is on screen.
    if (runState() !== "running" && !standingStill()) {
      fadeHeldAt = now();
      return;
    }
    if (fadeAlpha() <= 0) {
      endFade();
      render();
      return;
    }
    render();
    fadeTimer = win.setTimeout(fadeStep, FADE_STEP_MS);
  };

  const continueFade = () => {
    if (!fadeFrom || fadeHeldAt === null) return;
    fadeStartedAt += now() - fadeHeldAt;
    fadeHeldAt = null;
    if (fadeTimer === null) fadeTimer = win.setTimeout(fadeStep, FADE_STEP_MS);
  };

  /** Decodes the theme's still; the art waits for it (at most `stillWaitMs`) so it can fade from it. */
  const decodeStill = (url: string) => {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const raw = atob(url.slice(url.indexOf(",") + 1));
      bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    } catch {
      return;
    }
    stillDecoding = true;
    const wait = win.setTimeout(() => {
      if (!stillDecoding) return;
      stillDecoding = false;
      schedule();
    }, timing.stillWaitMs);
    const settle = (bitmap: BackdropBitmap | null) => {
      // Too late, or no longer wanted: the art started without it.
      if (!stillDecoding || failed || !bitmap) {
        bitmap?.close();
        if (stillDecoding) {
          stillDecoding = false;
          win.clearTimeout(wait);
          schedule();
        }
        return;
      }
      stillDecoding = false;
      win.clearTimeout(wait);
      stillImage = bitmap;
      schedule();
    };
    win.createImageBitmap(new Blob([bytes], { type: url.slice(5, url.indexOf(";")) })).then(
      (bitmap) => settle(bitmap),
      () => settle(null),
    );
  };

  /**
   * Puts the kept frame on screen: the art and its frost, each patch of
   * glass's tint worked out from that frost, then the composite. All on the
   * GPU, nothing read back.
   */
  const render = () => {
    if (!theme || !gl || !gpu || contextLost) return;
    sizeTargets();
    if (!drawFrost()) return;
    drawTintMap();
    present();
  };

  /** Glass luminance kept spare for rounding the shown pixel to 8 bits. */
  const ROUNDING_MARGIN = 0.005;

  /** Which tint map channel each zone reads (-1: none, so opaque), by index into `zones`. */
  let zoneChannels: number[] = [];

  /**
   * The tint map: up to four tint colors and floors, one per channel, shared
   * by the zones that use them. A zone past the fourth pair stays opaque; the
   * app's zones use four at most.
   */
  const drawTintMap = () => {
    if (!theme || !gl || !gpu) return;
    const { quarterA, tintMap } = gpu;
    if (!quarterA || !tintMap) return;
    const channels: Array<{ color: Rgb; floor: number }> = [];
    zoneChannels = zones.map((zone) => {
      if (zone.tint >= 1) return -1;
      const found = channels.findIndex(
        (channel) =>
          channel.floor === zone.tint &&
          channel.color.r === zone.color.r &&
          channel.color.g === zone.color.g &&
          channel.color.b === zone.color.b,
      );
      if (found >= 0) return found;
      if (channels.length === 4) return -1;
      channels.push({ color: zone.color, floor: zone.tint });
      return channels.length - 1;
    });
    if (channels.length === 0) return;
    // Each text color as the glass luminance it needs: at least `darker` to
    // read as darker text, at most `lighter` to read as lighter text. The
    // margin covers rounding the shown pixel to 8 bits a channel (half a
    // step moves luminance by under 0.005).
    let darkFloor = -1;
    let lightCeiling = 2;
    const either: number[] = [];
    for (const text of theme.texts) {
      const darker = text.ratio * (text.luminance + 0.05) - 0.05 + ROUNDING_MARGIN;
      const lighter = (text.luminance + 0.05) / text.ratio - 0.05 - ROUNDING_MARGIN;
      const canBeDarker = darker <= 1;
      const canBeLighter = lighter >= 0;
      if (canBeDarker && !canBeLighter) darkFloor = Math.max(darkFloor, darker);
      else if (canBeLighter && !canBeDarker) lightCeiling = Math.min(lightCeiling, lighter);
      // Either way, or neither (nothing passes it, so only opaque glass will do).
      else if (either.length < 16) either.push(darker, lighter);
      else darkFloor = 2;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, tintMap.framebuffer);
    gl.viewport(0, 0, tintMap.width, tintMap.height);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(gpu.empty);
    gl.useProgram(gpu.tint.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, quarterA.texture);
    gl.uniform1i(gpu.tint.uniform("uFrost"), 0);
    gl.uniform2i(gpu.tint.uniform("uFrostSize"), quarterA.width, quarterA.height);
    gl.uniform1f(gpu.tint.uniform("uDarkFloor"), darkFloor);
    gl.uniform1f(gpu.tint.uniform("uLightCeiling"), lightCeiling);
    const eitherData = new Float32Array(16);
    eitherData.set(either);
    gl.uniform2fv(gpu.tint.uniform("uEither[0]"), eitherData);
    gl.uniform1i(gpu.tint.uniform("uEitherCount"), either.length / 2);
    // One pass per tint color, each into its own channel.
    const tintColor = gpu.tint.uniform("uTintColor");
    const tintFloor = gpu.tint.uniform("uFloor");
    for (const [index, channel] of channels.entries()) {
      gl.colorMask(index === 0, index === 1, index === 2, index === 3);
      gl.uniform3f(tintColor, channel.color.r, channel.color.g, channel.color.b);
      gl.uniform1f(tintFloor, channel.floor);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.colorMask(true, true, true, true);
  };

  /** The art and its frost, into the targets. False when there are none to draw into. */
  const drawFrost = () => {
    if (!theme || !gl || !gpu || contextLost) return false;
    const frame = shown;
    const size = deviceSize();
    const { art: artTarget, quarterA, quarterB } = gpu;
    if (!artTarget || !quarterA || !quarterB) return false;

    // 1. The art, over its background, into the art target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, artTarget.framebuffer);
    gl.viewport(0, 0, artTarget.width, artTarget.height);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(gpu.empty);
    const ground = frame && frame.kind !== "canvas" && frame.background ? frame : null;
    const stops = ground?.background ?? [theme.base];
    const direction = gradientDirection(ground?.angle ?? 180);
    gl.useProgram(gpu.background.program);
    const stopData = new Float32Array(8 * 3);
    stops.slice(0, 8).forEach((stop, index) => stopData.set([stop.r, stop.g, stop.b], index * 3));
    gl.uniform3fv(gpu.background.uniform("uStops[0]"), stopData);
    gl.uniform1i(gpu.background.uniform("uStopCount"), Math.min(8, stops.length));
    gl.uniform2f(gpu.background.uniform("uSize"), artTarget.width, artTarget.height);
    gl.uniform2f(gpu.background.uniform("uDir"), direction.x, direction.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (frame && frame.kind === "grid" && gpu.atlas && gpu.gridCells === frame.cols * frame.rows) {
      gl.useProgram(gpu.grid.program);
      gl.bindVertexArray(gpu.gridVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gpu.atlas);
      gl.uniform1i(gpu.grid.uniform("uAtlasTexture"), 0);
      gl.uniform1i(gpu.grid.uniform("uCols"), frame.cols);
      gl.uniform2f(gpu.grid.uniform("uCell"), frame.cellWidth, frame.cellHeight);
      gl.uniform2f(gpu.grid.uniform("uView"), viewport.width, viewport.height);
      gl.uniform2f(gpu.grid.uniform("uAtlas"), gpu.atlasCols, gpu.atlasRows);
      const slotWidth = Math.max(1, Math.round(frame.cellWidth * size.dpr));
      const slotHeight = Math.max(1, Math.round(frame.cellHeight * size.dpr));
      gl.uniform2f(
        gpu.grid.uniform("uSlot"),
        slotWidth / (slotWidth + 2),
        slotHeight / (slotHeight + 2),
      );
      gl.uniform1f(gpu.grid.uniform("uGlyphCount"), frame.glyphCount);
      gl.uniform1f(gpu.grid.uniform("uGap"), frame.gap / size.dpr);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, frame.cols * frame.rows);
      gl.bindVertexArray(gpu.empty);
    } else if (frame && (frame.kind === "pixels" || frame.kind === "canvas") && gpu.sourceSize) {
      gl.useProgram(gpu.quad.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gpu.source);
      gl.uniform1i(gpu.quad.uniform("uSource"), 0);
      gl.uniform1f(gpu.quad.uniform("uDpr"), size.dpr);
      gl.uniform1f(gpu.quad.uniform("uDeviceHeight"), artTarget.height);
      const map =
        frame.kind === "pixels"
          ? frame.map
          : [frame.scale / frame.width, frame.scale / frame.height, 0, 0];
      gl.uniform4f(gpu.quad.uniform("uMap"), map[0]!, map[1]!, map[2]!, map[3]!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // Resuming: the picture from before the pause over it, fading out.
    const fading = fadeAlpha();
    if (fadeFrom && fading > 0) {
      gl.useProgram(gpu.fade.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fadeFrom.texture);
      gl.uniform1i(gpu.fade.uniform("uSource"), 0);
      gl.uniform2f(gpu.fade.uniform("uSize"), artTarget.width, artTarget.height);
      gl.uniform1f(gpu.fade.uniform("uAlpha"), fading);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    artHeld = frame !== null;

    // 2. A quarter-resolution copy, averaged through the art's mip levels.
    gl.bindTexture(gl.TEXTURE_2D, artTarget.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, quarterA.framebuffer);
    gl.viewport(0, 0, quarterA.width, quarterA.height);
    gl.useProgram(gpu.downsample.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, artTarget.texture);
    gl.uniform1i(gpu.downsample.uniform("uArt"), 0);
    gl.uniform1f(gpu.downsample.uniform("uLod"), Math.max(0, Math.log2(QUARTER * size.dpr)));
    gl.uniform2f(
      gpu.downsample.uniform("uStep"),
      QUARTER / viewport.width,
      QUARTER / viewport.height,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. Blur it, two passes.
    const sigma = theme.blur / QUARTER;
    const radius = Math.max(1, Math.ceil(sigma * 2));
    const weights: number[] = [];
    let total = 0;
    for (let k = 0; k <= radius; k++) {
      const weight = Math.exp(-(k * k) / (2 * sigma * sigma));
      weights.push(weight);
      total += k === 0 ? weight : weight * 2;
    }
    const offsets = new Float32Array(32);
    const pairWeights = new Float32Array(32);
    let taps = 0;
    for (let k = 1; k <= radius && taps < 32; k += 2) {
      const first = weights[k]!;
      const second = k + 1 <= radius ? weights[k + 1]! : 0;
      const weight = first + second;
      offsets[taps] = (k * first + (k + 1) * second) / weight;
      pairWeights[taps] = weight / total;
      taps += 1;
    }
    gl.useProgram(gpu.blur.program);
    gl.uniform1f(gpu.blur.uniform("uCenter"), weights[0]! / total);
    gl.uniform1fv(gpu.blur.uniform("uOffsets[0]"), offsets);
    gl.uniform1fv(gpu.blur.uniform("uWeights[0]"), pairWeights);
    gl.uniform1i(gpu.blur.uniform("uTaps"), taps);
    gl.uniform2f(gpu.blur.uniform("uTexel"), 1 / quarterA.width, 1 / quarterA.height);
    gl.uniform1i(gpu.blur.uniform("uSource"), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, quarterB.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, quarterA.texture);
    gl.uniform2f(gpu.blur.uniform("uDirection"), 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, quarterA.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, quarterB.texture);
    gl.uniform2f(gpu.blur.uniform("uDirection"), 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    return true;
  };

  /**
   * The composite: crisp art, frosted and tinted inside the zones, each patch
   * as its tint map says; toward Clear the frost and that tint fade.
   */
  const present = () => {
    if (!theme || !gl || !gpu || contextLost) return;
    const { art: artTarget, quarterA, tintMap } = gpu;
    if (!artTarget || !quarterA || !tintMap) return;
    const size = deviceSize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(gpu.composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, artTarget.texture);
    gl.uniform1i(gpu.composite.uniform("uArt"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, quarterA.texture);
    gl.uniform1i(gpu.composite.uniform("uFrost"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tintMap.texture);
    gl.uniform1i(gpu.composite.uniform("uTintMap"), 2);
    gl.uniform2f(
      gpu.composite.uniform("uMapScale"),
      1 / (tintMap.width * QUARTER * 2),
      1 / (tintMap.height * QUARTER * 2),
    );
    gl.uniform2f(gpu.composite.uniform("uDevice"), canvas.width, canvas.height);
    gl.uniform2f(gpu.composite.uniform("uView"), viewport.width, viewport.height);
    gl.uniform1f(gpu.composite.uniform("uDpr"), size.dpr);
    gl.uniform2f(
      gpu.composite.uniform("uFrostScale"),
      1 / (quarterA.width * QUARTER),
      1 / (quarterA.height * QUARTER),
    );
    const count = Math.min(24, zones.length);
    const rects = new Float32Array(24 * 4);
    const cores = new Float32Array(24 * 4);
    const params = new Float32Array(24 * 4);
    const radii = new Float32Array(24 * 4);
    const tints = new Float32Array(24 * 3);
    const channelOf = new Float32Array(24).fill(-1);
    zones.slice(0, count).forEach((zone, index) => {
      rects.set([zone.rect.x, zone.rect.y, zone.rect.w, zone.rect.h], index * 4);
      cores.set([zone.core.x, zone.core.y, zone.core.w, zone.core.h], index * 4);
      let edge = 0;
      if (zone.ellipse && zone.soft) {
        const cx = zone.rect.x + zone.rect.w / 2;
        const cy = zone.rect.y + zone.rect.h / 2;
        const rx = Math.max(1, zone.rect.w / 2);
        const ry = Math.max(1, zone.rect.h / 2);
        for (const [x, y] of [
          [zone.core.x, zone.core.y],
          [zone.core.x + zone.core.w, zone.core.y],
          [zone.core.x, zone.core.y + zone.core.h],
          [zone.core.x + zone.core.w, zone.core.y + zone.core.h],
        ] as const) {
          edge = Math.max(edge, Math.hypot((x - cx) / rx, (y - cy) / ry));
        }
        edge = Math.min(edge, 0.95);
      }
      params.set([zone.soft ? 1 : 0, zone.ellipse ? 1 : 0, zone.tint, edge], index * 4);
      radii.set(zone.radii, index * 4);
      tints.set([zone.color.r, zone.color.g, zone.color.b], index * 3);
      channelOf[index] = zoneChannels[index] ?? -1;
    });
    gl.uniform1i(gpu.composite.uniform("uZoneCount"), count);
    gl.uniform4fv(gpu.composite.uniform("uRect[0]"), rects);
    gl.uniform4fv(gpu.composite.uniform("uCore[0]"), cores);
    gl.uniform4fv(gpu.composite.uniform("uZone[0]"), params);
    gl.uniform4fv(gpu.composite.uniform("uRadii[0]"), radii);
    gl.uniform3fv(gpu.composite.uniform("uTint[0]"), tints);
    gl.uniform1fv(gpu.composite.uniform("uChannel[0]"), channelOf);
    gl.uniform1f(gpu.composite.uniform("uClarity"), theme.clarity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    if (options.testHooks && captureShown) readShown(size.dpr);
  };

  /** Tests: the darkest and brightest luminance actually on screen inside each zone's core. */
  const readShown = (dpr: number) => {
    if (!gl) return;
    const result = new Map<string, { low: number; high: number }>();
    for (const zone of zones) {
      const x = Math.max(0, Math.floor(zone.core.x * dpr));
      const yTop = Math.max(0, Math.floor(zone.core.y * dpr));
      const width = Math.min(canvas.width - x, Math.ceil(zone.core.w * dpr));
      const height = Math.min(canvas.height - yTop, Math.ceil(zone.core.h * dpr));
      if (width <= 0 || height <= 0) continue;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(
        x,
        canvas.height - yTop - height,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      let low = 1;
      let high = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        const value = math.luminance(
          pixels[at]! / 255,
          pixels[at + 1]! / 255,
          pixels[at + 2]! / 255,
        );
        if (value < low) low = value;
        if (value > high) high = value;
      }
      result.set(zone.id, { low, high });
      const worst = shownWorst.get(zone.id);
      shownWorst.set(zone.id, {
        low: Math.min(low, worst?.low ?? 1),
        high: Math.max(high, worst?.high ?? 0),
      });
    }
    lastShownCapture = result;
  };

  /** Renders the kept art at a size (cover), without frost or tint, as a PNG data URL. */
  const captureStill = (width: number, height: number): string | null => {
    if (!gl || !gpu || contextLost || !gpu.art || !shown) return null;
    let w = Math.max(1, Math.round(width));
    let h = Math.max(1, Math.round(height));
    for (let attempt = 0; attempt < 4; attempt++) {
      dropTarget(gl, gpu.still);
      gpu.still = makeTarget(gl, w, h, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.still.framebuffer);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(gpu.quad.program);
      gl.bindVertexArray(gpu.empty);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gpu.art.texture);
      gl.uniform1i(gpu.quad.uniform("uSource"), 0);
      gl.uniform1f(gpu.quad.uniform("uDpr"), 1);
      gl.uniform1f(gpu.quad.uniform("uDeviceHeight"), h);
      // Cover: the still's pixels map onto the window, cropped to its shape.
      const scale = Math.max(w / viewport.width, h / viewport.height);
      const offsetX = (w - viewport.width * scale) / 2;
      const offsetY = (h - viewport.height * scale) / 2;
      // The art target counts rows from the bottom; the still's v runs from the top.
      gl.uniform4f(
        gpu.quad.uniform("uMap"),
        1 / (viewport.width * scale),
        -1 / (viewport.height * scale),
        -offsetX / (viewport.width * scale),
        1 + offsetY / (viewport.height * scale),
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const still = doc.createElement("canvas");
      still.width = w;
      still.height = h;
      const context = still.getContext("2d");
      if (!context) return null;
      const image = context.createImageData(w, h);
      for (let row = 0; row < h; row++) {
        const from = (h - 1 - row) * w * 4;
        image.data.set(pixels.subarray(from, from + w * 4), row * w * 4);
      }
      for (let at = 3; at < image.data.length; at += 4) image.data[at] = 255;
      context.putImageData(image, 0, 0);
      const url = still.toDataURL("image/png");
      if (url.length <= limits.maxStillChars) {
        dropTarget(gl, gpu.still);
        gpu.still = null;
        return url;
      }
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }
    return null;
  };

  const answerStills = () => {
    if (pendingStills.length === 0 || !shown) return;
    const requests = pendingStills;
    pendingStills = [];
    for (const request of requests) {
      const dataUrl = captureStill(request.width, request.height);
      if (dataUrl) send({ type: "still", requestId: request.requestId, dataUrl });
    }
  };

  // ---------------------------------------------------------------------
  // The clock.

  type RunState = "running" | "hold" | "paused";
  const runState = (): RunState => {
    if (!theme || !gl || failed || contextLost || !conditions) return "paused";
    const c = conditions;
    if (!c.visible || c.idle || c.thermal === "serious" || c.thermal === "critical") {
      return "paused";
    }
    // Busy holds the art, but not before its first frame: a theme just
    // switched to (often by keyboard) shows its art at once.
    if (c.busy || now() < busyUntil) return drawnFrames === 0 ? "running" : "hold";
    // Still: one frame of the art, then it stands, frosted and tinted like
    // the live art. A frame already on screen (from before Still, or the
    // still's fade) stays; after a lost context, or once the window settles
    // at a new size, one is drawn again.
    if (c.motion === "still") return shown === null || stillStale ? "running" : "paused";
    return "running";
  };

  /** Paused only because Motion is Still: the art's frame is on screen and can still be recomposited. */
  const standingStill = () =>
    runState() === "paused" &&
    conditions?.motion === "still" &&
    conditions.visible &&
    !conditions.idle &&
    conditions.thermal !== "serious" &&
    conditions.thermal !== "critical";

  const targetFps = () => {
    if (!theme) return 0;
    // In front, the theme's own rate: anything less reads as lag. Behind
    // another app, a calm rate, a little livelier while agents work.
    const burst = now() - lastPulseAt < timing.burstMs;
    let fps =
      burst || conditions?.focused === true
        ? theme.maxFps
        : Math.min(theme.maxFps, activity.working > 0 ? timing.workingFps : timing.idleFps);
    if (conditions?.power === "battery") fps = Math.min(fps, timing.batteryFps);
    // Never slower than one frame a second, so a drawing frame always shows progress to the app's watchdog.
    // The desktop watchdog's slowdown is a floor under the budget's own steps.
    return Math.max(timing.minFps, fps / 2 ** Math.max(throttle, conditions?.slowdown ?? 0));
  };

  const schedule = () => {
    const state = runState();
    if (state === "running" || standingStill()) continueFade();
    if (state === "paused") {
      stopArt();
      return;
    }
    if (state === "hold") {
      if (tickTimer !== null) win.clearTimeout(tickTimer);
      tickTimer = null;
      lastTickAt = null;
      if (resumeTimer !== null) win.clearTimeout(resumeTimer);
      const wait = busyUntil - now();
      if (wait > 0) resumeTimer = win.setTimeout(schedule, wait + 1);
      return;
    }
    if (!art) {
      if (stillDecoding) return;
      // A new worker's first frames run setup and unoptimized code: the budget starts after them.
      budgetSamples = [];
      budgetStart = now() + timing.budgetWarmupMs;
      startArt();
      return;
    }
    if (!art.definition || art.outstanding) return;
    const interval = 1000 / targetFps();
    const at = lastTickAt === null ? now() : Math.max(now(), lastTickAt + interval);
    if (tickTimer !== null && Math.abs(at - nextTickAt) < 1) return;
    if (tickTimer !== null) win.clearTimeout(tickTimer);
    nextTickAt = at;
    tickTimer = win.setTimeout(sendTick, Math.max(0, at - now()));
  };

  const sendTick = () => {
    tickTimer = null;
    const current = art;
    if (!current || !current.definition || current.outstanding || runState() !== "running") return;
    const sentAt = now();
    const interval = 1000 / targetFps();
    const dt = lastTickAt === null ? interval / 1000 : Math.min(1, (sentAt - lastTickAt) / 1000);
    artTime += dt;
    lastTickAt = sentAt;
    tickSequence += 1;
    const shape = geometry(current.definition);
    const pending: Outstanding = {
      frame: tickSequence,
      sentAt,
      interval,
      late: false,
      timer: 0,
      ...shape,
    };
    pending.timer = win.setTimeout(() => onDeadline(current, pending), interval * 2);
    current.outstanding = pending;
    const tick: BackdropWorkerTick = {
      type: "tick",
      generation: current.generation,
      frame: pending.frame,
      t: artTime,
      dt,
      state: {
        working: activity.working,
        waiting: activity.waiting,
        sincePulse: Number.isFinite(lastPulseAt) ? Math.max(0, (sentAt - lastPulseAt) / 1000) : 1e9,
      },
      size: { width: viewport.width, height: viewport.height, dpr: viewport.dpr },
      ...shape,
    };
    const spareMatches =
      spare.length > 0 &&
      ((shape.grid &&
        shown?.kind === "grid" &&
        shown.cols === shape.grid.cols &&
        shown.rows === shape.grid.rows) ||
        (shape.pixels &&
          shown?.kind === "pixels" &&
          shown.width === shape.pixels.width &&
          shown.height === shape.pixels.height));
    if (spareMatches) {
      const handBack = spare;
      spare = [];
      current.worker.postMessage({ ...tick, spare: handBack }, handBack);
    } else {
      spare = [];
      current.worker.postMessage(tick, []);
    }
  };

  /** A tick not answered within two intervals is a miss; three in a row step down, six fail. */
  const onDeadline = (current: Art, pending: Outstanding) => {
    if (art !== current || current.outstanding !== pending || failed) return;
    pending.late = true;
    current.misses += 1;
    if (current.misses >= timing.missesToFail) {
      failWith("too-heavy", "The art kept missing frames.");
      return;
    }
    if (current.misses % timing.missesToStepDown === 0) stepDown();
    pending.timer = win.setTimeout(() => onDeadline(current, pending), (1000 / targetFps()) * 2);
  };

  const stepDown = () => {
    if (throttle < timing.maxThrottle) throttle += 1;
    budgetSamples = [];
    budgetStart = now();
  };

  /** The budget: the slowest tenth of frames over the window, per frame. */
  const recordCost = (cost: number, own: number) => {
    const at = now();
    costSamples.push({ at, cost, own });
    costSamples = costSamples.filter((sample) => at - sample.at <= timing.budgetWindowMs);
    if (at < budgetStart) return;
    budgetSamples.push({ at, cost });
    if (at - budgetStart < timing.budgetWindowMs || budgetSamples.length < 5 || !theme) return;
    // Work per second, not per frame: a core that wakes only a few times a
    // second runs each frame slowly, so a per-frame limit would hold slowed
    // art down for good. Single slow frames are the missed-tick check's job.
    const perSecond =
      budgetSamples.reduce((sum, sample) => sum + sample.cost, 0) / ((at - budgetStart) / 1000);
    budgetSamples = [];
    budgetStart = at;
    // Over budget slows the art, never stops it: a busy computer (a long build)
    // makes light art look heavy too. Only missed frames stop it, and on
    // desktop the CPU watchdog.
    if (perSecond > timing.budgetMsPerSecond) {
      if (throttle < timing.maxThrottle) throttle += 1;
    } else if (
      perSecond < timing.budgetMsPerSecond / 2 &&
      throttle > 0 &&
      (art?.misses ?? 0) === 0
    ) {
      throttle -= 1;
    }
  };

  const sendStats = () => {
    if (!theme || failed) return;
    const at = now();
    const recent = costSamples.filter((sample) => at - sample.at <= timing.budgetWindowMs);
    const span = Math.min(timing.budgetWindowMs, Math.max(1000, at - (recent[0]?.at ?? at))) / 1000;
    const running = runState() === "running";
    const frames = recent.filter((sample) => at - sample.at <= timing.statsMs).length;
    const msPerSecond = running ? recent.reduce((sum, sample) => sum + sample.cost, 0) / span : 0;
    send({
      type: "stats",
      fps: running ? frames / (timing.statsMs / 1000) : 0,
      msPerSecond: Math.round(msPerSecond * 100) / 100,
      energy:
        msPerSecond >= timing.energyHeavyMsPerSecond
          ? "heavy"
          : msPerSecond >= timing.energyMediumMsPerSecond
            ? "medium"
            : "light",
      throttled: throttle > 0 || (conditions?.slowdown ?? 0) > 0,
    });
  };

  // ---------------------------------------------------------------------
  // WebGL context loss: one restore is tried, then the art fails.

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    losses += 1;
    stopArt();
    endFade();
    artHeld = false;
    if (losses > 1) {
      failWith("context-lost", "The graphics context was lost again.");
      return;
    }
    restoreTimer = win.setTimeout(
      () => failWith("context-lost", "The graphics context was lost and didn't come back."),
      timing.restoreTimeoutMs,
    );
  });
  canvas.addEventListener("webglcontextrestored", () => {
    if (failed || !gl) return;
    if (restoreTimer !== null) win.clearTimeout(restoreTimer);
    restoreTimer = null;
    contextLost = false;
    try {
      gpu = null;
      buildGpu(gl);
    } catch (error) {
      failWith("context-lost", error instanceof Error ? error.message : String(error));
      return;
    }
    shown = null;
    spare = [];
    render();
    schedule();
  });

  // ---------------------------------------------------------------------
  // Messages from the app.

  /** Tests: each worker's last frame reply, so one can be replayed once its worker is gone. */
  const lastReplies = new Map<Art, unknown>();

  const onInit = (message: Record<string, unknown>) => {
    if (theme || failed) return;
    const init = readInit(message);
    if (!init) return;
    theme = init;
    const base = `rgb(${Math.round(init.base.r * 255)} ${Math.round(init.base.g * 255)} ${Math.round(init.base.b * 255)})`;
    doc.documentElement.style.background = base;
    doc.documentElement.style.colorScheme = message.base === "dark" ? "dark" : "light";
    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      failWith("no-webgl", "This computer can't give the backdrop a WebGL2 context.");
      return;
    }
    try {
      buildGpu(gl);
    } catch (error) {
      failWith("no-webgl", error instanceof Error ? error.message : String(error));
      return;
    }
    sizeTargets();
    render();
    if (init.still) decodeStill(init.still);
    win.setInterval(() => {
      if (!failed) send({ type: "heartbeat", frame: drawnFrames });
    }, timing.heartbeatMs);
    win.setInterval(sendStats, timing.statsMs);
    schedule();
  };

  const onHostMessage = (message: Record<string, unknown>) => {
    switch (message.type) {
      case "init":
        onInit(message);
        return;
      case "viewport": {
        const { width, height, dpr } = message;
        if (!isNum(width, 1, 16_384) || !isNum(height, 1, 16_384) || !isNum(dpr, 0.25, 8)) return;
        const next = { width, height, dpr: Math.min(timing.maxFrameDpr, dpr) };
        if (
          next.width === viewport.width &&
          next.height === viewport.height &&
          next.dpr === viewport.dpr
        )
          return;
        viewport = next;
        // A frame standing for Still was drawn for the old size.
        stillStale = true;
        if (shown && shown.kind === "pixels" && art?.definition) {
          shown.map = pixelMap(art.definition, shown.width, shown.height);
        }
        render();
        schedule();
        return;
      }
      case "glass": {
        // The Glass slider moved, or the theme's colors changed: the art keeps running.
        const texts = readTexts(message.textColors, message.textRatios);
        if (!texts || !theme || !isNum(message.clarity, 0, 1)) return;
        theme = { ...theme, texts, clarity: message.clarity };
        render();
        return;
      }
      case "zones": {
        const next = readZones(message.zones);
        if (!next) return;
        zones = next;
        // Zones update while paused too: recomposite and remeasure the kept frame.
        render();
        return;
      }
      case "activity": {
        const value = message.activity;
        if (!isRecord(value) || !isInt(value.working, 0, 1e6) || !isInt(value.waiting, 0, 1e6))
          return;
        activity = { working: value.working, waiting: value.waiting };
        schedule();
        return;
      }
      case "pulse": {
        if (message.kind !== "turn-done") return;
        lastPulseAt = now();
        schedule();
        return;
      }
      case "conditions": {
        const next = readConditions(message.conditions);
        if (!next) return;
        if (conditions?.busy && !next.busy) busyUntil = now() + timing.busyResumeMs;
        conditions = next;
        schedule();
        return;
      }
      case "capture-still": {
        const { requestId, width, height } = message;
        if (!isId(requestId, 64) || !isNum(width, 1, 4096) || !isNum(height, 1, 4096)) return;
        pendingStills.push({ requestId, width, height });
        if (pendingStills.length > 8) pendingStills.shift();
        answerStills();
        return;
      }
      default:
        if (options.testHooks) onTestMessage(message);
    }
  };

  /**
   * Test hooks (only with `testHooks`): `test:probe` answers with the
   * frame's inner state (each zone's measured box and tint too, with
   * `measure: true`), `test:lose-context` loses the WebGL context,
   * `test:replay-stale` hands the last frame reply from an earlier worker
   * generation back to the reply handler, and `test:capture-shown` reads
   * back the composited pixels inside each zone's core on every frame,
   * keeping the darkest and brightest luminance shown (`worst` in the probe).
   * `test:fade-ms` sets how long a resume fade lasts, and `test:launch-ms`
   * how long a new worker has to boot.
   */
  const onTestMessage = (message: Record<string, unknown>) => {
    if (message.type === "test:probe") {
      // Each zone's floor; measured over the frost (a read back, so only when asked) with `measure`.
      const tints: Record<string, number> = {};
      const boxes: Record<string, BackdropTintBox> = {};
      for (const zone of zones) tints[zone.id] = zone.tint;
      if (message.measure === true) {
        for (const [id, value] of measureZonesForTests()) {
          tints[id] = value.tint;
          boxes[id] = value.box;
        }
      }
      const worstLuminance: Record<string, { low: number; high: number }> = {};
      for (const [id, value] of shownWorst) worstLuminance[id] = value;
      const shownLuminance: Record<string, { low: number; high: number }> = {};
      for (const [id, value] of lastShownCapture ?? []) shownLuminance[id] = value;
      const percentiles = (values: number[]) => {
        const sorted = values.sort((a, b) => a - b);
        const at = (share: number) =>
          sorted.length === 0
            ? 0
            : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
        return { count: sorted.length, p50: at(0.5), p90: at(0.9), max: at(1) };
      };
      send({
        costs: percentiles(costSamples.map((sample) => sample.cost)),
        own: percentiles(costSamples.map((sample) => sample.own)),
        type: "test:probe",
        tints,
        boxes,
        shown: shownLuminance,
        worst: worstLuminance,
        drawnFrames,
        ticks: tickSequence,
        generation,
        workerAlive: art !== null,
        throttle,
        fps: targetFps(),
        t: artTime,
        staleDropped,
        state: runState(),
        fading: fadeFrom !== null,
      } as unknown as { type: "test:probe" });
      return;
    }
    if (message.type === "test:fade-ms") {
      if (isNum(message.ms, 1, 60_000)) fadeMs = message.ms;
      return;
    }
    if (message.type === "test:launch-ms") {
      if (isNum(message.ms, 1, 60_000)) launchTimeoutMs = message.ms;
      return;
    }
    if (message.type === "test:lose-context") {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return;
    }
    if (message.type === "test:replay-stale") {
      for (const [from, data] of lastReplies) if (from !== art) onWorkerMessage(from, data);
      return;
    }
    if (message.type === "test:capture-shown") {
      captureShown = message.on === true;
      shownWorst.clear();
      if (captureShown) render();
    }
  };

  win.addEventListener("message", (event) => {
    if (event.source !== parentWindow || !isRecord(event.data)) return;
    onHostMessage(event.data);
  });

  // Listening: the app sends `init` and the rest once it hears this.
  send({ type: "ready" });
}
