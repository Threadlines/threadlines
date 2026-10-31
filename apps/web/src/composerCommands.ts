/**
 * Composer actions asked for from outside the composer (the command palette):
 * the composer on screen carries them out, the same way its own controls do.
 */
import { create } from "zustand";

export type ComposerCommandKind = "captureScreenshot";

export interface ComposerCommandRequest {
  readonly kind: ComposerCommandKind;
  /** Tells a repeat of the same action from the one already handled. */
  readonly nonce: number;
}

interface ComposerCommandsState {
  readonly request: ComposerCommandRequest | null;
  readonly requestComposerCommand: (kind: ComposerCommandKind) => void;
}

export const useComposerCommandsStore = create<ComposerCommandsState>()((set) => ({
  request: null,
  requestComposerCommand: (kind) =>
    set((state) => ({ request: { kind, nonce: (state.request?.nonce ?? 0) + 1 } })),
}));
