import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import type { DraftId } from "./composerDraftStore";

/**
 * Focus for the composer of a new thread someone asked for.
 *
 * A pristine draft opens without taking focus (ChatView), so the launch
 * landing and a trip back to an empty draft leave the keyboard alone. A new
 * thread the user asked for (the shortcut, a New thread button, the command
 * palette) is different: they are about to type. `useNewThreadHandler` asks
 * here, naming the draft, and the ChatView showing that draft answers once,
 * whether it was already on screen or mounts after the navigation.
 */
interface NewThreadComposerFocusState {
  readonly request: { readonly draftId: DraftId; readonly token: number } | null;
}

const useNewThreadComposerFocusStore = create<NewThreadComposerFocusState>()(() => ({
  request: null,
}));

/** Asks the composer of `draftId` to take focus when its ChatView is on screen. */
export function requestNewThreadComposerFocus(draftId: DraftId): void {
  useNewThreadComposerFocusStore.setState((state) => ({
    request: { draftId, token: (state.request?.token ?? 0) + 1 },
  }));
}

/**
 * Runs `focus` once for each request naming `draftId`. `enabled: false`
 * (touch devices, where focus opens the keyboard) drops the request instead.
 */
export function useNewThreadComposerFocus(input: {
  readonly draftId: DraftId | null;
  readonly enabled: boolean;
  readonly focus: () => void;
}): void {
  const { draftId, enabled } = input;
  const token = useNewThreadComposerFocusStore((state) =>
    draftId !== null && state.request?.draftId === draftId ? state.request.token : 0,
  );
  const answer = useEffectEvent(() => {
    // Taken before focusing: the request is answered once, never again on a
    // later visit to the same draft.
    useNewThreadComposerFocusStore.setState((state) =>
      state.request?.token === token ? { request: null } : state,
    );
    if (enabled) input.focus();
  });
  useEffect(() => {
    if (token !== 0) answer();
  }, [token]);
}
