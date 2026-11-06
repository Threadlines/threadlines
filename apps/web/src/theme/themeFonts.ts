/**
 * A theme's fonts (docs/design/custom-themes.md, "Fonts"). Embedded fonts
 * load from their bytes with `FontFace`, never from the network; a `system`
 * font names a family the computer already has. The app's own faces stay as
 * the fallback stack behind either.
 */
import type { ThemeFont, ThemeFonts } from "@threadlines/contracts";

/** index.css's `--font-sans` and `--font-mono`. */
export const DEFAULT_SANS_STACK =
  '"Schibsted Grotesk Variable", "Schibsted Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const DEFAULT_MONO_STACK =
  '"Cascadia Mono Variable", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

export type ThemeFontSlot = "ui" | "mono";

/** A family name as it may appear quoted in CSS: no quotes, escapes or rule breakers. */
export function cleanFontFamily(family: string): string {
  return family
    .replace(/["'\\;{}<>]/g, "")
    .trim()
    .slice(0, 80);
}

/** The name an embedded font is registered under, unique per theme and slot. */
export function embeddedFontFamily(hash: string | null, slot: ThemeFontSlot): string {
  return `TL Theme ${slot === "ui" ? "UI" : "Mono"} ${(hash ?? "pending").slice(0, 12)}`;
}

/** The CSS weight an embedded face covers: a variable font's range, or its one weight. */
function faceWeight(font: ThemeFont): string | null {
  if (font.weights) {
    const { min, max } = font.weights;
    return `${Math.min(min, max)} ${Math.max(min, max)}`;
  }
  return font.weight ? String(font.weight) : null;
}

function usableFont(font: ThemeFont | undefined): font is ThemeFont {
  if (!font) return false;
  return font.source === "system" || (font.data !== undefined && font.data.length > 0);
}

/** The family the slot's CSS names first, or null to keep the app's own. */
export function themeFontFamily(
  fonts: ThemeFonts | undefined,
  slot: ThemeFontSlot,
  hash: string | null,
): string | null {
  const font = fonts?.[slot];
  if (!usableFont(font)) return null;
  return font.source === "system" ? cleanFontFamily(font.family) : embeddedFontFamily(hash, slot);
}

/** The full stack for a slot: the theme's family, then the app's own. */
export function themeFontStack(
  fonts: ThemeFonts | undefined,
  slot: ThemeFontSlot,
  hash: string | null,
): string {
  const fallback = slot === "ui" ? DEFAULT_SANS_STACK : DEFAULT_MONO_STACK;
  const family = themeFontFamily(fonts, slot, hash);
  return family ? `"${family}", ${fallback}` : fallback;
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

const loadedFaces = new Map<string, Promise<boolean>>();

/**
 * Registers a theme's embedded fonts with the document and waits for them.
 * Resolves true when a face loaded (callers refit what measures text, such as
 * the terminal). Idempotent per family.
 */
export function loadThemeFonts(
  fonts: ThemeFonts | undefined,
  hash: string | null,
): Promise<boolean> {
  if (typeof document === "undefined" || typeof FontFace === "undefined" || !document.fonts) {
    return Promise.resolve(false);
  }
  const loads: Promise<boolean>[] = [];
  for (const slot of ["ui", "mono"] as const) {
    const font = fonts?.[slot];
    if (!font || font.source === "system" || !font.data) continue;
    const family = embeddedFontFamily(hash, slot);
    let load = loadedFaces.get(family);
    if (!load) {
      const bytes = decodeBase64(font.data);
      load = bytes
        ? (async () => {
            try {
              const weight = faceWeight(font);
              const face = new FontFace(family, bytes, {
                ...(weight ? { weight } : {}),
                display: "swap",
              });
              await face.load();
              document.fonts.add(face);
              return true;
            } catch {
              return false;
            }
          })()
        : Promise.resolve(false);
      loadedFaces.set(family, load);
    }
    loads.push(load);
  }
  if (loads.length === 0) return Promise.resolve(false);
  return Promise.all(loads).then((results) => results.some(Boolean));
}

/**
 * `@font-face` rules carrying a theme's embedded fonts as data URLs, for
 * documents that can't share the app's faces (agent pages, whose policy
 * allows `font-src data:`).
 */
export function themeFontFaceCss(fonts: ThemeFonts | undefined, hash: string | null): string {
  const rules: string[] = [];
  for (const slot of ["ui", "mono"] as const) {
    const font = fonts?.[slot];
    if (!font || font.source === "system" || !font.data || !/^[A-Za-z0-9+/=]+$/.test(font.data)) {
      continue;
    }
    const weight = faceWeight(font);
    rules.push(
      `@font-face{font-family:"${embeddedFontFamily(hash, slot)}";src:url(data:font/woff2;base64,${font.data}) format("woff2");${weight ? `font-weight:${weight};` : ""}font-display:swap;}`,
    );
  }
  return rules.join("");
}
