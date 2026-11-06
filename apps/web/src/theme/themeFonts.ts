/**
 * A theme's fonts by name (docs/design/custom-themes.md, "Fonts"): the
 * family each slot's CSS names, with the app's own faces as the fallback
 * stack. A `system` font names a family the computer already has; embedded
 * faces load from their bytes (themeFontFaces.ts).
 */
import type { ThemeFont, ThemeFonts } from "@threadlines/contracts";
import { cssFontFamilyList } from "@threadlines/shared/themeFontFamilies";

/** index.css's `--font-sans` and `--font-mono`. */
export const DEFAULT_SANS_STACK =
  '"Schibsted Grotesk Variable", "Schibsted Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const DEFAULT_MONO_STACK =
  '"Cascadia Mono Variable", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

export type ThemeFontSlot = "ui" | "mono";

/** The name an embedded font is registered under, unique per theme and slot. */
export function embeddedFontFamily(hash: string | null, slot: ThemeFontSlot): string {
  return `TL Theme ${slot === "ui" ? "UI" : "Mono"} ${(hash ?? "pending").slice(0, 12)}`;
}

function usableFont(font: ThemeFont | undefined): font is ThemeFont {
  if (!font) return false;
  return font.source === "system" || (font.data !== undefined && font.data.length > 0);
}

/**
 * The families the slot's CSS names first, as a CSS list (quoted names,
 * bare generics), or null to keep the app's own.
 */
export function themeFontFamily(
  fonts: ThemeFonts | undefined,
  slot: ThemeFontSlot,
  hash: string | null,
): string | null {
  const font = fonts?.[slot];
  if (!usableFont(font)) return null;
  return font.source === "system"
    ? cssFontFamilyList(font.family)
    : `"${embeddedFontFamily(hash, slot)}"`;
}

/** The full stack for a slot: the theme's family, then the app's own. */
export function themeFontStack(
  fonts: ThemeFonts | undefined,
  slot: ThemeFontSlot,
  hash: string | null,
): string {
  const fallback = slot === "ui" ? DEFAULT_SANS_STACK : DEFAULT_MONO_STACK;
  const family = themeFontFamily(fonts, slot, hash);
  return family ? `${family}, ${fallback}` : fallback;
}
