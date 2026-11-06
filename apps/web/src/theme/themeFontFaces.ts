/**
 * A theme's embedded fonts (docs/design/custom-themes.md, "Fonts"): loaded
 * from their bytes with `FontFace`, never from the network. Its own chunk,
 * fetched when a theme with embedded fonts is shown.
 */
import type { ThemeFont, ThemeFonts } from "@threadlines/contracts";

import { embeddedFontFamily } from "./themeFonts";

/** The CSS weight an embedded face covers: a variable font's range, or its one weight. */
function faceWeight(font: ThemeFont): string | null {
  if (font.weights) {
    const { min, max } = font.weights;
    return `${Math.min(min, max)} ${Math.max(min, max)}`;
  }
  return font.weight ? String(font.weight) : null;
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
