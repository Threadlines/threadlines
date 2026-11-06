import { describe, expect, it } from "vite-plus/test";

import { color, composite, contrastRatio } from "./color.ts";
import { checkThemeManifest } from "./manifest.ts";
import { STARTER_THEMES } from "./starters.ts";
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

describe("starter themes", () => {
  it("have stable, unique ids", () => {
    expect(STARTER_THEMES.map((starter) => starter.id)).toEqual([
      "aurora",
      "dunes",
      "phosphor",
      "snowfield",
      "night-rain",
      "ember",
    ]);
  });

  it.each(STARTER_THEMES)("$id passes the theme check", ({ manifest }) => {
    const check = checkThemeManifest(manifest);
    expect(check.ok ? [] : check.errors).toEqual([]);
  });

  it.each(STARTER_THEMES)(
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

  it.each(STARTER_THEMES.filter((starter) => starter.manifest.backdrop))(
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
});

const idle = { working: 0, waiting: 0, pulse: 0, sincePulse: 1e9 };
