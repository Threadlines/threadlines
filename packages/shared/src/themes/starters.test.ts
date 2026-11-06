import { describe, expect, it } from "vite-plus/test";

import { color, composite, contrastRatio } from "./color.ts";
import { checkThemeManifest } from "./manifest.ts";
import { STARTER_SUMMARIES } from "./starterSummaries.ts";
import { RETIRED_STARTER_THEMES, STARTER_THEMES } from "./starters.ts";
import { resolveThemeTokens } from "./tokens.ts";

interface Declared {
  mode: string;
  cell?: { width: number; height: number };
  glyphs?: string;
  width?: number;
  height?: number;
  scale?: number;
  setup?: (info: unknown, target: unknown) => void;
  draw: (target: unknown, info: unknown) => void;
}

/** Runs a starter's script outside the worker with a stand-in `threadlines`, to read what it declares. */
function declare(script: string): Declared {
  let declared: Declared | null = null;
  // Running the theme's script is the point.
  new Function("threadlines", script)({
    backdrop: (input: Declared) => {
      declared = input;
    },
  });
  if (!declared) throw new Error("The script never called threadlines.backdrop().");
  return declared;
}

/** The target and info the prelude would hand `draw` for a 1440×900 window. */
function targetFor(art: Declared) {
  const width = 1440;
  const height = 900;
  if (art.mode === "grid" && art.cell) {
    const cols = Math.ceil(width / art.cell.width);
    const rows = Math.ceil(height / art.cell.height);
    const cells = cols * rows;
    return {
      target: {
        glyph: new Int16Array(cells).fill(-1),
        fg: new Uint8Array(cells * 4),
        bg: new Uint8Array(cells * 4),
        cols,
        rows,
      },
      info: { width, height, cols, rows, cell: art.cell },
    };
  }
  const scale = art.scale ?? 4;
  const pixelWidth = art.width ?? Math.ceil(width / scale);
  const pixelHeight = art.height ?? Math.ceil(height / scale);
  const buffer = new ArrayBuffer(pixelWidth * pixelHeight * 4);
  return {
    target: {
      data: new Uint8ClampedArray(buffer),
      u32: new Uint32Array(buffer),
      width: pixelWidth,
      height: pixelHeight,
    },
    info: { width, height, cols: pixelWidth, rows: pixelHeight },
  };
}

/** Offered and retired: a retired starter is still worn, so it keeps passing every check. */
const EVERY_STARTER = [...STARTER_THEMES, ...RETIRED_STARTER_THEMES];

describe("starter themes", () => {
  it("list as their summaries say, without loading their art", () => {
    expect(STARTER_SUMMARIES).toEqual(
      STARTER_THEMES.map(({ id, manifest }) => ({
        id,
        name: manifest.name,
        base: manifest.base,
        hasArt: manifest.backdrop !== undefined,
        colors: {
          background: manifest.colors.background,
          foreground: manifest.colors.foreground,
          accent: manifest.colors.accent,
        },
      })),
    );
  });

  it("have stable, unique ids, retired ones still found by theirs", () => {
    expect(STARTER_THEMES.map((starter) => starter.id)).toEqual([
      "aurora",
      "meadow",
      "phosphor",
      "snowfield",
      "tokyo-rain",
    ]);
    // A device that chose one of these keeps it.
    expect(RETIRED_STARTER_THEMES.map((starter) => starter.id)).toEqual([
      "dunes",
      "night-rain",
      "ember",
    ]);
  });

  it.each(EVERY_STARTER)("$id passes the theme check", ({ manifest }) => {
    const check = checkThemeManifest(manifest);
    expect(check.ok ? [] : check.errors).toEqual([]);
  });

  it.each(EVERY_STARTER)(
    "$id's code and terminal colors read on their backgrounds",
    ({ manifest }) => {
      const tokens = resolveThemeTokens(manifest);
      const background = color(tokens.background);
      const codeBackground = composite(color(tokens["code-background"]), background);
      for (const [slot, value] of Object.entries(manifest.code ?? {})) {
        if (!value) continue;
        expect([slot, contrastRatio(color(value), codeBackground) >= 4.5]).toEqual([slot, true]);
      }
      // Black and white are excepted against their own extreme (slots 0, 7, 8 on dark; 0 and 15 on light).
      const excepted = manifest.base === "dark" ? [0] : [7, 15];
      manifest.terminal?.forEach((value, slot) => {
        if (excepted.includes(slot)) return;
        expect([slot, contrastRatio(color(value), background) >= 4.5]).toEqual([slot, true]);
      });
    },
  );

  it.each(EVERY_STARTER.filter((starter) => starter.manifest.backdrop))(
    "$id's art draws in its declared mode, idle, working and after a turn",
    ({ manifest }) => {
      const backdrop = manifest.backdrop!;
      const art = declare(backdrop.script);
      expect(art.mode).toBe(backdrop.mode);
      expect(backdrop.maxFps).toBeLessThanOrEqual(24);
      const { target, info } = targetFor(art);
      const palette = resolveThemeTokens(manifest);
      art.setup?.({ ...info, t: 0, dt: 0.1, frame: 0, palette, state: idle }, target);
      const states = [
        idle,
        { ...idle, working: 2 },
        { ...idle, pulse: 0.97, sincePulse: 0.05 },
        { ...idle, pulse: 0.6, sincePulse: 0.8 },
      ];
      states.forEach((state, frame) => {
        art.draw(target, { ...info, t: frame * 0.1, dt: 0.1, frame, palette, state });
      });
      if (art.mode === "grid" && "glyph" in target) {
        const glyphCount = [...(art.glyphs ?? "")].length;
        expect(target.glyph.every((glyph) => glyph >= -1 && glyph < glyphCount)).toBe(true);
        expect(target.glyph.some((glyph) => glyph >= 0)).toBe(true);
      }
    },
  );

  // An hour in, motion drawn as time × a speed that changes with state lands
  // somewhere else entirely the frame agents start or stop: Dunes' wind
  // streaks teleported and raced after every turn.
  it.each(EVERY_STARTER.filter((starter) => starter.manifest.backdrop))(
    "$id's art eases in and out of the working look without jumping, an hour in",
    ({ manifest }) => {
      const art = declare(manifest.backdrop!.script);
      const { target, info } = targetFor(art);
      const palette = resolveThemeTokens(manifest);
      const dt = 1 / 24;
      const start = 3600;
      art.setup?.({ ...info, t: start, dt, frame: 0, palette, state: idle }, target);
      // One second idle, three working, three idle again.
      const steps: number[] = [];
      let last: Float32Array | null = null;
      for (let frame = 0; frame < 168; frame++) {
        const state = frame >= 24 && frame < 96 ? { ...idle, working: 1 } : idle;
        art.draw(target, { ...info, t: start + frame * dt, dt, frame, palette, state });
        const shown = seen(target);
        if (last) steps.push(meanDifference(last, shown));
        last = shown;
      }
      // steps[i] is the change from frame i to i + 1: agents start at frame 24 and stop at 96.
      const others = steps
        .filter((_, index) => index !== 23 && index !== 95)
        .toSorted((a, b) => a - b);
      const typical = others[Math.floor(others.length / 2)]!;
      expect(steps[23]! / typical).toBeLessThan(3);
      expect(steps[95]! / typical).toBeLessThan(3);
    },
  );
});

/** What a frame shows, premultiplied: pixels as drawn, a grid's glyphs and cell backgrounds by their alpha. */
function seen(target: ReturnType<typeof targetFor>["target"]): Float32Array {
  if ("data" in target) return Float32Array.from(target.data);
  const out = new Float32Array(target.glyph.length * 6);
  for (let k = 0; k < target.glyph.length; k++) {
    const glyphAlpha = (target.glyph[k] ?? -1) >= 0 ? (target.fg[k * 4 + 3] ?? 0) / 255 : 0;
    const cellAlpha = (target.bg[k * 4 + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c++) {
      out[k * 6 + c] = (target.fg[k * 4 + c] ?? 0) * glyphAlpha;
      out[k * 6 + 3 + c] = (target.bg[k * 4 + c] ?? 0) * cellAlpha;
    }
  }
  return out;
}

function meanDifference(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

const idle = { working: 0, waiting: 0, pulse: 0, sincePulse: 1e9 };
