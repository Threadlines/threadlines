import type { EnvironmentId, ScopedProjectRef } from "@threadlines/contracts";
import { create } from "zustand";

import { captureReturnFocus, type DialogReturnFocus } from "../../lib/dialogReturnFocus";

/**
 * Add project opened to pick a folder for someone else (the setup screen): the
 * dialog reports the project instead of opening a thread in it, and stays on
 * the given computer.
 */
export interface AddProjectSelection {
  readonly environmentId?: EnvironmentId;
  readonly onProjectSelected: (projectRef: ScopedProjectRef) => void;
}

export interface AddProjectOpenRequest {
  readonly selection?: AddProjectSelection;
  /** A path to start browsing at, from the palette's "Add project at" row. */
  readonly initialPath?: string;
  /** Where focus goes when the dialog closes; the focused element by default. */
  readonly returnFocus?: DialogReturnFocus;
}

/** One opening of the dialog. Everything it was opened with is fixed for its life. */
export interface AddProjectSession {
  readonly id: number;
  readonly selection: AddProjectSelection | null;
  readonly initialPath: string | null;
  readonly returnFocus: DialogReturnFocus | null;
}

interface AddProjectStore {
  /** The open session, or null while the dialog is closed. */
  session: AddProjectSession | null;
  lastSessionId: number;
  /** Opens a new session, replacing any open one, and returns its id. */
  open: (request?: AddProjectOpenRequest) => number;
  close: () => void;
  /** Closes only if the given session is still the open one. */
  closeSession: (sessionId: number) => void;
}

export const useAddProjectStore = create<AddProjectStore>((set, get) => ({
  session: null,
  lastSessionId: 0,
  open: (request = {}) => {
    const id = get().lastSessionId + 1;
    set({
      lastSessionId: id,
      session: {
        id,
        selection: request.selection ?? null,
        initialPath: request.initialPath ?? null,
        returnFocus: request.returnFocus ?? captureReturnFocus(),
      },
    });
    return id;
  },
  close: () => set({ session: null }),
  closeSession: (sessionId) =>
    set((state) => (state.session?.id === sessionId ? { session: null } : state)),
}));

export function openAddProject(request?: AddProjectOpenRequest): number {
  return useAddProjectStore.getState().open(request);
}

export function isAddProjectSessionOpen(sessionId: number): boolean {
  return useAddProjectStore.getState().session?.id === sessionId;
}

/**
 * What happens once a project was added or found. The project exists either
 * way. Only the session that started the operation, if it is still the open
 * one, gets the selection callback, the navigation and the close; after it was
 * closed or replaced, `announce` tells the user what was added instead, so a
 * late clone never lands in another caller's flow.
 */
export async function finishAddProject(input: {
  readonly session: AddProjectSession;
  readonly projectRef: ScopedProjectRef;
  /** Opens the project: its latest thread, or a new one. */
  readonly openProject: () => Promise<void>;
  readonly announce: (openProject: () => Promise<void>) => void;
}): Promise<void> {
  const { session, projectRef, openProject } = input;
  if (!isAddProjectSessionOpen(session.id)) {
    input.announce(openProject);
    return;
  }
  if (session.selection) {
    session.selection.onProjectSelected(projectRef);
    useAddProjectStore.getState().closeSession(session.id);
    return;
  }
  await openProject();
  useAddProjectStore.getState().closeSession(session.id);
}
