/**
 * Terminal actions asked for from outside the thread view (the command
 * palette): the thread view that shows the thread carries them out, with the
 * same confirmations its own buttons use.
 */
import { create } from "zustand";

export type TerminalCommandKind =
  | "toggle"
  | "new"
  | "split"
  | "find"
  | "clear"
  | "restart"
  | "kill";

export interface TerminalCommandRequest {
  readonly kind: TerminalCommandKind;
  /** Tells a repeat of the same action from the one already handled. */
  readonly nonce: number;
}

interface TerminalCommandsState {
  readonly request: TerminalCommandRequest | null;
  readonly requestTerminalCommand: (kind: TerminalCommandKind) => void;
}

export const useTerminalCommandsStore = create<TerminalCommandsState>()((set) => ({
  request: null,
  requestTerminalCommand: (kind) =>
    set((state) => ({ request: { kind, nonce: (state.request?.nonce ?? 0) + 1 } })),
}));
