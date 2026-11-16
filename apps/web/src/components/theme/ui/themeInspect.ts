/**
 * The color editor's inspector (ThemeColorEditor.tsx): what a clicked spot
 * in the app is painted with, as the theme colors the editor lists. An
 * element's background (its own, or the nearest one behind it), its text and
 * its border are matched against the theme's app colors, then traced back to
 * the theme color each comes from (themeFit.ts themeTokenSeed), or to an
 * override when the theme sets that app color directly.
 */
import type { ThemeBase, ThemeSeedColors } from "@threadlines/contracts";
import { parseColor } from "@threadlines/shared/themeColor";
import { themeTokenSeed } from "@threadlines/shared/themeFit";
import { THEME_TOKEN_NAMES, type ThemeTokenName } from "@threadlines/shared/themeTokenNames";

export interface CssRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * A computed color as 0-255 channels and 0-1 alpha: hex, `rgb()`, `oklch()`
 * (the shared parser), or `color(srgb r g b / a)`, which a browser gives for
 * mixed colors (the glass tints, opacity utilities). Null for anything else.
 */
export function parseCssColor(value: string): CssRgba | null {
  const text = value.trim().toLowerCase();
  const srgb =
    /^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.e]+%?))?\s*\)$/.exec(text);
  if (srgb !== null) {
    const alpha = srgb[4];
    const channel = (raw: string) => Math.round(Math.min(1, Math.max(0, Number(raw))) * 255);
    return {
      r: channel(srgb[1]!),
      g: channel(srgb[2]!),
      b: channel(srgb[3]!),
      a:
        alpha === undefined
          ? 1
          : alpha.endsWith("%")
            ? Number(alpha.slice(0, -1)) / 100
            : Number(alpha),
    };
  }
  const parsed = parseColor(text);
  if (parsed === null) return null;
  return {
    r: Math.round(parsed.r * 255),
    g: Math.round(parsed.g * 255),
    b: Math.round(parsed.b * 255),
    a: parsed.a,
  };
}

/** The theme color, or override, a picked part of the app is painted with. */
export type PickedColor =
  | { readonly kind: "seed"; readonly key: keyof ThemeSeedColors }
  | { readonly kind: "override"; readonly token: ThemeTokenName };

export interface PickedRole {
  /** What part of the element: its background, its text, its border. */
  readonly part: "background" | "text" | "border";
  readonly token: ThemeTokenName;
  readonly color: PickedColor;
}

const close = (first: CssRgba, second: CssRgba, alphaToo: boolean) =>
  Math.abs(first.r - second.r) <= 2 &&
  Math.abs(first.g - second.g) <= 2 &&
  Math.abs(first.b - second.b) <= 2 &&
  (!alphaToo || Math.abs(first.a - second.a) <= 0.03);

/** App colors made for lines, and for text; every other is a surface. */
const LINE_TOKENS: ReadonlySet<ThemeTokenName> = new Set([
  "border",
  "sidebar-border",
  "input",
  "ring",
  "focus-ring",
  "group-ring",
  "group-divider",
  "agent-line",
]);
const isTextToken = (name: ThemeTokenName) =>
  name === "foreground" ||
  name.endsWith("-foreground") ||
  name === "placeholder" ||
  name === "primary-readable";

/** How well an app color fits the part it was found on: 0 is made for it. */
const fitOf = (name: ThemeTokenName, part: PickedRole["part"]) => {
  const kind = LINE_TOKENS.has(name) ? "border" : isTextToken(name) ? "text" : "background";
  return kind === part ? 0 : 1;
};

/**
 * The app color a painted color is: one that matches it exactly, else (for a
 * see-through paint, a wash of some color) one with its hue. Several app
 * colors can be the same color (a button's hover and the borders, say): one
 * the theme sets directly wins, then the one made for that part, then the
 * earlier name.
 */
export function tokenForColor(
  painted: CssRgba,
  tokens: Readonly<Record<ThemeTokenName, string>>,
  part: PickedRole["part"],
  overrides: Readonly<Record<string, string>> = {},
): ThemeTokenName | null {
  const rank = (name: ThemeTokenName) =>
    (overrides[name] === undefined ? 2 : 0) + fitOf(name, part);
  const parsed = THEME_TOKEN_NAMES.map((name) => [name, parseCssColor(tokens[name])] as const);
  const best = (alphaToo: boolean) =>
    parsed
      .filter(([, value]) => value !== null && close(value, painted, alphaToo))
      .map(([name]) => name)
      .toSorted((first, second) => rank(first) - rank(second))[0] ?? null;
  const exact = best(true);
  if (exact !== null) return exact;
  return painted.a >= 1 ? null : best(false);
}

const colorOf = (
  token: ThemeTokenName,
  base: ThemeBase,
  overrides: Readonly<Record<string, string>>,
): PickedColor | null => {
  if (overrides[token] !== undefined) return { kind: "override", token };
  const key = themeTokenSeed(token, base);
  return key === null ? null : { kind: "seed", key };
};

/** A computed style's colors, as getComputedStyle gives them. */
export interface PaintedStyle {
  readonly backgroundColor: string;
  readonly color: string;
  readonly borderTopColor: string;
  readonly borderTopWidth: string;
}

/**
 * What an element is painted with, given its style and the styles behind it
 * (nearest first): the first background that shows, its text, its border.
 */
export function pickedRoles(input: {
  readonly style: PaintedStyle;
  readonly behind: ReadonlyArray<PaintedStyle>;
  readonly tokens: Readonly<Record<ThemeTokenName, string>>;
  readonly base: ThemeBase;
  readonly overrides: Readonly<Record<string, string>>;
}): PickedRole[] {
  const roles: PickedRole[] = [];
  const add = (part: PickedRole["part"], value: string) => {
    const painted = parseCssColor(value);
    if (painted === null || painted.a === 0) return;
    const token = tokenForColor(painted, input.tokens, part, input.overrides);
    if (token === null) return;
    const color = colorOf(token, input.base, input.overrides);
    if (color !== null) roles.push({ part, token, color });
  };
  const background = [input.style, ...input.behind].find((style) => {
    const parsed = parseCssColor(style.backgroundColor);
    return parsed !== null && parsed.a > 0;
  });
  if (background !== undefined) add("background", background.backgroundColor);
  add("text", input.style.color);
  if (Number.parseFloat(input.style.borderTopWidth) > 0) add("border", input.style.borderTopColor);
  return roles;
}
