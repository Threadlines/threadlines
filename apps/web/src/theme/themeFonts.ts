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

/** Each embedded font's id, by its data and weights: hashed once, however many themes carry it. */
const fingerprints = new Map<string, string>();
/** Which font each id was given to, so two fonts that hash alike still get two names. */
const owners = new Map<string, string>();

/** cyrb53: a fast 53-bit string hash, as hex. */
function hash53(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(16).padStart(14, "0");
}

/** A font's id: faces that would draw alike share it; different ones never do. */
function fontFingerprint(font: ThemeFont): string {
  const key = `${font.weight ?? ""}/${font.weights?.min ?? ""}-${font.weights?.max ?? ""}/${font.data ?? ""}`;
  let known = fingerprints.get(key);
  if (known === undefined) {
    known = hash53(key);
    while (owners.has(known) && owners.get(known) !== key) known = `${known}x`;
    owners.set(known, key);
    fingerprints.set(key, known);
  }
  return known;
}

/**
 * The name an embedded font is registered under. By the font's own bytes when
 * given, so themes that differ only in color (each preview of the color
 * editor) share one face instead of registering it again; else by theme.
 */
export function embeddedFontFamily(
  hash: string | null,
  slot: ThemeFontSlot,
  font?: ThemeFont,
): string {
  const id = font?.data ? fontFingerprint(font) : (hash ?? "pending").slice(0, 12);
  return `TL Theme ${slot === "ui" ? "UI" : "Mono"} ${id}`;
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
    : `"${embeddedFontFamily(hash, slot, font)}"`;
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
