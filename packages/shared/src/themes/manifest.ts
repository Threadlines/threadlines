/**
 * Checking and fingerprinting theme files (docs/design/custom-themes.md).
 * `checkThemeManifest` is what the server's save, the agent tools and file
 * import all run: the schema, the extra rules the schema can't say, and the
 * readability table. `themeContentHash` (manifestHash.ts) names a theme's content; the name,
 * prompt, origin and dates are not content. The same theme on two computers
 * is one library entry by its entry id, whatever its hash.
 */
import {
  THEME_FILE_FORMAT,
  THEME_MAX_FILE_BYTES,
  THEME_MAX_FONT_BYTES,
  THEME_MAX_STILL_PIXELS,
  THEME_MAX_STILL_SIDE,
  ThemeManifest,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";

import { type ThemeContrastFailure, themeContrastFailures } from "./contrast.ts";
import { THEME_OPAQUE_TOKENS, THEME_OVERRIDABLE_TOKENS, type ThemeTokenName } from "./tokens.ts";

export type ThemeCheck =
  | { readonly ok: true; readonly manifest: ThemeManifest }
  | {
      readonly ok: false;
      /** Problems worded for whoever has to fix them, an agent or a person. */
      readonly errors: ReadonlyArray<string>;
      readonly contrast: ReadonlyArray<ThemeContrastFailure>;
    };

const decodeManifest = Schema.decodeUnknownExit(ThemeManifest);

const base64Bytes = (data: string) => Math.floor((data.replace(/=+$/, "").length * 3) / 4);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_DATA_URL = "data:image/png;base64,";
const WOFF2_SIGNATURE = [0x77, 0x4f, 0x46, 0x32]; // "wOF2"
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The first `count` bytes of base64 data, or null when it isn't base64 at all.
 * A theme file says what its embedded files are; these are what they hold.
 */
function base64Head(data: string, count: number): Uint8Array | null {
  // Padding is optional (the app's font loader takes data without it), but a
  // length one past a multiple of four is never base64.
  if (data.length % 4 === 1 || !BASE64.test(data)) return null;
  const chunk = data.slice(0, Math.ceil(count / 3) * 4);
  try {
    const head = atob(chunk.padEnd(Math.ceil(chunk.length / 4) * 4, "="));
    return Uint8Array.from(head, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>) =>
  signature.every((byte, index) => bytes[index] === byte);

const bigEndian32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/** What's wrong with a still: not a PNG, or a PNG too big to open. Null when it's fine. */
function stillProblem(still: string): string | null {
  if (!still.startsWith(PNG_DATA_URL)) return "A backdrop still must be a PNG data URL.";
  // The signature, then the IHDR chunk: its length, its type, width and height.
  const head = base64Head(still.slice(PNG_DATA_URL.length), 24);
  if (
    head === null ||
    head.length < 24 ||
    !startsWith(head, PNG_SIGNATURE) ||
    String.fromCharCode(...head.slice(12, 16)) !== "IHDR"
  ) {
    return "The backdrop still isn't a PNG picture.";
  }
  const width = bigEndian32(head, 16);
  const height = bigEndian32(head, 20);
  if (
    width === 0 ||
    height === 0 ||
    width > THEME_MAX_STILL_SIDE ||
    height > THEME_MAX_STILL_SIDE ||
    width * height > THEME_MAX_STILL_PIXELS
  ) {
    return `The backdrop still is ${width}×${height} pixels; the most is ${THEME_MAX_STILL_SIDE} on a side and ${THEME_MAX_STILL_PIXELS} in all.`;
  }
  return null;
}

/** Validates an unknown value as a theme file. */
export function checkThemeManifest(input: unknown): ThemeCheck {
  const decoded = decodeManifest(input);
  if (decoded._tag === "Failure") {
    const format =
      typeof input === "object" && input !== null && "format" in input
        ? (input as { format: unknown }).format
        : undefined;
    const detail = String(decoded.cause).slice(0, 600);
    return {
      ok: false,
      errors: [
        format === THEME_FILE_FORMAT
          ? `The theme doesn't match the theme file format: ${detail}`
          : `Not a theme file (expected "format": "${THEME_FILE_FORMAT}"): ${detail}`,
      ],
      contrast: [],
    };
  }
  const manifest = decoded.value;
  const errors: string[] = [];
  const size = new TextEncoder().encode(JSON.stringify(manifest)).length;
  if (size > THEME_MAX_FILE_BYTES) {
    errors.push(
      `The theme is ${size} bytes; the most a theme file may be is ${THEME_MAX_FILE_BYTES}.`,
    );
  }
  for (const [name, value] of Object.entries(manifest.overrides ?? {})) {
    if (!(THEME_OVERRIDABLE_TOKENS as ReadonlyArray<string>).includes(name)) {
      errors.push(
        `"${name}" is not a token a theme can override. Overridable: ${THEME_OVERRIDABLE_TOKENS.join(", ")}.`,
      );
    } else if (
      THEME_OPAQUE_TOKENS.has(name as ThemeTokenName) &&
      value.length === 9 &&
      value.slice(7).toLowerCase() !== "ff"
    ) {
      errors.push(
        `"${name}" must be an opaque color (#rrggbb): text sits on it or is drawn in it.`,
      );
    }
  }
  for (const [slot, font] of Object.entries(manifest.fonts ?? {})) {
    if (!font) continue;
    if (font.data !== undefined && base64Bytes(font.data) > THEME_MAX_FONT_BYTES) {
      errors.push(`The ${slot} font is larger than ${THEME_MAX_FONT_BYTES} bytes.`);
    } else if (font.data !== undefined) {
      const head = base64Head(font.data, WOFF2_SIGNATURE.length);
      if (head === null || !startsWith(head, WOFF2_SIGNATURE)) {
        errors.push(`The ${slot} font isn't a WOFF2 font file.`);
      }
    }
    if (font.source === "system" && font.data !== undefined) {
      errors.push(`The ${slot} font says it comes from the system but carries font data.`);
    }
  }
  if (manifest.backdrop && !manifest.glass) {
    errors.push("A theme with backdrop art needs `glass` so text has something to sit on.");
  }
  const still = manifest.backdrop?.still;
  const badStill = still === undefined ? null : stillProblem(still);
  if (badStill !== null) errors.push(badStill);
  const contrast = themeContrastFailures(manifest);
  for (const failure of contrast) {
    errors.push(
      `${failure.fg} on ${failure.bg} is ${failure.ratio}:1; it needs ${failure.min}:1 (${failure.source}).`,
    );
  }
  return errors.length === 0 ? { ok: true, manifest } : { ok: false, errors, contrast };
}

// Hashing lives apart, so apps that only hash load none of the checks.
export { canonicalJson, themeContentForHash, themeContentHash } from "./manifestHash.ts";
