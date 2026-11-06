/**
 * Embedding a theme's fonts (docs/design/custom-themes.md, "What a theme
 * is"). An agent names a family from Google Fonts or Bunny Fonts; the server
 * downloads its latin woff2 once, when the theme is first saved or shown, and
 * puts the bytes in the file, so a theme never fetches anything when it is
 * used. Only the fonts hosts are ever asked, on every hop.
 */
import {
  THEME_MAX_FONT_BYTES,
  ThemeError,
  type ThemeFont,
  type ThemeManifest,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";

const isThemeError = Schema.is(ThemeError);

/** Every host a font download may reach, redirects included. */
export const THEME_FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "fonts.bunny.net"];

const FONT_TIMEOUT_MS = 10_000;
const CSS_MAX_BYTES = 256 * 1024;
// Google Fonts picks the font format by browser; this one gets woff2.
const WOFF2_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FAMILY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,79}$/;
const HOST_LABEL = { google: "Google Fonts", bunny: "Bunny Fonts" } as const;

type HostedSource = keyof typeof HOST_LABEL;

/** Google Fonts' stylesheet that names a family's files at the given weights. */
export function googleFontCssUrl(family: string, weights: ReadonlyArray<number>): string {
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replaceAll("%20", "+")}:wght@${weights.join(";")}&display=swap`;
}

/**
 * Bunny Fonts' latin woff2 for a family at one weight. Its stylesheets now
 * point at another CDN, so the file is asked for on Bunny's own host, where
 * it lives under this path.
 */
export function bunnyFontFileUrl(family: string, weight: number): string {
  const slug = family.toLowerCase().replaceAll(" ", "-");
  return `https://fonts.bunny.net/${slug}/files/${slug}-latin-${weight}-normal.woff2`;
}

/**
 * The latin subset's woff2 files in a font stylesheet, one per `@font-face`
 * block marked `/* latin *\/` (one per weight asked for), or the only block
 * when the host marks none. Empty when there is none, or when any points
 * anywhere but the fonts hosts.
 */
export function latinWoff2Urls(css: string): Array<string> {
  const blocks = Array.from(
    css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g),
    (match) => ({ subset: match[1], body: match[2] ?? "" }),
  );
  const latin = blocks.filter((entry) => entry.subset === "latin");
  const chosen =
    latin.length > 0 ? latin : blocks.length === 1 && blocks[0]?.subset === undefined ? blocks : [];
  const urls: Array<string> = [];
  for (const block of chosen) {
    const url = block.body.match(/url\(\s*['"]?(https:\/\/[^'")\s]+\.woff2)['"]?\s*\)/)?.[1];
    if (url === undefined || !THEME_FONT_HOSTS.includes(new URL(url).hostname)) return [];
    urls.push(url);
  }
  return urls;
}

const fontError = (font: ThemeFont, reason: string) =>
  new ThemeError({
    detail: `Couldn't get the font "${font.family}" from ${HOST_LABEL[font.source as HostedSource] ?? font.source}: ${reason}. Check the family name and weight, or use a font the computer already has: { "family": "ui-monospace, Menlo, monospace", "source": "system" } (or "system-ui, sans-serif" for text).`,
  });

/** Reads a response body, refusing one larger than `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const isWoff2 = (bytes: Uint8Array) =>
  bytes.length > 4 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === "wOF2";

/** A downloaded font: its latin woff2, base64, and its weight range when it's variable. */
export interface ThemeFontFile {
  readonly data: string;
  readonly weights?: { readonly min: number; readonly max: number };
}

/** The weights a variable font is asked for: the app's regular and bold, and the theme's own. */
const spreadWeights = (weight: number) =>
  [...new Set([400, weight, 700])].toSorted((first, second) => first - second);

/**
 * Downloads one hosted font's latin woff2. From Google, a variable family
 * answers several weights with one file, which then carries them all; any
 * other family comes at its one weight.
 */
const downloadFont = (fetch: DownloadFetch, font: ThemeFont & { source: HostedSource }) =>
  Effect.tryPromise({
    try: async (signal): Promise<ThemeFontFile> => {
      const timeout = AbortSignal.timeout(FONT_TIMEOUT_MS);
      const init = {
        headers: { "User-Agent": WOFF2_USER_AGENT, Accept: "text/css,*/*;q=0.1" },
        signal: AbortSignal.any([signal, timeout]),
      };
      const weight = font.weight ?? 400;
      const listedFiles = async (weights: ReadonlyArray<number>) => {
        const cssResponse = await fetch(googleFontCssUrl(font.family, weights), init);
        if (!cssResponse.ok) return { status: cssResponse.status, urls: [] };
        const cssBytes = await readCapped(cssResponse, CSS_MAX_BYTES);
        const urls = cssBytes === null ? [] : latinWoff2Urls(new TextDecoder().decode(cssBytes));
        return { status: cssResponse.status, urls };
      };
      const download = async (url: string) => {
        const fileResponse = await fetch(url, init);
        if (!fileResponse.ok) {
          throw fontError(
            font,
            fileResponse.status === 404
              ? `it has no such family at weight ${weight}`
              : `the font file answered ${fileResponse.status}`,
          );
        }
        const bytes = await readCapped(fileResponse, THEME_MAX_FONT_BYTES);
        if (bytes === null) {
          throw fontError(font, `the font is larger than ${THEME_MAX_FONT_BYTES / 1024} KB`);
        }
        if (!isWoff2(bytes))
          throw fontError(font, "the host sent something that isn't a woff2 font");
        return Buffer.from(bytes).toString("base64");
      };

      if (font.source === "bunny")
        return { data: await download(bunnyFontFileUrl(font.family, weight)) };
      const spread = spreadWeights(weight);
      const variable = await listedFiles(spread);
      const first = variable.urls[0];
      if (
        first !== undefined &&
        variable.urls.length === spread.length &&
        variable.urls.every((url) => url === first)
      ) {
        return {
          data: await download(first),
          weights: { min: spread[0] ?? weight, max: spread.at(-1) ?? weight },
        };
      }
      const single = await listedFiles([weight]);
      if (single.status !== 200) {
        throw fontError(
          font,
          single.status === 400 || single.status === 404
            ? `it has no such family at weight ${weight}`
            : `the font host answered ${single.status}`,
        );
      }
      const url = single.urls[0];
      if (url === undefined) throw fontError(font, "the host lists no latin woff2 file for it");
      return { data: await download(url) };
    },
    catch: (cause) =>
      isThemeError(cause)
        ? cause
        : fontError(
            font,
            cause instanceof Error && cause.name === "TimeoutError"
              ? `it took longer than ${FONT_TIMEOUT_MS / 1000} seconds`
              : cause instanceof Error
                ? cause.message
                : String(cause),
          ),
  });

/** Downloaded fonts by source, family and weight, so previews don't fetch the same file again. */
export interface ThemeFontCache {
  readonly get: (key: string) => ThemeFontFile | undefined;
  readonly set: (key: string, file: ThemeFontFile) => void;
}

/** A small cache that keeps the last `size` fonts. */
export function makeThemeFontCache(size = 12): ThemeFontCache {
  const entries = new Map<string, ThemeFontFile>();
  return {
    get: (key) => entries.get(key),
    set: (key, file) => {
      entries.delete(key);
      entries.set(key, file);
      while (entries.size > size) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

const isHosted = (font: ThemeFont): font is ThemeFont & { source: HostedSource } =>
  font.source === "google" || font.source === "bunny";

/**
 * The manifest with every hosted font it names downloaded and embedded
 * (`data`). Fonts that already carry data, and system fonts, are left as
 * they are. Fails with a ThemeError that suggests a system font.
 */
export const embedThemeFonts = Effect.fn("themeFonts.embed")(function* (input: {
  readonly manifest: ThemeManifest;
  readonly fetch: DownloadFetch;
  readonly cache?: ThemeFontCache | undefined;
}) {
  const { manifest } = input;
  const fonts = manifest.fonts;
  if (fonts === undefined) return manifest;
  const embed = (font: ThemeFont | undefined) =>
    Effect.gen(function* () {
      if (font === undefined || font.data !== undefined || !isHosted(font)) return font;
      if (!FAMILY_NAME.test(font.family)) {
        return yield* fontError(
          font,
          'name one family, in letters, digits and spaces (like "IBM Plex Mono")',
        );
      }
      const key = `${font.source}:${font.family.toLowerCase()}:${font.weight ?? 400}`;
      const cached = input.cache?.get(key);
      const file = cached ?? (yield* downloadFont(input.fetch, font));
      if (cached === undefined) input.cache?.set(key, file);
      return { ...font, ...file };
    });
  const [ui, mono] = yield* Effect.all([embed(fonts.ui), embed(fonts.mono)], {
    concurrency: 2,
  });
  return {
    ...manifest,
    fonts: { ...(ui !== undefined ? { ui } : {}), ...(mono !== undefined ? { mono } : {}) },
  };
});
