/**
 * A theme's full token set from its dozen seed colors
 * (docs/design/custom-themes.md, "What a theme is"). The derivation follows
 * the built-in elevation ladder in apps/web/src/index.css: frame and chrome,
 * canvas, rails, cards and popovers step in OKLCH lightness from the seed
 * background, keeping its hue, and the translucent washes are the theme's own
 * ink at the built-in strengths.
 *
 * Token names are written without the leading `--`.
 */
import type { ThemeBase, ThemeManifest, ThemeSeedColors } from "@threadlines/contracts";

import {
  atLightness,
  color,
  composite,
  contrastRatio,
  ensureContrast,
  formatHex,
  mix,
  oklchToRgb,
  type Rgba,
  rgbToOklch,
  shiftLightness,
  withAlpha,
} from "./color.ts";

/**
 * Every color token a theme sets. Provider, usage-chart and context-category
 * colors are not here: they mean something (a provider, a model, a kind of
 * context) and keep their built-in values under every theme.
 */
export const THEME_TOKEN_NAMES = [
  "background",
  "app-chrome-background",
  "frame",
  "foreground",
  "card",
  "card-foreground",
  "rail",
  "agent-line",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "popover",
  "popover-foreground",
  "app-accent-blue",
  "primary",
  "primary-hover",
  "primary-readable",
  "primary-graph",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "group-muted-foreground",
  "accent",
  "accent-foreground",
  "pick-selected",
  "control-active",
  "group",
  "group-ring",
  "group-divider",
  "control",
  "control-hover",
  "control-pressed",
  "field",
  "placeholder",
  "switch-off",
  "segmented-track",
  "destructive",
  "border",
  "input",
  "ring",
  "focus-ring",
  "destructive-foreground",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "text-selection",
  /** New with themes: the opaque base behind everything that must hide what scrolls under it. */
  "surface-solid",
  /** New with themes: the background of code blocks. */
  "code-background",
] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

/**
 * Tokens that must stay opaque, overrides included: surfaces text sits on
 * and the colors text is drawn in. The readability check and the glass tint
 * measure them as solid colors.
 */
export const THEME_OPAQUE_TOKENS: ReadonlySet<ThemeTokenName> = new Set<ThemeTokenName>([
  "background",
  "app-chrome-background",
  "frame",
  "foreground",
  "card",
  "card-foreground",
  "rail",
  "sidebar",
  "sidebar-foreground",
  "sidebar-accent-foreground",
  "popover",
  "popover-foreground",
  "app-accent-blue",
  "primary",
  "primary-hover",
  "primary-readable",
  "primary-graph",
  "primary-foreground",
  "secondary-foreground",
  "muted-foreground",
  "group-muted-foreground",
  "accent-foreground",
  "placeholder",
  "destructive",
  "ring",
  "destructive-foreground",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "surface-solid",
]);

/** Tokens a theme file may replace by name. The opaque base follows `background`. */
export const THEME_OVERRIDABLE_TOKENS: ReadonlyArray<ThemeTokenName> = THEME_TOKEN_NAMES.filter(
  (name) => name !== "surface-solid",
);

/** Tailwind colors index.css uses, shared with the built-in token tables (builtinTokens.ts). */
export const TAILWIND = {
  white: "#ffffff",
  black: "#000000",
  red400: "oklch(70.4% 0.191 22.216)",
  red500: "oklch(63.7% 0.237 25.331)",
  red700: "oklch(50.5% 0.213 27.518)",
  emerald400: "oklch(76.5% 0.177 163.223)",
  emerald500: "oklch(69.6% 0.17 162.48)",
  emerald700: "oklch(50.8% 0.118 165.612)",
  amber400: "oklch(82.8% 0.189 84.429)",
  amber500: "oklch(76.9% 0.188 70.08)",
  amber700: "oklch(55.5% 0.163 48.998)",
} as const;

/** The ratio text-like accent shades are pushed to against the canvas. */
const READABLE_RATIO = 4.5;

/**
 * The full token set for a theme's seeds. Every value is `#rrggbb` or, for
 * translucent washes, `#rrggbbaa`.
 */
export function deriveThemeTokens(seeds: ThemeSeedColors, base: ThemeBase): ThemeTokens {
  const dark = base === "dark";
  const background = { ...color(seeds.background), a: 1 };
  const foreground = { ...color(seeds.foreground), a: 1 };
  const muted = { ...color(seeds.mutedForeground), a: 1 };
  const accent = { ...color(seeds.accent), a: 1 };
  const accentForeground = { ...color(seeds.accentForeground), a: 1 };
  const backgroundL = rgbToOklch(background).l;
  const step = (delta: number): Rgba => atLightness(background, backgroundL + delta);
  const ink = (alpha: number) => withAlpha(foreground, alpha);
  /**
   * The theme's ink at `alpha`, or stronger when a dim ink would leave a mark
   * (a focus ring, a track, a border) under the ratio the readability table
   * asks of it on `surface`.
   */
  const inkAtLeast = (alpha: number, ratio: number, surface: Rgba = background) => {
    for (let next = alpha; next < 1; next += 0.01) {
      if (contrastRatio(composite(ink(next), surface), surface) >= ratio) return ink(next);
    }
    return ink(1);
  };
  const hex = formatHex;

  const chrome = step(dark ? -0.038 : -0.03);
  const rail = step(dark ? 0.032 : -0.015);
  const card = dark ? step(0.064) : step(Math.min(0.02, 1 - backgroundL));
  const popover = dark ? step(0.084) : card;
  const frame = dark ? rail : chrome;

  // A text shade of a status hue must read on the canvas and on its own badge
  // wash (the hue at 8% light, 16% dark, ui/badge.tsx), which is the harder of
  // the two; a small margin keeps rounding from landing just under.
  const badgeWash = (hue: Rgba) => composite(withAlpha(hue, dark ? 0.16 : 0.08), background);
  const readable = (value: Rgba, washOf: Rgba = value) =>
    ensureContrast(
      ensureContrast(value, badgeWash(washOf), READABLE_RATIO + 0.1),
      background,
      READABLE_RATIO,
    );
  const info = seeds.info ? { ...color(seeds.info), a: 1 } : accent;
  const primaryReadable = readable(dark ? shiftLightness(accent, 0.12) : accent, info);
  const success = color(seeds.success ?? TAILWIND.emerald500);
  const warning = color(seeds.warning ?? TAILWIND.amber500);
  const dangerSeed = seeds.danger
    ? color(seeds.danger)
    : dark
      ? mix(color(TAILWIND.red500), color(TAILWIND.white), 0.1)
      : color(TAILWIND.red500);
  // Filled destructive buttons put white on it (ui/button.tsx).
  const danger = ensureContrast(dangerSeed, color(TAILWIND.white), 3.05);
  const accentHue = rgbToOklch(accent).h;
  const selection = seeds.selection
    ? color(seeds.selection)
    : oklchToRgb({ l: dark ? 0.42 : 0.86, c: 0.07, h: accentHue });
  const border = seeds.border ? color(seeds.border) : inkAtLeast(dark ? 0.14 : 0.08, 1.12);
  // Faint on purpose, never mistaken for typed text, but still there (1.5:1 on the composer).
  let placeholder = mix(muted, background, dark ? 0.45 : 0.5);
  for (
    let amount = dark ? 0.45 : 0.5;
    amount > 0 && contrastRatio(placeholder, card) < 1.55;
    amount -= 0.05
  ) {
    placeholder = mix(muted, background, amount);
  }
  const field = dark
    ? withAlpha(color(TAILWIND.black), 0.12)
    : step(Math.min(0.005, 1 - backgroundL));

  return {
    background: hex(background),
    "app-chrome-background": hex(chrome),
    frame: hex(frame),
    foreground: hex(foreground),
    card: hex(card),
    "card-foreground": hex(foreground),
    rail: hex(rail),
    "agent-line": hex(ink(dark ? 0.2 : 0.17)),
    sidebar: hex(rail),
    "sidebar-foreground": hex(foreground),
    "sidebar-border": hex(border),
    "sidebar-accent": hex(ink(dark ? 0.1 : 0.06)),
    "sidebar-accent-foreground": hex(foreground),
    popover: hex(popover),
    "popover-foreground": hex(foreground),
    "app-accent-blue": hex(accent),
    primary: hex(accent),
    "primary-hover": hex(shiftLightness(accent, dark ? 0.05 : -0.08)),
    "primary-readable": hex(primaryReadable),
    "primary-graph": hex(primaryReadable),
    "primary-foreground": hex(accentForeground),
    secondary: hex(ink(dark ? 0.08 : 0.04)),
    "secondary-foreground": hex(foreground),
    muted: hex(ink(dark ? 0.09 : 0.04)),
    "muted-foreground": hex(muted),
    "group-muted-foreground": hex(dark ? shiftLightness(muted, 0.06) : muted),
    accent: hex(ink(dark ? 0.09 : 0.04)),
    "accent-foreground": hex(foreground),
    "pick-selected": hex(ink(dark ? 0.04 : 0.03)),
    "control-active": hex(ink(dark ? 0.17 : 0.09)),
    group: hex(ink(dark ? 0.045 : 0.035)),
    "group-ring": hex(ink(0.05)),
    "group-divider": hex(ink(0.07)),
    control: hex(dark ? ink(0.1) : card),
    "control-hover": hex(dark ? ink(0.14) : step(-0.005)),
    "control-pressed": hex(dark ? ink(0.07) : step(-0.03)),
    field: hex(field),
    placeholder: hex(placeholder),
    "switch-off": hex(inkAtLeast(dark ? 0.22 : 0.2, 1.32)),
    "segmented-track": hex(dark ? field : ink(0.06)),
    destructive: hex(danger),
    border: hex(border),
    input: hex(inkAtLeast(dark ? 0.13 : 0.1, 1.17)),
    ring: hex(accent),
    "focus-ring": hex(inkAtLeast(dark ? 0.55 : 0.5, 3.05)),
    "destructive-foreground": hex(
      readable(dark ? shiftLightness(dangerSeed, 0.06) : dangerSeed, danger),
    ),
    info: hex(info),
    "info-foreground": hex(seeds.info ? readable(info) : primaryReadable),
    success: hex(success),
    "success-foreground": hex(readable(dark ? shiftLightness(success, 0.06) : success)),
    warning: hex(warning),
    "warning-foreground": hex(readable(dark ? shiftLightness(warning, 0.06) : warning)),
    "text-selection": hex(selection),
    "surface-solid": hex(background),
    "code-background": hex(
      seeds.codeBackground ? color(seeds.codeBackground) : ink(dark ? 0.09 : 0.04),
    ),
  };
}

/**
 * A theme's tokens with its overrides applied. Override names that aren't
 * overridable are ignored here; validation (manifest.ts) rejects them.
 */
export function resolveThemeTokens(
  manifest: Pick<ThemeManifest, "base" | "colors" | "overrides">,
): ThemeTokens {
  const derived = deriveThemeTokens(manifest.colors, manifest.base);
  if (!manifest.overrides) return derived;
  const resolved: Record<ThemeTokenName, string> = { ...derived };
  for (const [name, value] of Object.entries(manifest.overrides)) {
    if ((THEME_OVERRIDABLE_TOKENS as ReadonlyArray<string>).includes(name)) {
      resolved[name as ThemeTokenName] = value;
    }
  }
  return resolved;
}

/** The tokens as one CSS block body: `--background: #...; ...`. */
export function themeTokensCss(tokens: ThemeTokens): string {
  return THEME_TOKEN_NAMES.map((name) => `--${name}: ${tokens[name]};`).join(" ");
}
