/**
 * Making a theme readable (docs/design/custom-themes.md, "Readability
 * check"): `fitThemeColors` moves every color that fails the check, hue kept,
 * until it passes, for themes brought in from VS Code and the color editor's
 * Fix. `themeTokenSeed` says which of a theme's own colors each app color
 * comes from, for the editor's inspector.
 */
import type {
  ThemeBase,
  ThemeCodePalette,
  ThemeManifest,
  ThemeSeedColors,
} from "@threadlines/contracts";

import {
  color,
  composite,
  contrastRatio,
  ensureContrast,
  formatHex,
  type Rgba,
  shiftLightness,
} from "./color.ts";
import { contrastPairSurface, THEME_CONTRAST_PAIRS, themeContrastFailures } from "./contrast.ts";
import { checkThemeManifest } from "./manifest.ts";
import type { ThemeTokenName } from "./tokenNames.ts";
import { resolveThemeTokens } from "./tokens.ts";

export type ThemeFit =
  | {
      readonly ok: true;
      readonly manifest: ThemeManifest;
      /** How many colors were moved to pass the readability check. */
      readonly adjusted: number;
    }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/**
 * Which of a theme's own colors each app color comes from in a light theme
 * (tokens.ts deriveThemeTokens); `themeTokenSeed` has the dark ones. A status
 * color with no seed of its own comes from the app's; `border` without one
 * from the text.
 */
const LIGHT_TOKEN_SEEDS: Readonly<Record<ThemeTokenName, keyof ThemeSeedColors>> = {
  background: "background",
  "app-chrome-background": "background",
  frame: "background",
  card: "background",
  rail: "background",
  sidebar: "background",
  popover: "background",
  control: "background",
  "control-hover": "background",
  "control-pressed": "background",
  field: "background",
  "surface-solid": "background",
  foreground: "foreground",
  "card-foreground": "foreground",
  "agent-line": "foreground",
  "sidebar-foreground": "foreground",
  "sidebar-accent": "foreground",
  "sidebar-accent-foreground": "foreground",
  "popover-foreground": "foreground",
  secondary: "foreground",
  "secondary-foreground": "foreground",
  muted: "foreground",
  accent: "foreground",
  "accent-foreground": "foreground",
  "pick-selected": "foreground",
  "control-active": "foreground",
  group: "foreground",
  "group-ring": "foreground",
  "group-divider": "foreground",
  "switch-off": "foreground",
  "segmented-track": "foreground",
  input: "foreground",
  "focus-ring": "foreground",
  "muted-foreground": "mutedForeground",
  "group-muted-foreground": "mutedForeground",
  placeholder: "mutedForeground",
  "app-accent-blue": "accent",
  primary: "accent",
  "primary-hover": "accent",
  "primary-readable": "accent",
  "primary-graph": "accent",
  ring: "accent",
  "primary-foreground": "accentForeground",
  border: "border",
  "sidebar-border": "border",
  destructive: "danger",
  "destructive-foreground": "danger",
  info: "info",
  "info-foreground": "info",
  success: "success",
  "success-foreground": "success",
  warning: "warning",
  "warning-foreground": "warning",
  "text-selection": "selection",
  "code-background": "codeBackground",
};

/** Where a dark theme differs: its controls are washes of the text, its fields a fixed shade. */
const DARK_TOKEN_SEEDS: Partial<Record<ThemeTokenName, keyof ThemeSeedColors | null>> = {
  control: "foreground",
  "control-hover": "foreground",
  "control-pressed": "foreground",
  field: null,
  "segmented-track": null,
};

/** The theme color an app color comes from; null for one every theme of that kind shares. */
export function themeTokenSeed(
  name: ThemeTokenName,
  base: ThemeBase,
): keyof ThemeSeedColors | null {
  if (base === "dark" && name in DARK_TOKEN_SEEDS) return DARK_TOKEN_SEEDS[name] ?? null;
  return LIGHT_TOKEN_SEEDS[name];
}

/** What the fit may change, by where it lives in the theme file. */
type Slot =
  | { readonly kind: "seed"; readonly key: keyof ThemeSeedColors }
  | { readonly kind: "override"; readonly key: string }
  | { readonly kind: "code"; readonly key: keyof ThemeCodePalette }
  | { readonly kind: "terminal"; readonly index: number };

/** The seed a status pair's colors come from, by the pair's id. */
const STATUS_SEEDS: ReadonlyArray<readonly [RegExp, keyof ThemeSeedColors]> = [
  [/success/, "success"],
  [/warning/, "warning"],
  [/destructive|error/, "danger"],
  [/info/, "info"],
];

/** A little over the ratio asked, so rounding never lands just under it. */
const MARGIN = 0.1;
const MAX_ROUNDS = 24;

function slotValue(manifest: ThemeManifest, slot: Slot): string | undefined {
  switch (slot.kind) {
    case "seed":
      return manifest.colors[slot.key];
    case "override":
      return manifest.overrides?.[slot.key];
    case "code":
      return manifest.code?.[slot.key];
    case "terminal":
      return manifest.terminal?.[slot.index];
  }
}

function withSlot(manifest: ThemeManifest, slot: Slot, value: string | undefined): ThemeManifest {
  switch (slot.kind) {
    case "seed": {
      const colors: Record<string, string | undefined> = { ...manifest.colors, [slot.key]: value };
      if (value === undefined) delete colors[slot.key];
      return { ...manifest, colors: colors as ThemeSeedColors };
    }
    case "override": {
      const overrides: Record<string, string> = { ...manifest.overrides };
      if (value === undefined) delete overrides[slot.key];
      else overrides[slot.key] = value;
      const { overrides: _overrides, ...rest } = manifest;
      return Object.keys(overrides).length === 0 ? rest : { ...rest, overrides };
    }
    case "code":
      return { ...manifest, code: { ...manifest.code, [slot.key]: value } };
    case "terminal": {
      const terminal = [...(manifest.terminal ?? [])];
      terminal[slot.index] = value!;
      return { ...manifest, terminal };
    }
  }
}

/**
 * The theme with every color that fails the readability check moved until it
 * passes: a text color lighter or darker on what it sits on, hue kept; a
 * seed the app derives safely (a status color, the side bar, the selection)
 * dropped so the derived one is used. Fails when a round changes nothing.
 */
export function fitThemeColors(start: ThemeManifest): ThemeFit {
  let manifest = start;
  const touched: Slot[] = [];
  const touch = (slot: Slot, value: string | undefined) => {
    if (!touched.some((item) => JSON.stringify(item) === JSON.stringify(slot))) touched.push(slot);
    manifest = withSlot(manifest, slot, value);
  };
  const seedStep = (key: keyof ThemeSeedColors, surface: Rgba, min: number) => {
    const current = manifest.colors[key];
    if (current === undefined) return false;
    const next = formatHex(ensureContrast(color(current), surface, min + MARGIN));
    if (next === current) return false;
    touch({ kind: "seed", key }, next);
    return true;
  };
  const drop = (slot: Slot) => {
    if (slotValue(manifest, slot) === undefined) return false;
    touch(slot, undefined);
    return true;
  };
  /**
   * Text on the accent must read on it and on its hover shade. The theme's own
   * ink first, then white or black; when neither reads on both, the accent
   * moves a step toward the one that reads better.
   */
  const fitAccentInk = () => {
    // The ink the theme sets directly, when it does, is the one to move.
    const slot: Slot =
      manifest.overrides?.["primary-foreground"] !== undefined
        ? { kind: "override", key: "primary-foreground" }
        : { kind: "seed", key: "accentForeground" };
    const current = slotValue(manifest, slot)!;
    const passes = (ink: string) => {
      const tokens = resolveThemeTokens(withSlot(manifest, slot, ink));
      return ["primary", "primary-hover"].every(
        (name) => contrastRatio(color(ink), color(tokens[name as "primary"])) >= 4.5 + MARGIN / 2,
      );
    };
    const ink = [current, "#ffffff", "#000000"].find(passes);
    if (ink !== undefined) {
      if (ink === current) return false;
      touch(slot, ink);
      return true;
    }
    const accent = color(manifest.colors.accent);
    const towardLight =
      contrastRatio(color("#000000"), accent) >= contrastRatio(color("#ffffff"), accent);
    touch(
      { kind: "seed", key: "accent" },
      formatHex(shiftLightness(accent, towardLight ? 0.03 : -0.03)),
    );
    return true;
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const failures = themeContrastFailures(manifest);
    if (failures.length === 0) break;
    const tokens = resolveThemeTokens(manifest);
    const canvas = { ...color(tokens["surface-solid"]), a: 1 };
    let changed = false;
    for (const failure of failures) {
      const code = /^code\/(.+)$/.exec(failure.id);
      const terminal = /^terminal\/(\d+)$/.exec(failure.id);
      if (code !== null) {
        const key = code[1] as keyof ThemeCodePalette;
        const surface = composite(color(tokens["code-background"]), canvas);
        const next = formatHex(
          ensureContrast(color(manifest.code![key]!), surface, failure.min + MARGIN),
        );
        touch({ kind: "code", key }, next);
        changed = true;
        continue;
      }
      if (terminal !== null) {
        const index = Number(terminal[1]);
        const next = formatHex(
          ensureContrast(color(manifest.terminal![index]!), canvas, failure.min + MARGIN),
        );
        touch({ kind: "terminal", index }, next);
        changed = true;
        continue;
      }
      const pair = THEME_CONTRAST_PAIRS.find((item) => item.id === failure.id);
      if (pair === undefined) continue;
      const surface = contrastPairSurface(tokens, pair, manifest.base);
      const overridden = pair.fg === "white" ? undefined : manifest.overrides?.[pair.fg];
      const status = STATUS_SEEDS.find(([pattern]) => pattern.test(pair.id));
      // A status or accent ink the theme sets directly is moved below, not through its seed.
      if (status !== undefined && overridden === undefined) {
        const [, key] = status;
        // The app's own shade of a status color reads on most surfaces; the theme's may not.
        if (drop({ kind: "seed", key })) {
          changed = true;
        } else if (key === "info" && manifest.colors.info === undefined) {
          if (seedStep("accent", surface, failure.min)) changed = true;
        } else {
          // Not even the app's shade does here: a seed that reads on this surface, from it.
          const shade = color(tokens[pair.fg === "white" ? "destructive" : pair.fg]);
          const next = formatHex(ensureContrast(shade, surface, failure.min + MARGIN));
          if (next !== manifest.colors[key]) {
            touch({ kind: "seed", key }, next);
            changed = true;
          }
        }
        continue;
      }
      if (pair.id.startsWith("on-primary")) {
        if (fitAccentInk()) changed = true;
        continue;
      }
      if (pair.id === "selection" && drop({ kind: "seed", key: "selection" })) {
        changed = true;
        continue;
      }
      if (
        (pair.id === "foreground/sidebar" || pair.id === "selected-row") &&
        drop({ kind: "override", key: "sidebar" })
      ) {
        changed = true;
        continue;
      }
      if (
        /^(border|input|switch-off|focus-ring)$/.test(pair.id) &&
        drop({ kind: "seed", key: "border" })
      ) {
        changed = true;
        continue;
      }
      // A text color the theme sets directly wins over the seed: it's the one to move, once the
      // colors the app can make safely itself (the selection, the side bar) are dropped.
      if (overridden !== undefined) {
        const next = formatHex(ensureContrast(color(overridden), surface, failure.min + MARGIN));
        if (next !== overridden) {
          touch({ kind: "override", key: pair.fg }, next);
          changed = true;
          continue;
        }
      }
      const key: keyof ThemeSeedColors | null = /^(muted|group-muted|placeholder)/.test(pair.id)
        ? "mutedForeground"
        : pair.id.startsWith("on-primary")
          ? "accentForeground"
          : /^(primary-readable|accent-mark)/.test(pair.id)
            ? "accent"
            : pair.fg === "foreground" ||
                pair.fg === "card-foreground" ||
                pair.fg === "popover-foreground" ||
                pair.fg === "sidebar-foreground" ||
                pair.fg === "sidebar-accent-foreground" ||
                pair.fg === "secondary-foreground" ||
                pair.fg === "accent-foreground"
              ? "foreground"
              : null;
      if (key !== null && seedStep(key, surface, failure.min)) changed = true;
    }
    if (!changed) break;
  }

  const check = checkThemeManifest(manifest);
  if (!check.ok) return { ok: false, errors: check.errors };
  const adjusted = touched.filter((slot) => slotValue(start, slot) !== slotValue(manifest, slot));
  return { ok: true, manifest: check.manifest, adjusted: adjusted.length };
}
