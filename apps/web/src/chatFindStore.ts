import { create } from "zustand";

/**
 * Find in chat's open state, shared by what opens it (the chat.find
 * keybinding in ChatView, the command palette) and the bar itself (ChatFind,
 * inside the chat's timeline). One chat is on screen at a time; the bar
 * closes when it unmounts with its chat.
 */
interface ChatFindState {
  /** Find can open in the chat on screen (ChatView publishes canFindInChat). */
  readonly available: boolean;
  readonly open: boolean;
  /** The query, kept across closing so reopening offers it again. */
  readonly query: string;
  /** Bumped by every open request, so an already open bar takes focus again. */
  readonly focusRequest: number;
  setAvailable: (available: boolean) => void;
  /** Opens the bar, searching for `seed` when the reader had text selected. */
  requestOpen: (seed?: string | null) => void;
  setQuery: (query: string) => void;
  close: () => void;
}

/** A selection too long to be what someone is looking for is not a query. */
const MAX_SEED_LENGTH = 256;

export const useChatFindStore = create<ChatFindState>()((set) => ({
  available: false,
  open: false,
  query: "",
  focusRequest: 0,
  setAvailable: (available) =>
    set((state) =>
      state.available === available ? state : { available, ...(available ? {} : { open: false }) },
    ),
  requestOpen: (seed) =>
    set((state) => {
      if (!state.available) return state;
      const trimmedSeed = seed?.trim() ?? "";
      const useSeed =
        trimmedSeed.length > 0 &&
        trimmedSeed.length <= MAX_SEED_LENGTH &&
        !trimmedSeed.includes("\n");
      return {
        open: true,
        focusRequest: state.focusRequest + 1,
        ...(useSeed ? { query: trimmedSeed } : {}),
      };
    }),
  setQuery: (query) => set({ query }),
  close: () => set((state) => (state.open ? { open: false } : state)),
}));
