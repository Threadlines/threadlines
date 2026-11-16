/**
 * Theme files in and out (docs/design/custom-themes.md, "Storage and
 * devices" › Files, and "Sharing"). Export writes a `.threadlines-theme` file
 * the export dialog made ready to share; import reads
 * one (Settings, or a file dropped on the window), checks it the way the
 * server will, and holds it for the import dialog, which starts its trial.
 * A VS Code color theme file picked with Import is converted first.
 */
import {
  THEME_FILE_EXTENSION,
  THEME_MAX_FILE_BYTES,
  type ThemeManifest,
} from "@threadlines/contracts";
import { checkThemeManifest, themeContentHash } from "@threadlines/shared/themeManifest";
import {
  convertVsCodeTheme,
  isVsCodeThemeFile,
  parseJsonWithComments,
  readVsCodeTheme,
} from "@threadlines/shared/themeVsCode";
import { themeFileText } from "@threadlines/shared/themeSharing";

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
  const text = await file.text();
  let parsed: unknown;
  try {
    // VS Code theme files may hold comments and trailing commas.
    parsed = parseJsonWithComments(text);
  } catch {
    useThemeImportStore
      .getState()
      .set({ ok: false, fileName, errors: ["The file isn't a theme file."] });
    return;
  }
  if (isVsCodeThemeFile(parsed)) {
    await importVsCodeThemeFile(fileName, text);
    return;
  }
  const check = checkThemeManifest(parsed);
  if (!check.ok) {
    useThemeImportStore.getState().set({ ok: false, fileName, errors: check.errors });
    return;
  }
  // Imported here; a VS Code theme's source comes along.
  const vscode = check.manifest.createdBy?.vscode;
  const manifest: ThemeManifest = {
    ...check.manifest,
    createdBy: { kind: "imported", ...(vscode === undefined ? {} : { vscode }) },
  };
  useThemeImportStore
    .getState()
    .set({ ok: true, fileName, manifest, hash: await themeContentHash(manifest) });
}

/**
 * A VS Code color theme file, converted (themeVsCode.ts). One that builds on
 * another file (`include`) needs its extension: the VS Code tab brings those in.
 */
async function importVsCodeThemeFile(fileName: string, text: string): Promise<void> {
  const fail = (error: string) =>
    useThemeImportStore.getState().set({ ok: false, fileName, errors: [error] });
  let theme;
  try {
    theme = await readVsCodeTheme("theme.json", async (path) =>
      path === "theme.json" ? text : null,
    );
  } catch {
    fail(
      "This VS Code theme builds on another file, so it can't be imported on its own. Find it in the VS Code tab instead.",
    );
    return;
  }
  const label = theme.name ?? fileName.replace(/\.json$/i, "").replace(/-color-theme$/i, "");
  const converted = convertVsCodeTheme({ theme, label });
  if (!converted.ok) {
    fail(converted.problem);
    return;
  }
  useThemeImportStore.getState().set({
    ok: true,
    fileName,
    manifest: converted.manifest,
    hash: await themeContentHash(converted.manifest),
  });
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
  const blob = new Blob([themeFileText(manifest)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = themeFileName(manifest.name);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
