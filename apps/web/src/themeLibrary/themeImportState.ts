/**
 * A theme file waiting in the import dialog, and which files are theme
 * files: what every window needs at startup to take a dropped file. Reading
 * and checking the file (themeFiles.ts) loads only when one arrives.
 */
import { THEME_FILE_EXTENSION, type ThemeManifest } from "@threadlines/contracts";
import { create } from "zustand";

/** A file read for import: its theme when it checks out, or why it doesn't. */
export type PendingThemeImport =
  | {
      readonly ok: true;
      readonly fileName: string;
      readonly manifest: ThemeManifest;
      readonly hash: string;
    }
  | { readonly ok: false; readonly fileName: string; readonly errors: readonly string[] };

interface ThemeImportState {
  readonly pending: PendingThemeImport | null;
  readonly set: (pending: PendingThemeImport | null) => void;
}

export const useThemeImportStore = create<ThemeImportState>()((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}));

/** Whether a dropped or picked file looks like a theme file. */
export const isThemeFileName = (name: string) => name.toLowerCase().endsWith(THEME_FILE_EXTENSION);
