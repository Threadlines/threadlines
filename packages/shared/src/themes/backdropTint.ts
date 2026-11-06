/**
 * The readability math the backdrop frame runs on what the art just drew
 * (docs/design/custom-themes.md, "Frosting and tint happen in the frame").
 *
 * `backdropTintMath` is a closed factory: nothing inside it refers to
 * anything outside it, so the frame document inlines it as source
 * (Function.prototype.toString) into a walled-off frame that can't import.
 * It is color.ts's `relativeLuminance` and `minimumGlassTint` with the text
 * luminances worked out once instead of on every step; backdrop.test.ts
 * checks the two agree.
 */

export interface BackdropTintBox {
  minR: number;
  minG: number;
  minB: number;
  maxR: number;
  maxG: number;
  maxB: number;
}

export interface BackdropTintMath {
  /** WCAG relative luminance of sRGB channels from 0 to 1. */
  readonly luminance: (r: number, g: number, b: number) => number;
  /**
   * The lowest tint at or above `floor` that keeps every text (given by its
   * luminance and the ratio it needs) readable over any color in the box,
   * with the tint color laid over it. 1 when only an opaque tint works.
   */
  readonly minimumTint: (
    tint: { readonly r: number; readonly g: number; readonly b: number },
    box: BackdropTintBox,
    texts: ReadonlyArray<{ readonly luminance: number; readonly ratio: number }>,
    floor: number,
  ) => number;
}

export function backdropTintMath(): BackdropTintMath {
  const toLinear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const luminance = (r: number, g: number, b: number) =>
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  const minimumTint: BackdropTintMath["minimumTint"] = (tint, box, texts, floor) => {
    const passes = (alpha: number) => {
      const keep = 1 - alpha;
      const low = luminance(
        alpha * tint.r + keep * box.minR,
        alpha * tint.g + keep * box.minG,
        alpha * tint.b + keep * box.minB,
      );
      const high = luminance(
        alpha * tint.r + keep * box.maxR,
        alpha * tint.g + keep * box.maxG,
        alpha * tint.b + keep * box.maxB,
      );
      for (const text of texts) {
        const lighterText = (text.luminance + 0.05) / (high + 0.05) >= text.ratio;
        const darkerText = (low + 0.05) / (text.luminance + 0.05) >= text.ratio;
        if (!lighterText && !darkerText) return false;
      }
      return true;
    };
    const start = floor < 0 ? 0 : floor > 1 ? 1 : floor;
    if (passes(start)) return start;
    for (let alpha = Math.ceil(start * 100) / 100; alpha < 1; alpha += 0.01) {
      if (passes(alpha)) return Math.min(1, alpha);
    }
    return 1;
  };
  return { luminance, minimumTint };
}
