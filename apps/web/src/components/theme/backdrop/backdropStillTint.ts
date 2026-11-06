/**
 * The tint glass text needs over a theme's still (docs/design/custom-themes.md,
 * "The fallback can't remeasure"): when the app shows the still instead of the
 * live frame (phones, Motion: Still, a failed frame), one layout-independent
 * tint covers every text surface. It comes from the per-channel color box of
 * the whole still, measured at its full size so no thin bright or dark
 * detail is averaged away (the shown still is a blend of its pixels at any
 * scale, so the box bounds it).
 */
import type { GlassReadability } from "@threadlines/contracts";
import { color, colorBox, minimumGlassTint, type Rgba } from "@threadlines/shared/themeColor";
import { glassTextColors } from "@threadlines/shared/themeContrast";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

/**
 * The largest still measured, each way. The frame never captures one that
 * big (`capture-still` is capped at 4096 px); a bigger one (an imported
 * file) isn't measured at all, since sampling it down could skip its
 * brightest or darkest lines, and text over it gets an opaque surface.
 */
const MAX_MEASURE_SIDE = 4096;

let cached: {
  still: string;
  background: string;
  readability: GlassReadability;
  tint: number;
} | null = null;

/** The lowest tint that keeps every glass text color readable over any pixel of the still; 1 when it can't be read. */
export async function measureStillTint(
  still: string,
  tokens: ThemeTokens,
  readability: GlassReadability = "standard",
): Promise<number> {
  if (
    cached &&
    cached.still === still &&
    cached.background === tokens.background &&
    cached.readability === readability
  )
    return cached.tint;
  const image = new Image();
  image.decoding = "async";
  image.src = still;
  try {
    await image.decode();
  } catch {
    return 1;
  }
  if (Math.max(image.naturalWidth, image.naturalHeight) > MAX_MEASURE_SIDE) return 1;
  const width = Math.max(1, image.naturalWidth);
  const height = Math.max(1, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 1;
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
  const tint = minimumGlassTint({
    tint: color(tokens.background),
    box: colorBox([
      { r: minR, g: minG, b: minB },
      { r: maxR, g: maxG, b: maxB },
    ]),
    texts: glassTextColors(tokens, readability).map((text) => ({
      color: color(text.color),
      ratio: text.ratio,
    })),
    floor: 0,
  });
  cached = { still, background: tokens.background, readability, tint };
  return tint;
}
