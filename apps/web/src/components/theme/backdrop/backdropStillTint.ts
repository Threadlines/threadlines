/**
 * The tint glass text needs over a theme's still (docs/design/custom-themes.md,
 * "The fallback can't remeasure"): when the app shows the still instead of the
 * live frame (phones, Motion: Still, a failed frame), one layout-independent
 * tint covers every text surface. It comes from the per-channel color box of
 * the whole still, measured at its full size so no thin bright or dark
 * detail is averaged away (the shown still is a blend of its pixels at any
 * scale, so the box bounds it).
 */
import {
  color,
  colorBox,
  minimumGlassTint,
  type ColorBox,
  type Rgba,
} from "@threadlines/shared/themeColor";
import { GLASS_TEXT_RATIO, glassTextColors } from "@threadlines/shared/themeContrast";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

/**
 * The largest still measured, each way. The frame never captures one that
 * big (`capture-still` is capped at 4096 px); a bigger one (an imported
 * file) isn't measured at all, since sampling it down could skip its
 * brightest or darkest lines, and text over it gets an opaque surface.
 */
const MAX_MEASURE_SIDE = 4096;

/** The still's color box (being) measured, with the solid surface it sits on: once per still. */
let measured: { still: string; surface: string; box: Promise<ColorBox | null> } | null = null;

/**
 * The lowest tint that keeps every glass text color at `ratio` (4.5 by
 * default) over any pixel of the still; 1 when it can't be read. Moving the
 * Glass slider asks again with new ratios, so the pixels are scanned once.
 */
export async function measureStillTint(
  still: string,
  tokens: ThemeTokens,
  ratio = GLASS_TEXT_RATIO.standard,
): Promise<number> {
  const surface = tokens["surface-solid"];
  if (!measured || measured.still !== still || measured.surface !== surface) {
    measured = { still, surface, box: stillColorBox(still, tokens) };
  }
  const box = await measured.box;
  if (!box) return 1;
  return minimumGlassTint({
    tint: color(tokens.background),
    box,
    texts: glassTextColors(tokens).map((text) => ({ color: color(text.color), ratio })),
    floor: 0,
  });
}

/** The per-channel color box of every pixel in the still, and the solid surface; null when it can't be measured. */
async function stillColorBox(still: string, tokens: ThemeTokens): Promise<ColorBox | null> {
  const image = new Image();
  image.decoding = "async";
  image.src = still;
  try {
    await image.decode();
  } catch {
    return null;
  }
  if (Math.max(image.naturalWidth, image.naturalHeight) > MAX_MEASURE_SIDE) return null;
  const width = Math.max(1, image.naturalWidth);
  const height = Math.max(1, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const base: Rgba = { ...color(tokens["surface-solid"]), a: 1 };
  let minR = base.r;
  let minG = base.g;
  let minB = base.b;
  let maxR = base.r;
  let maxG = base.g;
  let maxB = base.b;
  for (let at = 0; at < data.length; at += 4) {
    const r = data[at]! / 255;
    const g = data[at + 1]! / 255;
    const b = data[at + 2]! / 255;
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
  }
  return colorBox([
    { r: minR, g: minG, b: minB },
    { r: maxR, g: maxG, b: maxB },
  ]);
}
