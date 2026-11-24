import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ScopedThreadRef,
} from "@threadlines/contracts";
import { create } from "zustand";

import { captureReturnFocus, type DialogReturnFocus } from "../../lib/dialogReturnFocus";

/** The workspace project whose other Codex conversations the dialog lists. */
export interface CodexImportProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly cwd: string;
}

export interface CodexImportAccount {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

export interface CodexImportOpenRequest {
  readonly project: CodexImportProject;
  /** The usable Codex accounts on the project's computer; more than one shows a picker first. */
  readonly accounts: ReadonlyArray<CodexImportAccount>;
  /** The open thread's or draft's mode when the dialog opened; a brought-in thread starts in it. */
  readonly runtimeMode: RuntimeMode;
  readonly returnFocus?: DialogReturnFocus;
}

/** One opening of the dialog. Everything it was opened with is fixed for its life. */
export interface CodexImportSession {
  readonly id: number;
  readonly project: CodexImportProject;
  readonly accounts: ReadonlyArray<CodexImportAccount>;
  readonly runtimeMode: RuntimeMode;
  readonly returnFocus: DialogReturnFocus | null;
}

interface CodexImportStore {
  session: CodexImportSession | null;
  lastSessionId: number;
  /** Opens a new session, replacing any open one, and returns its id. */
  open: (request: CodexImportOpenRequest) => number;
  close: () => void;
  /** Closes only if the given session is still the open one. */
  closeSession: (sessionId: number) => void;
}

export const useCodexImportStore = create<CodexImportStore>((set, get) => ({
  session: null,
  lastSessionId: 0,
  open: (request) => {
    const id = get().lastSessionId + 1;
    set({
      lastSessionId: id,
      session: {
        id,
        project: request.project,
        accounts: request.accounts,
        runtimeMode: request.runtimeMode,
        returnFocus: request.returnFocus ?? captureReturnFocus(),
      },
    });
    return id;
  },
  close: () => set({ session: null }),
  closeSession: (sessionId) =>
    set((state) => (state.session?.id === sessionId ? { session: null } : state)),
}));

export function openCodexImport(request: CodexImportOpenRequest): number {
  return useCodexImportStore.getState().open(request);
}

/** The last session that ended with something done through it, as against closed. */
let lastCompletedSessionId: number | null = null;

/**
 * How a session ended: "imported" when a conversation came in through it,
 * "cancelled" when it was closed or replaced first. The palette counts a use
 * of the command only for the first.
 */
export function waitForCodexImportSessionEnd(sessionId: number): Promise<"imported" | "cancelled"> {
  return new Promise((resolve) => {
    const settle = () => {
      if (useCodexImportStore.getState().session?.id === sessionId) return;
      unsubscribe();
      resolve(lastCompletedSessionId === sessionId ? "imported" : "cancelled");
    };
    const unsubscribe = useCodexImportStore.subscribe(settle);
    settle();
  });
}

/**
 * What happens once a conversation was brought in. The thread exists either
 * way. If the session that started the import is still open it closes and the
 * thread opens; after it was closed or replaced, `announce` tells the user
 * instead of moving them off whatever they went to.
 */
export async function finishCodexImport(input: {
  readonly sessionId: number;
  readonly threadRef: ScopedThreadRef;
  readonly openThread: () => Promise<void>;
  readonly announce: (openThread: () => Promise<void>) => void;
}): Promise<void> {
  if (useCodexImportStore.getState().session?.id !== input.sessionId) {
    input.announce(input.openThread);
    return;
  }
  lastCompletedSessionId = input.sessionId;
  useCodexImportStore.getState().closeSession(input.sessionId);
  await input.openThread();
}
