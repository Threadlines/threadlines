import { create } from "zustand";

import type { SettingsPagePlaceId } from "./settingsPlaceAvailability";

/**
 * The settings search (docs/design/settings-search.md), shared by its field
 * (the settings menu on a wide screen, the section list on a phone) and its
 * results (the settings page area). Not in the URL: a navigation per
 * keystroke would redraw every page that reads its search params. Settings
 * clears it when it closes, and a result clears it when it opens its page.
 */
interface SettingsSearchState {
  readonly query: string;
  /** The page the results are narrowed to, from the menu; null for all. */
  readonly scope: SettingsPagePlaceId | null;
  /** Bumped to ask the field to take focus (⌘F). */
  readonly focusRequest: number;
  /** Counts searches started (an empty query getting its first word), for facts read per search. */
  readonly searchesStarted: number;
  setQuery: (query: string) => void;
  setScope: (scope: SettingsPagePlaceId | null) => void;
  requestFocus: () => void;
  clear: () => void;
}

export const useSettingsSearchStore = create<SettingsSearchState>()((set) => ({
  query: "",
  scope: null,
  focusRequest: 0,
  searchesStarted: 0,
  // A new query asks a new question, so a narrowing chosen for the last one goes.
  setQuery: (query) =>
    set((state) =>
      state.query === query
        ? state
        : {
            query,
            scope: null,
            searchesStarted:
              state.query.trim().length === 0 && query.trim().length > 0
                ? state.searchesStarted + 1
                : state.searchesStarted,
          },
    ),
  setScope: (scope) => set({ scope }),
  requestFocus: () => set((state) => ({ focusRequest: state.focusRequest + 1 })),
  clear: () => set({ query: "", scope: null }),
}));

/** Whether a search is showing results now. */
export const selectSettingsSearchActive = (state: SettingsSearchState): boolean =>
  state.query.trim().length > 0;
