import { create } from "zustand";

/**
 * The thread list's own "new thread", for the rail's New thread button: it
 * starts the thread in the project the list is narrowed to, if it is, and
 * otherwise where the open thread is. The list publishes it while mounted;
 * without it the rail falls back to the open thread's project.
 */
interface ListNewThreadState {
  readonly start: (() => void) | null;
  readonly setStart: (start: (() => void) | null) => void;
}

export const useListNewThreadStore = create<ListNewThreadState>()((set) => ({
  start: null,
  setStart: (start) => set({ start }),
}));
