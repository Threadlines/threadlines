/**
 * Which theme the color editor is open on, if any (ThemeColorEditor.tsx).
 * Tiny and loaded at startup: the trial bar's host reads it to hide the bar
 * and mount the editor, which loads only when it opens.
 */
import { create } from "zustand";

import type { ThemeTile } from "~/themeLibrary/themeCatalog";

interface ThemeEditorState {
  /** The theme being edited; null while the editor is closed. */
  readonly tile: ThemeTile | null;
  /** The trial the editor's preview is: the Keep bar hides for it, and only for it. */
  readonly trialId: string | null;
  readonly open: (tile: ThemeTile) => void;
  readonly close: () => void;
  readonly setTrialId: (id: string | null) => void;
}

export const useThemeEditorStore = create<ThemeEditorState>()((set) => ({
  tile: null,
  trialId: null,
  // The same theme again keeps the edits and the preview in progress.
  open: (tile) => set((state) => (state.tile?.key === tile.key ? state : { tile, trialId: null })),
  close: () => set({ tile: null, trialId: null }),
  setTrialId: (trialId) => set({ trialId }),
}));

/** Opens the color editor on a theme: a library theme saves back to itself, any other to a copy. */
export const openThemeEditor = (tile: ThemeTile) => useThemeEditorStore.getState().open(tile);
