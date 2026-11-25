/**
 * The themes the homepage's hero window offers (docs/design/design-language.md,
 * "Marketing site"), resolved at build time with the app's own theme code.
 *
 * - The homepage inlines each theme's colors (`heroThemeCss`), so switching
 *   needs no request.
 * - Each theme with art gets a static JSON (`heroArtPayload`, served by
 *   pages/hero/themes/[id].json.ts): the frame's `init` message as the app's
 *   backdrop host builds it, the zone tints at the hero's Glass level, and
 *   where its fonts live. The browser fetches it only when the art starts.
 * - Embedded fonts are served as their unmodified WOFF2 bytes
 *   (pages/hero/fonts/[file].ts); the font's own name table carries its
 *   license notice.
 *
 * Showcase files are kept byte for byte as published in Threadlines/themes;
 * a file that changed, or one the app would reject, fails the build.
 */
import { createHash } from "node:crypto";

import type { ThemeBase, ThemeFont, ThemeManifest } from "@threadlines/contracts";
import { BUILTIN_THEME_TOKENS } from "@threadlines/shared/themeBuiltinTokens";
import { composite, formatHex, parseColor } from "@threadlines/shared/themeColor";
import { glassTextColors } from "@threadlines/shared/themeContrast";
import { cssFontFamilyList } from "@threadlines/shared/themeFontFamilies";
import { glassClarity, glassFloors, glassTextRatio } from "@threadlines/shared/themeGlassFloors";
import { checkThemeManifest } from "@threadlines/shared/themeManifest";
import { STARTER_THEMES } from "@threadlines/shared/themeStarters";
import { resolveThemeTokens } from "@threadlines/shared/themeTokens";
import type { ThemeTokenName, ThemeTokens } from "@threadlines/shared/themeTokenNames";

import meadowThumbnail from "../../../web/public/themes/meadow.png?inline";
import tokyoRainThumbnail from "../../../web/public/themes/tokyo-rain.png?inline";
import honuLagoonFile from "../themes/honu-lagoon.threadlines-theme?raw";
import nexusMinimalFile from "../themes/showcase/nexus-minimal.threadlines-theme?raw";
import obsidianCubeFile from "../themes/showcase/obsidian-cube.threadlines-theme?raw";
import sommarstugaFile from "../themes/showcase/sommarstuga.threadlines-theme?raw";

/**
 * Where the hero sets the app's Glass slider: 50 is the theme's own glass,
 * 100 is Clear. 80 shows most of the art and still keeps text over it at 3:1.
 */
export const HERO_GLASS_LEVEL = 80;

/** The frame document, served as one static file. */
export const HERO_FRAME_PATH = "/hero/backdrop-frame.html";

/** Showcase files and the SHA-256 of each as published in Threadlines/themes (its showcase index). */
export const SHOWCASE_FILE_SHA256 = {
  "nexus-minimal": "cbcb29f0f379dc0b9495e2f0ca817aee7298a9dc21943100322a2d5985b3bd9a",
  "obsidian-cube": "33cbfd626472605f3ade138fa7eae62e0793b230463faaa0b13b4dde5065de5b",
  sommarstuga: "650046ce858d8b1d179c35bb49d0f6027df3a9ae8dc7a798610ce6cab760162f",
} as const;
type ShowcaseId = keyof typeof SHOWCASE_FILE_SHA256;

const SHOWCASE_FILES: Record<ShowcaseId, string> = {
  "nexus-minimal": nexusMinimalFile,
  "obsidian-cube": obsidianCubeFile,
  sommarstuga: sommarstugaFile,
};

const SHOWCASE_FOLDER = "https://github.com/Threadlines/themes/tree/main/themes/";

/**
 * The words around the theme strip, for the copy pass, all in this block:
 *
 * - HERO_THEME_INTRO: the heading-weight line and the sentence beside the
 *   strip, and the caption saying what the window is.
 * - Each theme's `about`: one line on what it is, shown with its name and
 *   credit when picked. Left out, the theme file's own `prompt` is used (its
 *   first sentence, without a leading "<name>:").
 * - Each theme's `ask`: the draft typed in the window's message box while it
 *   is picked; `null` shows the box's normal placeholder.
 * - Credits: `credit` for a theme from outside the Showcase and the starters;
 *   the others say where they come from (`resolve` below).
 * - `glass`: this theme's Glass level, when 80 makes its text hard to read.
 * - `thumb`: where its tile in the theme strip looks, when the whole art is
 *   too sparse to read at tile size.
 * - HERO_YOURS_ASKS: what the "Yours" tile in the theme strip types into the
 *   window's message box, a different one each click.
 */
export const HERO_THEME_INTRO = {
  title: "Describe any theme. Your agent builds\u00A0it.",
  text: "It writes the colors, fonts and live art you ask for, so the themes above are only a start.",
  caption: "A simplified drawing of the app, running real themes.",
} as const;

/** Typed into the window's message box by the strip's "Yours" tile, in turn. */
export const HERO_YOURS_ASKS: ReadonlyArray<string> = [
  "Make me a theme: a lighthouse in a storm, in pixel art.",
  "Make me a theme: a quiet library at night with one lamp on.",
  "Make me a theme: deep space with slow-drifting stars, in ASCII.",
  "Make me a theme: a rainy window in a mountain cabin.",
  "Make me a theme: a koi pond seen from above.",
];

/** The message box's placeholder when no draft is typed, as the app shows it. */
export const HERO_COMPOSER_PLACEHOLDER = "Message Opus 5.5 · @ agents or files, / commands";

interface HeroThemeCopy {
  readonly about?: string;
  readonly ask: string | null;
  readonly glass?: number;
  /** Where its strip tile looks in the art: zoomed in this much, centred here (0..1 across and down). */
  readonly thumb?: HeroThumbFocus;
}

/** A tile that shows the whole art. */
const WHOLE_ART: HeroThumbFocus = { zoom: 1, x: 0.5, y: 0.5 };

export interface HeroThumbFocus {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

type HeroThemeSource =
  | ({ readonly kind: "default"; readonly id: "default"; readonly about: string } & HeroThemeCopy)
  | ({ readonly kind: "starter"; readonly id: string } & HeroThemeCopy)
  | ({ readonly kind: "showcase"; readonly id: ShowcaseId } & HeroThemeCopy)
  | ({
      readonly kind: "file";
      readonly id: string;
      readonly file: string;
      readonly credit: HeroThemeCredit;
    } & HeroThemeCopy);

export interface HeroThemeCredit {
  readonly text: string;
  readonly href?: string;
}

/** In the order the row shows them. */
const SOURCES: ReadonlyArray<HeroThemeSource> = [
  {
    kind: "file",
    id: "honu-lagoon",
    file: honuLagoonFile,
    credit: { text: "after @handsher_NGU", href: "https://x.com/handsher_NGU" },
    about:
      "A sunlit Hawaiian lagoon drawn in ASCII characters, with sea turtles, reef fish and floating flowers.",
    ask: "Make me a theme: a turquoise Hawaiian lagoon in ASCII with sea turtles.",
  },
  {
    kind: "showcase",
    id: "sommarstuga",
    about:
      "A pixel-art cabin with a lit window on a lake at dusk, spruce and mountains mirrored in the water.",
    ask: "Make me a theme: pixel art of a red Swedish cabin by a lake at dusk.",
  },
  {
    kind: "starter",
    id: "tokyo-rain",
    about:
      "A rainy Tokyo alley at night, with glowing Japanese signs on both sides and reflections on the wet street.",
    ask: "Make me a theme: a rainy Tokyo alley at night with neon signs.",
  },
  {
    kind: "showcase",
    id: "nexus-minimal",
    thumb: { zoom: 2, x: 0.17, y: 0.33 },
    about: "A dark square grid with red, blue, green and yellow pulses streaking along the lines.",
    ask: "Make me a theme: a dark grid with colored light streaks along the lines.",
  },
  {
    kind: "showcase",
    id: "obsidian-cube",
    thumb: { zoom: 3, x: 0.87, y: 0.55 },
    about:
      "A dark 3x3 puzzle cube with colored tiles that twists and solves itself in the background.",
    ask: "Make me a theme: a black 3x3 puzzle cube slowly twisting in the dark.",
  },
  {
    kind: "starter",
    id: "meadow",
    about:
      "Sunlit hills with a lone tree, drifting clouds, swaying grass and floating dandelion seeds.",
    ask: "Make me a theme: a sunny green meadow with clouds drifting over the hills.",
  },
  {
    kind: "default",
    id: "default",
    about: "The built-in look, light or dark to match this page.",
    ask: null,
  },
];

/** The theme each scheme opens in until the visitor picks one. */
export const HERO_FIRST_THEME: Readonly<Record<ThemeBase, string>> = {
  light: "honu-lagoon",
  dark: "sommarstuga",
};

/** The tokens the window paints with. */
const WINDOW_TOKENS = [
  "background",
  "foreground",
  "frame",
  "rail",
  "card",
  "card-foreground",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "secondary",
  "secondary-foreground",
  "muted-foreground",
  "primary",
  "primary-foreground",
  "primary-readable",
  "border",
  "placeholder",
  "control",
  "success-foreground",
  "warning-foreground",
  "info-foreground",
  "destructive",
  "surface-solid",
] as const satisfies ReadonlyArray<ThemeTokenName>;

const SANS_FALLBACK = `var(--font-sans)`;
// System monospace until a theme's own font loads, so the opening screen fetches no mono font.
const MONO_FALLBACK = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

export interface HeroThemeFont {
  /** The family name the page registers the font under. */
  readonly family: string;
  readonly url: string;
  /** A FontFace weight descriptor: "400", or "400 700" for a variable font. */
  readonly weight: string;
}

export interface HeroTheme {
  readonly id: string;
  readonly name: string;
  /** Null for Default, which follows the page's light or dark. */
  readonly base: ThemeBase | null;
  readonly credit: HeroThemeCredit;
  readonly about: string;
  /** The draft in the message box, or null for its normal placeholder. */
  readonly ask: string | null;
  /** The Glass level the window shows this theme at. */
  readonly glassLevel: number;
  /** Where its strip tile looks in the art. */
  readonly thumb: HeroThumbFocus;
  /** The color that rings its tile when picked; Default has one for light and one for dark. */
  readonly accent: string | { readonly light: string; readonly dark: string };
  readonly hasArt: boolean;
  /** Present for themes with art and their manifests; never for Default. */
  readonly manifest: ThemeManifest | null;
  readonly tokens: ThemeTokens;
  readonly fonts: { readonly ui?: HeroThemeFont; readonly mono?: HeroThemeFont };
  readonly fontStacks: { readonly ui: string; readonly mono: string };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function decode(id: string, json: string): ThemeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`The hero theme "${id}" isn't valid JSON.`, { cause: error });
  }
  const check = checkThemeManifest(parsed);
  if (!check.ok) {
    throw new Error(
      `The hero theme "${id}" isn't a theme the app accepts:\n${check.errors.join("\n")}`,
    );
  }
  return check.manifest;
}

const fontWeight = (font: ThemeFont) =>
  font.weights ? `${font.weights.min} ${font.weights.max}` : String(font.weight ?? 400);

function themeFonts(id: string, manifest: ThemeManifest | null) {
  const fonts: { ui?: HeroThemeFont; mono?: HeroThemeFont } = {};
  const stacks = { ui: SANS_FALLBACK, mono: MONO_FALLBACK };
  for (const slot of ["ui", "mono"] as const) {
    const font = manifest?.fonts?.[slot];
    if (!font) continue;
    const named = cssFontFamilyList(font.family);
    const fallback = slot === "ui" ? SANS_FALLBACK : MONO_FALLBACK;
    if (font.data !== undefined) {
      const family = `tl-hero-${id}-${slot}`;
      fonts[slot] = { family, url: heroFontPath(font.data), weight: fontWeight(font) };
      stacks[slot] = [`"${family}"`, named, fallback].filter(Boolean).join(", ");
    } else if (named) {
      stacks[slot] = `${named}, ${fallback}`;
    }
  }
  return { fonts, stacks };
}

/** An embedded font's file, named by its content, so themes that embed the same font share one download. */
export const heroFontPath = (data: string) =>
  `/hero/fonts/${createHash("sha256").update(data).digest("hex").slice(0, 16)}.woff2`;
export const heroArtPath = (id: string) => `/hero/themes/${id}.json`;

/** A theme file's prompt as one line: its first sentence, without a leading "<name>:". */
function promptLine(manifest: ThemeManifest): string | undefined {
  const prompt = manifest.prompt?.trim();
  if (!prompt) return undefined;
  const named = prompt.startsWith(`${manifest.name}:`)
    ? prompt.slice(manifest.name.length + 1).trim()
    : prompt;
  const first = named.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? named;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function resolve(source: HeroThemeSource): HeroTheme {
  const glassLevel = source.glass ?? HERO_GLASS_LEVEL;
  if (source.kind === "default") {
    const light = BUILTIN_THEME_TOKENS.light;
    const dark = BUILTIN_THEME_TOKENS.dark;
    return {
      id: source.id,
      name: "Default",
      base: null,
      credit: { text: "built into the app" },
      about: source.about,
      ask: source.ask,
      glassLevel,
      thumb: WHOLE_ART,
      accent: { light: light.primary, dark: dark.primary },
      hasArt: false,
      manifest: null,
      tokens: light,
      fonts: {},
      fontStacks: { ui: SANS_FALLBACK, mono: MONO_FALLBACK },
    };
  }
  let manifest: ThemeManifest;
  let credit: HeroThemeCredit;
  if (source.kind === "starter") {
    const starter = STARTER_THEMES.find((theme) => theme.id === source.id);
    if (!starter) throw new Error(`No starter theme "${source.id}".`);
    manifest = decode(source.id, JSON.stringify(starter.manifest));
    credit = { text: "a starter theme that ships with the app" };
  } else if (source.kind === "showcase") {
    const file = SHOWCASE_FILES[source.id];
    const actual = sha256(file);
    if (actual !== SHOWCASE_FILE_SHA256[source.id]) {
      throw new Error(
        `The Showcase file for "${source.id}" changed (SHA-256 ${actual}). Copy it again from Threadlines/themes unchanged.`,
      );
    }
    manifest = decode(source.id, file);
    credit = {
      text: `from the Showcase, by ${manifest.credits?.author ?? "its author"}`,
      href: `${SHOWCASE_FOLDER}${source.id}`,
    };
  } else {
    manifest = decode(source.id, source.file);
    credit = source.credit;
  }
  const tokens = resolveThemeTokens(manifest);
  const { fonts, stacks } = themeFonts(source.id, manifest);
  return {
    id: source.id,
    name: manifest.name,
    base: manifest.base,
    credit,
    about: source.about ?? promptLine(manifest) ?? manifest.name,
    ask: source.ask,
    glassLevel,
    thumb: source.thumb ?? WHOLE_ART,
    accent: tokens.primary,
    hasArt: manifest.backdrop !== undefined && manifest.glass !== undefined,
    manifest,
    tokens,
    fonts,
    fontStacks: stacks,
  };
}

let cached: ReadonlyArray<HeroTheme> | null = null;

/** Every theme the hero offers, in row order. Throws on a bad or changed file. */
export function heroThemes(): ReadonlyArray<HeroTheme> {
  cached ??= SOURCES.map(resolve);
  return cached;
}

// ---------------------------------------------------------------------------
// What the page and the endpoints emit.

/** The `init` message's fields, as the app's backdrop host sends them. */
export interface HeroArtInit {
  readonly type: "init";
  readonly mode: string;
  readonly script: string;
  readonly maxFps: number;
  readonly base: ThemeBase;
  readonly palette: Record<string, string>;
  readonly textColors: ReadonlyArray<string>;
  readonly textRatios: ReadonlyArray<number>;
  readonly blur: number;
  readonly clarity: number;
}

/** One surface kind's tint floor and the color it tints with. */
export interface HeroZoneTint {
  readonly tint: number;
  readonly color: string;
}

/** What /hero/themes/<id>.json holds. */
export interface HeroArtPayload {
  readonly id: string;
  readonly init: HeroArtInit;
  readonly zones: {
    readonly frame: HeroZoneTint;
    readonly list: HeroZoneTint;
    readonly column: HeroZoneTint;
    readonly composer: HeroZoneTint;
  };
  readonly fonts: ReadonlyArray<HeroThemeFont>;
}

/** The art payload for a theme with art. */
export function heroArtPayload(theme: HeroTheme): HeroArtPayload {
  const manifest = theme.manifest;
  const backdrop = manifest?.backdrop;
  const glass = manifest?.glass;
  if (!manifest || !backdrop || !glass) throw new Error(`"${theme.id}" has no art.`);
  const tokens = theme.tokens;
  const level = theme.glassLevel;
  // The app's Glass slider math (ThemeBackdropLayer.tsx): zone floors, text bound and clarity.
  const floors = glassFloors(glass, level);
  const ratio = glassTextRatio(glass, level);
  const texts = glassTextColors(tokens);
  // A surface as it shows: laid over the solid base (the app's backdropZones.ts).
  const base = { ...(parseColor(tokens["surface-solid"]) ?? { r: 0, g: 0, b: 0 }), a: 1 };
  const solid = (token: ThemeTokenName) => {
    const value = parseColor(tokens[token]);
    return value ? formatHex({ ...composite(value, base), a: 1 }) : formatHex(base);
  };
  return {
    id: theme.id,
    init: {
      type: "init",
      mode: backdrop.mode,
      script: backdrop.script,
      maxFps: backdrop.maxFps,
      base: manifest.base,
      palette: { ...tokens },
      textColors: texts.map((text) => text.color),
      textRatios: texts.map(() => ratio),
      blur: glass.blur,
      clarity: glassClarity(level),
    },
    zones: {
      frame: { tint: floors.frame, color: solid("frame") },
      list: { tint: floors.list, color: solid("sidebar") },
      column: { tint: floors.column, color: solid("background") },
      composer: { tint: floors.composer, color: solid("card") },
    },
    fonts: [theme.fonts.ui, theme.fonts.mono].filter((font) => font !== undefined),
  };
}

/** Every embedded font the hero themes use, once each: its path and its WOFF2 bytes, unmodified. */
export function heroFontFiles(): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const theme of heroThemes()) {
    for (const slot of ["ui", "mono"] as const) {
      const data = theme.manifest?.fonts?.[slot]?.data;
      if (data !== undefined && theme.fonts[slot]) {
        files.set(heroFontPath(data), new Uint8Array(Buffer.from(data, "base64")));
      }
    }
  }
  return files;
}

const tokenCss = (tokens: ThemeTokens, dark?: ThemeTokens) =>
  WINDOW_TOKENS.map(
    (name) =>
      `--hw-${name}:${dark && dark[name] !== tokens[name] ? `light-dark(${tokens[name]},${dark[name]})` : tokens[name]};`,
  ).join("");

/**
 * The window's colors and fonts for every theme, and which theme's words
 * show, keyed by the page's `data-hero-theme` (set before first paint).
 * Default's colors follow the page's light or dark. Without the attribute
 * (no script), the light scheme's first theme shows.
 */
export function heroThemeCss(themes: ReadonlyArray<HeroTheme>): string {
  // Declared here so the showing theme's fonts load with the page, not when its art starts.
  const faces = themes.flatMap((theme) =>
    [theme.fonts.ui, theme.fonts.mono].flatMap((font) =>
      font
        ? [
            `@font-face{font-family:"${font.family}";src:url(${font.url}) format("woff2");font-weight:${font.weight};font-display:swap;}`,
          ]
        : [],
    ),
  );
  const rules = themes
    .map((theme) => {
      const on = `html[data-hero-theme="${theme.id}"]`;
      // No script: the first theme for the computer's scheme.
      const unset =
        theme.id === HERO_FIRST_THEME.light
          ? "light"
          : theme.id === HERO_FIRST_THEME.dark
            ? "dark"
            : null;
      const scheme = theme.base ? `color-scheme:${theme.base};` : "";
      const tokens =
        theme.base === null
          ? tokenCss(BUILTIN_THEME_TOKENS.light, BUILTIN_THEME_TOKENS.dark)
          : tokenCss(theme.tokens);
      // The window and the panels down the page (`.hw-tokens`) wear the same theme.
      const window = `${on} :is(.hw, .hw-tokens)`;
      const words = `${on} .hw-for[data-for="${theme.id}"]`;
      const body = `{${tokens}--hw-sans:${theme.fontStacks.ui};--hw-mono:${theme.fontStacks.mono};}`;
      // The theme's own scheme applies inside the window. The window's edge and shadow sit on the page, so they keep the page's.
      const inside = (selector: string) => (scheme ? `${selector} > *{${scheme}}` : "");
      const fallback = unset
        ? `\n@media (prefers-color-scheme:${unset}){html:not([data-hero-theme]) :is(.hw, .hw-tokens)${body}${inside("html:not([data-hero-theme]) :is(.hw, .hw-tokens)")}html:not([data-hero-theme]) .hw-for[data-for="${theme.id}"]{display:revert;}}`
        : "";
      return `${window}${body}${inside(window)}\n${words}{display:revert;}${fallback}`;
    })
    .join("\n");
  return [...faces, rules].join("\n");
}

// ---------------------------------------------------------------------------
// Thumbnails for the theme strip: a small picture of each theme's art, made
// at build from the still its file carries, or the app's own thumbnail for a
// starter (apps/web/public/themes, imported so a missing one fails the build).

/** The tile's picture, CSS px; the file is twice that. */
export const HERO_THUMB_SIZE = { width: 96, height: 60 } as const;
/** The most a thumbnail file may weigh. */
export const HERO_THUMB_MAX_BYTES = 10 * 1024;

const STARTER_THUMBNAILS: Readonly<Record<string, string>> = {
  "tokyo-rain": tokyoRainThumbnail,
  meadow: meadowThumbnail,
};

export const heroThumbPath = (id: string) => `/hero/thumbs/${id}.webp`;

/** The picture a theme's tile is made from, as PNG bytes; null for a theme without art. */
export function heroThumbSource(theme: HeroTheme): Uint8Array | null {
  if (!theme.hasArt) return null;
  const dataUrl = theme.manifest?.backdrop?.still ?? STARTER_THUMBNAILS[theme.id];
  if (!dataUrl)
    throw new Error(
      `The hero theme "${theme.id}" has art but no still or thumbnail to make its tile from.`,
    );
  const comma = dataUrl.indexOf(",");
  return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), "base64"));
}

let thumbs: Promise<Map<string, Uint8Array<ArrayBuffer>>> | null = null;

/** Every tile picture, by theme id: WebP at twice the tile's size. */
export function heroThumbnails(): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  thumbs ??= (async () => {
    const { default: sharp } = await import("sharp");
    const out = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const theme of heroThemes()) {
      const source = heroThumbSource(theme);
      if (!source) continue;
      // Zoomed in on the theme's focus where its art is sparse, then cut to the tile's shape.
      const { width = 0, height = 0 } = await sharp(source).metadata();
      const { zoom, x, y } = theme.thumb;
      const cropW = Math.round(width / zoom);
      const cropH = Math.round(height / zoom);
      const left = Math.round(Math.min(width - cropW, Math.max(0, x * width - cropW / 2)));
      const top = Math.round(Math.min(height - cropH, Math.max(0, y * height - cropH / 2)));
      const webp = await sharp(source)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(HERO_THUMB_SIZE.width * 2, HERO_THUMB_SIZE.height * 2, {
          fit: "cover",
          position: "centre",
        })
        .webp({ quality: 70, effort: 6 })
        .toBuffer();
      out.set(theme.id, new Uint8Array(webp));
    }
    return out;
  })();
  return thumbs;
}
