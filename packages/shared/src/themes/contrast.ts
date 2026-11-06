/**
 * The readability check (docs/design/custom-themes.md, "Readability check").
 * THEME_CONTRAST_PAIRS lists color pairs the UI actually renders, each with
 * the component it mirrors; translucent tokens are laid over the surface they
 * sit on before measuring. The built-in light and dark themes pass the same
 * table (a test), which keeps it honest. Changing a component's color classes
 * means updating its row here.
 */
import type { ThemeBase, ThemeManifest } from "@threadlines/contracts";

import { color, composite, contrastRatio, formatHex, type Rgba, withAlpha } from "./color.ts";
import { resolveThemeTokens, type ThemeTokenName, type ThemeTokens } from "./tokens.ts";

type ColorRef = ThemeTokenName | "white";

export interface ThemeContrastPair {
  readonly id: string;
  /** The text or mark. */
  readonly fg: ColorRef;
  /** What it sits on. Translucent values are laid over `over`. */
  readonly bg: ColorRef;
  /** An extra opacity on `bg` per base (a status badge's 8% / 16% wash). */
  readonly bgAlpha?: Readonly<Record<ThemeBase, number>>;
  /** The surface under a translucent `bg`. Defaults to `background`. */
  readonly over?: ThemeTokenName;
  readonly min: number;
  /** text: words people read; ui: dots, icons, borders, tracks. */
  readonly kind: "text" | "ui";
  /** The component this pair mirrors. */
  readonly source: string;
}

const text = (
  id: string,
  fg: ColorRef,
  bg: ColorRef,
  source: string,
  extra: Partial<Pick<ThemeContrastPair, "over" | "bgAlpha" | "min">> = {},
): ThemeContrastPair => ({ id, fg, bg, source, kind: "text", min: 4.5, ...extra });

const ui = (
  id: string,
  fg: ColorRef,
  bg: ColorRef,
  min: number,
  source: string,
  extra: Partial<Pick<ThemeContrastPair, "over" | "bgAlpha">> = {},
): ThemeContrastPair => ({ id, fg, bg, source, kind: "ui", min, ...extra });

const BADGE_TEXT = { bgAlpha: { light: 0.08, dark: 0.16 }, min: 4.4 } as const;

export const THEME_CONTRAST_PAIRS: ReadonlyArray<ThemeContrastPair> = [
  // Text on the surfaces of the elevation ladder.
  text("foreground/background", "foreground", "background", "index.css body"),
  text("foreground/frame", "foreground", "frame", "AppTitleBar, NavigationRail"),
  text("foreground/rail", "foreground", "rail", "right panels, RightPanelTabStrip"),
  text("foreground/sidebar", "sidebar-foreground", "sidebar", "ui/sidebar.tsx"),
  text("foreground/card", "card-foreground", "card", "ChatComposer, ui/card surfaces"),
  text(
    "foreground/popover",
    "popover-foreground",
    "popover",
    "ui/popover.tsx, ui/menu.tsx, ui/dialog.tsx",
  ),
  text("foreground/group", "foreground", "group", "settingsLayout SettingsGroup"),
  text("muted/background", "muted-foreground", "background", "timestamps, meta lines"),
  text("muted/frame", "muted-foreground", "frame", "title row, rail labels"),
  text("muted/rail", "muted-foreground", "rail", "panel headers"),
  text("muted/card", "muted-foreground", "card", "composer chips"),
  text("muted/popover", "muted-foreground", "popover", "menu shortcuts, dialog descriptions"),
  text("group-muted/group", "group-muted-foreground", "group", "settings descriptions in a group"),
  text(
    "group-muted/group-in-dialog",
    "group-muted-foreground",
    "group",
    "a group inside a dialog",
    {
      over: "popover",
    },
  ),
  text("selected-row", "sidebar-accent-foreground", "sidebar-accent", "Sidebar selected thread", {
    over: "sidebar",
  }),
  text("secondary", "secondary-foreground", "secondary", "ui/button.tsx secondary, user bubble"),
  text("menu-hover", "accent-foreground", "accent", "ui/menu.tsx highlighted item", {
    over: "popover",
  }),
  text("control", "foreground", "control", "ui/button.tsx outline (solid control)", {
    over: "card",
  }),
  text("control-hover", "foreground", "control-hover", "ui/button.tsx outline hover", {
    over: "card",
  }),
  text("control-pressed", "foreground", "control-pressed", "ui/button.tsx outline pressed", {
    over: "card",
  }),
  text("selection", "foreground", "text-selection", "::selection"),
  // The accent.
  text("on-primary", "primary-foreground", "primary", "ui/button.tsx default, send button"),
  text("on-primary-hover", "primary-foreground", "primary-hover", "ui/button.tsx default hover"),
  text("primary-readable/background", "primary-readable", "background", "links, selected labels"),
  text("info/background", "info-foreground", "background", "info notices"),
  // Status, as rendered.
  text("success/background", "success-foreground", "background", "status text"),
  text("warning/background", "warning-foreground", "background", "MessagesTimeline warnings"),
  text("destructive/background", "destructive-foreground", "background", "error text"),
  text("warning/card", "warning-foreground", "card", "composer notices"),
  text("destructive/card", "destructive-foreground", "card", "composer errors"),
  // Badges at 4.4: the built-in light warning badge measures 4.49.
  text("badge-success", "success-foreground", "success", "ui/badge.tsx success", BADGE_TEXT),
  text("badge-warning", "warning-foreground", "warning", "ui/badge.tsx warning", BADGE_TEXT),
  text("badge-info", "info-foreground", "info", "ui/badge.tsx info", BADGE_TEXT),
  text("badge-error", "destructive-foreground", "destructive", "ui/badge.tsx error", BADGE_TEXT),
  text(
    "on-destructive",
    "white",
    "destructive",
    "ui/button.tsx destructive, ui/badge.tsx destructive",
    {
      min: 3,
    },
  ),
  // Marks and boundaries.
  ui("status-dot/success", "success", "background", 2, "status dots"),
  ui("status-dot/warning", "warning", "background", 1.5, "status dots"),
  ui("status-dot/destructive", "destructive", "background", 2.5, "status dots"),
  ui("accent-mark", "primary", "background", 2, "switch on, selected marks"),
  ui("focus-ring", "focus-ring", "background", 3, "focus-visible rings"),
  ui("switch-off", "switch-off", "background", 1.3, "ui/switch.tsx off track"),
  ui("border", "border", "background", 1.1, "hairlines"),
  ui("input", "input", "background", 1.15, "ui/input.tsx border"),
  ui("placeholder", "placeholder", "card", 1.5, "composer placeholder"),
];

export interface ThemeContrastResult {
  readonly pair: ThemeContrastPair;
  readonly ratio: number;
  readonly passes: boolean;
}

const resolveRef = (tokens: ThemeTokens, ref: ColorRef): Rgba =>
  ref === "white" ? color("#ffffff") : color(tokens[ref]);

/** The opaque color a translucent token shows as, laid over `over` and then the solid base. */
function surfaceColor(
  tokens: ThemeTokens,
  ref: ColorRef,
  over: ThemeTokenName,
  extraAlpha: number,
): Rgba {
  const base = { ...color(tokens["surface-solid"]), a: 1 };
  const under = composite(color(tokens[over]), base);
  const top = resolveRef(tokens, ref);
  return composite(withAlpha(top, top.a * extraAlpha), under);
}

/** Every pair in the table, measured on a token set. */
export function measureThemeContrast(tokens: ThemeTokens, base: ThemeBase): ThemeContrastResult[] {
  return THEME_CONTRAST_PAIRS.map((pair) => {
    const bg = surfaceColor(tokens, pair.bg, pair.over ?? "background", pair.bgAlpha?.[base] ?? 1);
    const fg = composite(resolveRef(tokens, pair.fg), bg);
    const ratio = contrastRatio(fg, bg);
    return { pair, ratio, passes: ratio >= pair.min - 1e-9 };
  });
}

export interface ThemeContrastFailure {
  readonly id: string;
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly min: number;
  readonly source: string;
}

/** The pairs a theme fails, worded for an agent to fix: which tokens, the ratio, what's needed. */
export function themeContrastFailures(
  manifest: Pick<ThemeManifest, "base" | "colors" | "overrides" | "code" | "terminal">,
): ThemeContrastFailure[] {
  const tokens = resolveThemeTokens(manifest);
  return [
    ...measureThemeContrast(tokens, manifest.base)
      .filter((result) => !result.passes)
      .map(({ pair, ratio }) => ({
        id: pair.id,
        fg: pair.fg === "white" ? "#ffffff" : `--${pair.fg} (${formatHex(color(tokens[pair.fg]))})`,
        bg: `--${pair.bg === "white" ? "white" : pair.bg} (${pair.bg === "white" ? "#ffffff" : formatHex(color(tokens[pair.bg]))})`,
        ratio: Math.round(ratio * 100) / 100,
        min: pair.min,
        source: pair.source,
      })),
    ...paletteFailures(manifest, tokens),
  ];
}

/** Syntax colors, as code blocks and diffs draw them on the code background. */
const CODE_RATIOS: Readonly<Record<string, number>> = {
  foreground: 4.5,
  keyword: 4.5,
  string: 4.5,
  number: 4.5,
  function: 4.5,
  type: 4.5,
  variable: 4.5,
  operator: 4.5,
  // Quiet on purpose, but never gone.
  comment: 3,
  punctuation: 3,
};

/**
 * The code and terminal palettes, on what they're drawn on: code on the code
 * background over the canvas; the terminal's colors on the canvas, black and
 * white excepted against their own extreme (black on a dark terminal, white
 * on a light one).
 */
function paletteFailures(
  manifest: Pick<ThemeManifest, "base" | "code" | "terminal">,
  tokens: ThemeTokens,
): ThemeContrastFailure[] {
  const failures: ThemeContrastFailure[] = [];
  const canvas = { ...color(tokens["surface-solid"]), a: 1 };
  const codeBackground = composite(color(tokens["code-background"]), canvas);
  for (const [slot, value] of Object.entries(manifest.code ?? {})) {
    if (value === undefined) continue;
    const min = CODE_RATIOS[slot] ?? 4.5;
    const ratio = contrastRatio(composite(color(value), codeBackground), codeBackground);
    if (ratio < min) {
      failures.push({
        id: `code/${slot}`,
        fg: `code.${slot} (${value})`,
        bg: `--code-background (${formatHex(codeBackground)})`,
        ratio: Math.round(ratio * 100) / 100,
        min,
        source: "code blocks and diffs",
      });
    }
  }
  const skipped = manifest.base === "dark" ? [0, 8] : [7, 15];
  (manifest.terminal ?? []).forEach((value, index) => {
    if (skipped.includes(index)) return;
    // White and bright white on dark, black on light: text; the hues: colored output.
    const min = [7, 15, 0, 8].includes(index) ? 4.5 : 3;
    const ratio = contrastRatio(composite(color(value), canvas), canvas);
    if (ratio < min) {
      failures.push({
        id: `terminal/${index}`,
        fg: `terminal[${index}] (${value})`,
        bg: `--background (${formatHex(canvas)})`,
        ratio: Math.round(ratio * 100) / 100,
        min,
        source: "terminal",
      });
    }
  });
  return failures;
}

/**
 * Every text color the app draws straight onto glass, with the ratio it
 * needs. The backdrop frame raises a zone's tint until all of them pass
 * against the art under it (color.ts minimumGlassTint).
 */
export function glassTextColors(tokens: ThemeTokens): Array<{ color: string; ratio: number }> {
  const names: ThemeTokenName[] = [
    "foreground",
    "card-foreground",
    "sidebar-foreground",
    "sidebar-accent-foreground",
    "muted-foreground",
    "group-muted-foreground",
    "primary-readable",
    "info-foreground",
    "success-foreground",
    "warning-foreground",
    "destructive-foreground",
  ];
  return names.map((name) => ({ color: formatHex({ ...color(tokens[name]), a: 1 }), ratio: 4.5 }));
}
