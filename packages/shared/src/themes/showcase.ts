/**
 * The Showcase's rules (docs/design/custom-themes.md, "Showcase"), shared by
 * the app that shares a theme, the server that lists them, and the CLI the
 * Threadlines/themes repository's checks run (scripts/theme-showcase.ts).
 *
 * A theme shared publicly is held to more than a theme file: it carries only
 * fields this build knows (so nothing private a newer build added slips out),
 * never says which thread made it, takes an open license, and its fonts keep
 * their own copyright notice and license. Its picture is a plain PNG.
 */
import {
  THEME_SHOWCASE_LICENSES,
  type ThemeManifest,
  type ThemeShowcaseFont,
} from "@threadlines/contracts";

import { fontNoticeLicense, type FontNotice } from "./fontNotice.ts";
import { checkThemeManifest } from "./manifest.ts";

/** The public repository the Showcase lives in. */
export const THEME_SHOWCASE_REPOSITORY = "Threadlines/themes";
/** Where the app reads the list and files: the repository's main branch, nowhere else. */
export const THEME_SHOWCASE_RAW_BASE = "https://raw.githubusercontent.com/Threadlines/themes/main/";
/** A theme's picture: 320×200, as the app draws its tiles. */
export const THEME_SHOWCASE_THUMBNAIL = { width: 320, height: 200, maxBytes: 160 * 1024 } as const;

/** The folder a theme takes: its name in lowercase words, with -2, -3… when that one is taken. */
export function showcaseSlugFor(name: string, taken: ReadonlySet<string>): string {
  // Every run of other characters is one dash, so trimming takes at most one at each end.
  const words = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const trimmed = (words.startsWith("-") ? words.slice(1) : words).slice(0, 36);
  const base = (trimmed.endsWith("-") ? trimmed.slice(0, -1) : trimmed) || "theme";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Every key each part of the format has; the Record makes a new field fail to compile until it's listed.
const keys = <T>(record: Record<keyof T, true>) => new Set(Object.keys(record));
type Part<K extends keyof ThemeManifest> = NonNullable<ThemeManifest[K]>;
const KNOWN: Readonly<Record<string, ReadonlySet<string>>> = {
  "": keys<ThemeManifest>({
    format: true,
    name: true,
    base: true,
    colors: true,
    overrides: true,
    code: true,
    terminal: true,
    fonts: true,
    glass: true,
    backdrop: true,
    prompt: true,
    credits: true,
    createdBy: true,
    createdAt: true,
  }),
  colors: keys<Part<"colors">>({
    background: true,
    foreground: true,
    mutedForeground: true,
    accent: true,
    accentForeground: true,
    border: true,
    success: true,
    warning: true,
    danger: true,
    info: true,
    codeBackground: true,
    selection: true,
  }),
  code: keys<Part<"code">>({
    foreground: true,
    comment: true,
    keyword: true,
    string: true,
    number: true,
    function: true,
    type: true,
    variable: true,
    operator: true,
    punctuation: true,
  }),
  fonts: keys<Part<"fonts">>({ ui: true, mono: true }),
  font: keys<NonNullable<Part<"fonts">["ui"]>>({
    family: true,
    source: true,
    weight: true,
    data: true,
    weights: true,
  }),
  weights: keys<NonNullable<NonNullable<Part<"fonts">["ui"]>["weights"]>>({ min: true, max: true }),
  glass: keys<Part<"glass">>({
    frame: true,
    list: true,
    column: true,
    composer: true,
    blur: true,
    readability: true,
  }),
  backdrop: keys<Part<"backdrop">>({ mode: true, script: true, maxFps: true, still: true }),
  credits: keys<Part<"credits">>({ author: true, link: true, license: true }),
};

/** Fields this build doesn't know, as paths ("glass.sheen"); a public share carries none. */
export function unknownThemeFields(manifest: ThemeManifest): string[] {
  const found: string[] = [];
  const scan = (value: unknown, part: string, path: string) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const known = KNOWN[part];
    if (known === undefined) return;
    for (const key of Object.keys(value)) {
      if (!known.has(key)) found.push(path === "" ? key : `${path}.${key}`);
    }
  };
  scan(manifest, "", "");
  for (const part of ["colors", "code", "fonts", "glass", "backdrop", "credits"] as const) {
    scan(manifest[part], part, part);
  }
  for (const slot of ["ui", "mono"] as const) {
    const font = manifest.fonts?.[slot];
    scan(font, "font", `fonts.${slot}`);
    scan(font?.weights, "weights", `fonts.${slot}.weights`);
  }
  return found;
}

/**
 * Why a theme file can't go in the Showcase as it is; empty when it can.
 * Its fonts are judged apart (`showcaseFontProblems`): reading a font's
 * notice takes a decompressor this module doesn't carry.
 */
export function themeShowcaseProblems(manifest: ThemeManifest): string[] {
  const check = checkThemeManifest(manifest, { authoring: true });
  if (!check.ok) return [...check.errors];
  const problems: string[] = [];
  if (manifest.createdBy !== undefined) {
    problems.push("It says which thread made it (createdBy); a shared theme never does.");
  }
  const license = manifest.credits?.license;
  if (license === "MIT") {
    problems.push(
      "It carries a Threadlines starter's MIT license. The Showcase takes themes under CC BY 4.0 or CC0.",
    );
  } else if (
    license === undefined ||
    !(THEME_SHOWCASE_LICENSES as ReadonlyArray<string>).includes(license)
  ) {
    problems.push("Pick a license others can use it under: CC BY 4.0 or CC0.");
  }
  // Unknown override names fail the authoring check above.
  const unknown = unknownThemeFields(manifest);
  if (unknown.length > 0) {
    problems.push(
      `It has parts this version of Threadlines doesn't know (${unknown.slice(0, 5).join(", ")}). Update Threadlines to share it.`,
    );
  }
  return problems;
}

/** An embedded font's notice, as the share dialog and the checks report it. */
export function showcaseFont(
  slot: "ui" | "mono",
  family: string,
  notice: FontNotice | null,
): ThemeShowcaseFont {
  return {
    slot,
    family,
    copyright: notice?.copyright ?? null,
    license: notice === null ? null : fontNoticeLicense(notice),
  };
}

/** Why the fonts can't be shared: each needs its copyright notice and an OFL or Apache license, inside the font. */
export function showcaseFontProblems(fonts: ReadonlyArray<ThemeShowcaseFont>): string[] {
  return fonts.flatMap((font) =>
    font.copyright === null || font.license === null
      ? [
          `The ${font.family} font doesn't carry ${font.copyright === null ? "its copyright notice" : "an OFL or Apache license"}, so it can't be shared.`,
        ]
      : [],
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks a plain picture needs: no text, no camera data, nothing that could carry a note. */
const PNG_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "tRNS",
  "sRGB",
  "gAMA",
  "cHRM",
  "pHYs",
  "IDAT",
  "IEND",
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** A PNG chunk's CRC, over its type and data. */
function chunkCrc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The samples a pixel has in each PNG color type. */
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The bit depths each PNG color type allows. */
const PNG_DEPTHS: Readonly<Record<number, ReadonlyArray<number>>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * Why a picture isn't a plain PNG within the limits; empty when it is. It
 * reads the chunks (each checksum, a header a decoder accepts, image data,
 * nothing after the end), not the pixels.
 */
export function showcasePngProblems(
  bytes: Uint8Array,
  limits: { readonly maxBytes: number; readonly width: number; readonly height: number },
  /**
   * zlib's inflate, where the caller has one (Node's `inflateSync`, bounded):
   * the image data must then unpack to exactly the rows its header promises.
   */
  inflate?: (data: Uint8Array) => Uint8Array,
): string[] {
  if (bytes.length > limits.maxBytes) {
    return [`The picture is ${bytes.length} bytes; the most is ${limits.maxBytes}.`];
  }
  if (bytes.length < 8 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return ["The picture isn't a PNG."];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const problems: string[] = [];
  let at = 8;
  let first = true;
  let ended = false;
  const imageData: Uint8Array[] = [];
  let rowBytes = 0;
  let rows = 0;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at + 12 + length > bytes.length) return ["The picture is cut short."];
    if (chunkCrc(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) {
      return ["The picture is damaged: a part of it doesn't match its checksum."];
    }
    if (first) {
      if (type !== "IHDR" || length !== 13) return ["The picture isn't a PNG."];
      const width = view.getUint32(at + 8);
      const height = view.getUint32(at + 12);
      const [depth, colorType, compression, filter, interlace] = bytes.subarray(at + 16, at + 21);
      // Interlaced pictures aren't plain ones: Threadlines never draws one.
      if (
        !(PNG_DEPTHS[colorType!] ?? []).includes(depth!) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return ["The picture isn't a plain PNG."];
      }
      rowBytes = 1 + Math.ceil((width * depth! * PNG_CHANNELS[colorType!]!) / 8);
      rows = height;
      if (width !== limits.width || height !== limits.height) {
        problems.push(
          `The picture is ${width}×${height}; it must be ${limits.width}×${limits.height}.`,
        );
      }
      first = false;
    }
    if (type === "IDAT") imageData.push(bytes.subarray(at + 8, at + 8 + length));
    if (!PNG_CHUNKS.has(type)) problems.push(`The picture carries extra data (a ${type} chunk).`);
    at += 12 + length;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) problems.push("The picture is cut short.");
  else if (at !== bytes.length) problems.push("The picture has data after its end.");
  const packed = imageData.reduce((total, chunk) => total + chunk.length, 0);
  if (ended && packed === 0) problems.push("The picture has no image in it.");
  else if (ended && inflate !== undefined && problems.length === 0) {
    const joined = new Uint8Array(packed);
    let offset = 0;
    for (const chunk of imageData) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    let unpacked: number;
    try {
      unpacked = inflate(joined).length;
    } catch {
      unpacked = -1;
    }
    if (unpacked !== rows * rowBytes) problems.push("The picture's image data is damaged.");
  }
  return [...new Set(problems)];
}

/**
 * A PNG Threadlines drew itself, with every chunk a plain picture doesn't
 * need dropped (the color profile and text a browser's screenshot may add).
 * Null when it isn't a whole PNG or needs a chunk outside the plain set.
 */
export function plainPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (PNG_CHUNKS.has(type)) kept.push(bytes.subarray(at, end));
    // An unknown critical chunk (uppercase first letter) can't be dropped safely.
    else if (type.charCodeAt(0) < 0x61) return null;
    at = end;
    if (type === "IEND") {
      const out = new Uint8Array(kept.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of kept) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }
  }
  return null;
}

/** The SHA-256 of exact bytes, lowercase hex: how the list names a file it points to. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A PNG data URL's bytes, or null when it isn't one. */
export function pngDataUrlBytes(dataUrl: string): Uint8Array | null {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return null;
  try {
    return Uint8Array.from(atob(dataUrl.slice(prefix.length)), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}
