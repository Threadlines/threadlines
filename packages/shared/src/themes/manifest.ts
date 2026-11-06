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
    }
    if (font.source === "system" && font.data !== undefined) {
      errors.push(`The ${slot} font says it comes from the system but carries font data.`);
    }
  }
  if (manifest.backdrop && !manifest.glass) {
    errors.push("A theme with backdrop art needs `glass` so text has something to sit on.");
  }
  if (
    manifest.backdrop?.still !== undefined &&
    !manifest.backdrop.still.startsWith("data:image/png;base64,")
  ) {
    errors.push("A backdrop still must be a PNG data URL.");
  }
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
