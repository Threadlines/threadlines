/**
 * Color math for themes (docs/design/custom-themes.md): parsing the color
 * forms the app's tokens use, OKLCH for deriving shades, WCAG contrast, and
 * alpha compositing the way the browser does it (in sRGB).
 *
 * Pure and dependency-free: the backdrop frame inlines parts of this module
 * into its walled-off document, so nothing here may import anything.
 */

/** A color with sRGB channels and alpha, all from 0 to 1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Oklch {
  readonly l: number;
  readonly c: number;
  /** Hue in degrees. */
  readonly h: number;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

const NAMED: Record<string, Rgba> = {
  white: { r: 1, g: 1, b: 1, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

const parseNumber = (raw: string, percentScale: number): number | null => {
  const text = raw.trim();
  if (text.endsWith("%")) {
    const value = Number(text.slice(0, -1));
    return Number.isFinite(value) ? (value / 100) * percentScale : null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const parseAlpha = (raw: string | undefined): number | null => {
  if (raw === undefined) return 1;
  const value = parseNumber(raw, 1);
  return value === null ? null : clamp01(value);
};

/** Splits `a b c / d` or `a, b, c, d` into channel strings and an optional alpha. */
const splitArgs = (body: string): { channels: string[]; alpha: string | undefined } | null => {
  const [main, slashAlpha] = body.split("/");
  if (main === undefined) return null;
  const parts = main
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (slashAlpha !== undefined) return { channels: parts, alpha: slashAlpha.trim() };
  if (parts.length === 4) return { channels: parts.slice(0, 3), alpha: parts[3] };
  return { channels: parts, alpha: undefined };
};

/**
 * Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, `oklch()`, and
 * `white`, `black`, `transparent`. Anything else (variables, `color-mix`) is
 * null: resolve those first.
 */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  const named = NAMED[text];
  if (named) return named;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3) {
      const [r, g, b] = [...hex].map((digit) => Number.parseInt(digit + digit, 16) / 255);
      return { r: r!, g: g!, b: b!, a: 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) : 1 };
    }
    return null;
  }
  const call = /^([a-z]+)\((.*)\)$/.exec(text);
  if (!call) return null;
  const [, fn, body] = call;
  const args = splitArgs(body!);
  if (!args || args.channels.length !== 3) return null;
  const alpha = parseAlpha(args.alpha);
  if (alpha === null) return null;
  if (fn === "rgb" || fn === "rgba") {
    const values = args.channels.map((channel) => parseNumber(channel, 255));
    if (values.some((value) => value === null)) return null;
    const [r, g, b] = values as number[];
    return { r: clamp01(r! / 255), g: clamp01(g! / 255), b: clamp01(b! / 255), a: alpha };
  }
  if (fn === "oklch") {
    const l = parseNumber(args.channels[0]!, 1);
    const c = parseNumber(args.channels[1]!, 0.4);
    const h =
      args.channels[2] === "none" ? 0 : parseNumber(args.channels[2]!.replace("deg", ""), 360);
    if (l === null || c === null || h === null) return null;
    return { ...oklchToRgb({ l, c, h }), a: alpha };
  }
  return null;
}

/** Like parseColor, but throws on anything it can't read. */
export function color(input: string): Rgba {
  const parsed = parseColor(input);
  if (!parsed) throw new Error(`Not a color: ${input}`);
  return parsed;
}

const hexByte = (value: number) =>
  Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when not opaque. */
export function formatHex(value: Rgba): string {
  const base = `#${hexByte(value.r)}${hexByte(value.g)}${hexByte(value.b)}`;
  return value.a >= 1 ? base : `${base}${hexByte(value.a)}`;
}

export const srgbToLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

export const linearToSrgb = (channel: number) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** WCAG relative luminance; alpha is ignored (composite first). */
export function relativeLuminance(value: Pick<Rgba, "r" | "g" | "b">): number {
  return (
    0.2126 * srgbToLinear(value.r) + 0.7152 * srgbToLinear(value.g) + 0.0722 * srgbToLinear(value.b)
  );
}

/** WCAG contrast ratio between two luminances, 1 to 21. */
export const contrastOfLuminances = (first: number, second: number) =>
  (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

/** WCAG contrast ratio of two opaque colors. */
export function contrastRatio(first: Rgba, second: Rgba): number {
  return contrastOfLuminances(relativeLuminance(first), relativeLuminance(second));
}

/** `top` laid over `bottom`, mixed in sRGB as the browser paints it. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top.a + bottom.a * (1 - top.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (front: number, back: number) =>
    (front * top.a + back * bottom.a * (1 - top.a)) / alpha;
  return {
    r: channel(top.r, bottom.r),
    g: channel(top.g, bottom.g),
    b: channel(top.b, bottom.b),
    a: alpha,
  };
}

/** `amount` of `to` mixed into `from`, in sRGB. */
export function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  const t = clamp01(amount);
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t,
  };
}

export const withAlpha = (value: Rgba, alpha: number): Rgba => ({ ...value, a: clamp01(alpha) });

export function rgbToOklch(value: Pick<Rgba, "r" | "g" | "b">): Oklch {
  const r = srgbToLinear(value.r);
  const g = srgbToLinear(value.g);
  const b = srgbToLinear(value.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(labA, labB);
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(labB, labA) * 180) / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

const oklchToLinear = ({ l, c, h }: Oklch): [number, number, number] => {
  const radians = (h * Math.PI) / 180;
  const labA = c * Math.cos(radians);
  const labB = c * Math.sin(radians);
  const lPrime = (l + 0.3963377774 * labA + 0.2158037573 * labB) ** 3;
  const mPrime = (l - 0.1055613458 * labA - 0.0638541728 * labB) ** 3;
  const sPrime = (l - 0.0894841775 * labA - 1.291485548 * labB) ** 3;
  return [
    4.0767416621 * lPrime - 3.3077115913 * mPrime + 0.2309699292 * sPrime,
    -1.2684380046 * lPrime + 2.6097574011 * mPrime - 0.3413193965 * sPrime,
    -0.0041960863 * lPrime - 0.7034186147 * mPrime + 1.707614701 * sPrime,
  ];
};

const inGamut = (channels: [number, number, number]) =>
  channels.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

/** OKLCH to sRGB, lowering chroma until the color fits the sRGB gamut. */
export function oklchToRgb(input: Oklch): Rgba {
  const l = clamp01(input.l);
  let c = Math.max(0, input.c);
  let linear = oklchToLinear({ l, c, h: input.h });
  if (!inGamut(linear)) {
    let low = 0;
    let high = c;
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: input.h }))) low = mid;
      else high = mid;
    }
    c = low;
    linear = oklchToLinear({ l, c, h: input.h });
  }
  return {
    r: clamp01(linearToSrgb(clamp01(linear[0]))),
    g: clamp01(linearToSrgb(clamp01(linear[1]))),
    b: clamp01(linearToSrgb(clamp01(linear[2]))),
    a: 1,
  };
}

/** The color with its OKLCH lightness moved by `delta`, hue and chroma kept. */
export function shiftLightness(value: Rgba, delta: number): Rgba {
  const lch = rgbToOklch(value);
  return { ...oklchToRgb({ ...lch, l: lch.l + delta }), a: value.a };
}

/** The color at OKLCH lightness `lightness`, hue and chroma kept. */
export function atLightness(value: Rgba, lightness: number): Rgba {
  const lch = rgbToOklch(value);
  return { ...oklchToRgb({ ...lch, l: lightness }), a: value.a };
}

/**
 * The nearest shade of `value` (same hue, OKLCH lightness moved away from
 * the surface) that reaches `ratio` against `surface`. Returns `value`
 * unchanged when it already does; the extreme it reaches otherwise.
 */
export function ensureContrast(value: Rgba, surface: Rgba, ratio: number): Rgba {
  const opaque = { ...value, a: 1 };
  if (contrastRatio(opaque, surface) >= ratio) return opaque;
  const lch = rgbToOklch(opaque);
  const surfaceL = rgbToOklch(surface).l;
  const direction = lch.l >= surfaceL ? 1 : -1;
  const target = (lightness: number) => oklchToRgb({ ...lch, l: lightness });
  const tryDirection = (sign: number): Rgba | null => {
    for (let l = lch.l; l >= 0 && l <= 1; l += 0.01 * sign) {
      const candidate = target(l);
      if (contrastRatio(candidate, surface) >= ratio) return candidate;
    }
    return null;
  };
  return (
    tryDirection(direction) ??
    tryDirection(-direction) ??
    (contrastRatio(color("#ffffff"), surface) > contrastRatio(color("#000000"), surface)
      ? color("#ffffff")
      : color("#000000"))
  );
}

/** A per-channel color box: every blend of colors inside it stays inside it. */
export interface ColorBox {
  readonly min: Pick<Rgba, "r" | "g" | "b">;
  readonly max: Pick<Rgba, "r" | "g" | "b">;
}

/** The box around the given opaque colors. */
export function colorBox(colors: ReadonlyArray<Pick<Rgba, "r" | "g" | "b">>): ColorBox {
  let minR = 1;
  let minG = 1;
  let minB = 1;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (const value of colors) {
    if (value.r < minR) minR = value.r;
    if (value.g < minG) minG = value.g;
    if (value.b < minB) minB = value.b;
    if (value.r > maxR) maxR = value.r;
    if (value.g > maxG) maxG = value.g;
    if (value.b > maxB) maxB = value.b;
  }
  return { min: { r: minR, g: minG, b: minB }, max: { r: maxR, g: maxG, b: maxB } };
}

export interface GlassText {
  /** Opaque text color. */
  readonly color: Pick<Rgba, "r" | "g" | "b">;
  /** The contrast it needs, usually 4.5. */
  readonly ratio: number;
}

/**
 * The lowest tint (alpha of `tint` laid over the art) at or above `floor`
 * that keeps every text color at its ratio for any pixel inside `box`.
 *
 * Laying the tint over the box maps it to a smaller box, channel by channel;
 * luminance grows with every channel, so the new box's darkest and
 * brightest corners bound the luminance of every pixel under the text. A
 * text color passes when that whole luminance range sits far enough above or
 * below it. Returns 1 when only an opaque tint works (the tint is the theme's
 * background, which the contrast table already checked).
 */
export function minimumGlassTint(input: {
  readonly tint: Pick<Rgba, "r" | "g" | "b">;
  readonly box: ColorBox;
  readonly texts: ReadonlyArray<GlassText>;
  readonly floor: number;
}): number {
  const passes = (alpha: number) => {
    const over = (channel: "r" | "g" | "b", value: number) =>
      alpha * input.tint[channel] + (1 - alpha) * value;
    const low = relativeLuminance({
      r: over("r", input.box.min.r),
      g: over("g", input.box.min.g),
      b: over("b", input.box.min.b),
    });
    const high = relativeLuminance({
      r: over("r", input.box.max.r),
      g: over("g", input.box.max.g),
      b: over("b", input.box.max.b),
    });
    return input.texts.every((text) => {
      const textLuminance = relativeLuminance(text.color);
      const lighterText = (textLuminance + 0.05) / (high + 0.05) >= text.ratio;
      const darkerText = (low + 0.05) / (textLuminance + 0.05) >= text.ratio;
      return lighterText || darkerText;
    });
  };
  const start = clamp01(input.floor);
  if (passes(start)) return start;
  for (let alpha = Math.ceil(start * 100) / 100; alpha < 1; alpha += 0.01) {
    if (passes(alpha)) return Math.min(1, alpha);
  }
  return 1;
}
