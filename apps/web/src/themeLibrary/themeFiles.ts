/**
 * Theme files in and out (docs/design/custom-themes.md, "Storage and
 * devices" › Files, and "Sharing"). Export writes a `.threadlines-theme` file
 * the export dialog made ready to share; import reads
 * one (Settings, or a file dropped on the window), checks it the way the
 * server will, and holds it for the import dialog, which starts its trial.
 */
import {
  THEME_FILE_EXTENSION,
  THEME_MAX_FILE_BYTES,
  type ThemeManifest,
} from "@threadlines/contracts";
import { checkThemeManifest, themeContentHash } from "@threadlines/shared/themeManifest";

import { useThemeImportStore } from "./themeImportState";

/** Reads a theme file and opens the import dialog with what it found. */
export async function importThemeFile(file: File): Promise<void> {
  const fileName = file.name;
  if (file.size > THEME_MAX_FILE_BYTES) {
    useThemeImportStore.getState().set({
      ok: false,
      fileName,
      errors: [`The file is larger than a theme file may be (${THEME_MAX_FILE_BYTES} bytes).`],
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    useThemeImportStore
      .getState()
      .set({ ok: false, fileName, errors: ["The file isn't a theme file."] });
    return;
  }
  const check = checkThemeManifest(parsed);
  if (!check.ok) {
    useThemeImportStore.getState().set({ ok: false, fileName, errors: check.errors });
    return;
  }
  const manifest: ThemeManifest = {
    ...check.manifest,
    createdBy: { kind: "imported" },
  };
  useThemeImportStore
    .getState()
    .set({ ok: true, fileName, manifest, hash: await themeContentHash(manifest) });
}

/** A file name for a theme: its name, made safe, with the theme extension. */
export function themeFileName(name: string): string {
  const printable = [...name].filter((character) => character.charCodeAt(0) >= 32).join("");
  const safe = printable
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${safe || "Theme"}${THEME_FILE_EXTENSION}`;
}

/** Downloads a theme as a file, as it is: make it ready to share first (`themeForSharing`). */
export function exportThemeFile(manifest: ThemeManifest): void {
  // Import refuses a file over the size limit, whitespace included: indent
  // only while the file still fits.
  const indented = `${JSON.stringify(manifest, null, 2)}\n`;
  const text =
    new TextEncoder().encode(indented).length <= THEME_MAX_FILE_BYTES
      ? indented
      : `${JSON.stringify(manifest)}\n`;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = themeFileName(manifest.name);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
