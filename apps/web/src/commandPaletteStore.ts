import type { EnvironmentId, ScopedProjectRef } from "@threadlines/contracts";
import { create } from "zustand";

export interface CommandPaletteThreadSearchRequest {
  /** Display name of the sidebar project the search is scoped to. */
  projectName: string;
  /** Scoped project keys of the logical project's member projects. */
  memberProjectKeys: readonly string[];
}

/**
 * An add-project flow opened to pick a folder for someone else (the setup
 * screen): the palette reports the project instead of opening a thread in it,
 * and stays on the given environment.
 */
export interface CommandPaletteProjectSelection {
  readonly environmentId?: EnvironmentId;
  readonly onProjectSelected: (projectRef: ScopedProjectRef) => void;
}

type CommandPaletteOpenIntent =
  | { kind: "add-project"; requestId: number }
  | ({ kind: "search-threads"; requestId: number } & CommandPaletteThreadSearchRequest);

interface CommandPaletteStore {
  open: boolean;
  /**
   * Increments on every opening. Async flows that close the palette after an
   * await must capture this when they start and close via `closeIfGeneration`,
   * so a continuation that outlives its own palette session (the user closed
   * or reopened it while the request was in flight) cannot slam a palette it
   * does not own.
   */
  openGeneration: number;
  openIntent: CommandPaletteOpenIntent | null;
  /** Present while an add-project flow is picking a folder for a caller; cleared on close. */
  projectSelection: CommandPaletteProjectSelection | null;
  setOpen: (open: boolean) => void;
  /** Closes only if the palette is still on the given open generation. */
  closeIfGeneration: (generation: number) => void;
  toggleOpen: () => void;
  /** Opens the add-project flow; with a selection, it reports the project instead of opening it. */
  openAddProject: (selection?: CommandPaletteProjectSelection) => void;
  openThreadSearch: (request: CommandPaletteThreadSearchRequest) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openGeneration: 0,
  openIntent: null,
  projectSelection: null,
  setOpen: (open) =>
    set((state) => ({
      open,
      ...(open
        ? state.open
          ? {}
          : { openGeneration: state.openGeneration + 1 }
        : { openIntent: null, projectSelection: null }),
    })),
  closeIfGeneration: (generation) =>
    set((state) =>
      state.open && state.openGeneration === generation
        ? { open: false, openIntent: null, projectSelection: null }
        : state,
    ),
  toggleOpen: () =>
    set((state) => ({
      open: !state.open,
      ...(state.open
        ? { openIntent: null, projectSelection: null }
        : { openGeneration: state.openGeneration + 1 }),
    })),
  openAddProject: (selection) =>
    set((state) => ({
      open: true,
      ...(state.open ? {} : { openGeneration: state.openGeneration + 1 }),
      projectSelection: selection ?? null,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openThreadSearch: (request) =>
    set((state) => ({
      open: true,
      ...(state.open ? {} : { openGeneration: state.openGeneration + 1 }),
      projectSelection: null,
      openIntent: {
        kind: "search-threads",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
        projectName: request.projectName,
        memberProjectKeys: request.memberProjectKeys,
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
