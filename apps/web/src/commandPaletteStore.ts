import { create } from "zustand";

export interface CommandPaletteThreadSearchRequest {
  /** Display name of the sidebar project the search is scoped to. */
  projectName: string;
  /** Scoped project keys of the logical project's member projects. */
  memberProjectKeys: readonly string[];
}

type CommandPaletteOpenIntent =
  | { kind: "add-project"; requestId: number }
  | ({ kind: "search-threads"; requestId: number } & CommandPaletteThreadSearchRequest);

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: () => void;
  openThreadSearch: (request: CommandPaletteThreadSearchRequest) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openThreadSearch: (request) =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "search-threads",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
        projectName: request.projectName,
        memberProjectKeys: request.memberProjectKeys,
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
