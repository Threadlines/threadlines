import type { ProviderRealtimeOutputModality, ThreadId } from "@threadlines/contracts";
import { create } from "zustand";

export type RealtimeVoiceStatus = "idle" | "starting" | "active" | "error";

export interface RealtimeVoiceState {
  readonly status: RealtimeVoiceStatus;
  readonly muted: boolean;
  readonly modality: ProviderRealtimeOutputModality;
  readonly error: string | null;
}

export type RealtimeVoiceEvent =
  | { readonly type: "start-requested" }
  | { readonly type: "projection-activated" }
  | { readonly type: "projection-deactivated" }
  | { readonly type: "mute-changed"; readonly muted: boolean }
  | { readonly type: "modality-changed"; readonly modality: ProviderRealtimeOutputModality }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "reset" };

export const DEFAULT_REALTIME_VOICE_STATE: RealtimeVoiceState = Object.freeze({
  status: "idle",
  muted: false,
  modality: "audio",
  error: null,
});

export function reduceRealtimeVoiceState(
  state: RealtimeVoiceState,
  event: RealtimeVoiceEvent,
): RealtimeVoiceState {
  switch (event.type) {
    case "start-requested":
      return {
        ...state,
        status: "starting",
        muted: false,
        error: null,
      };
    case "projection-activated":
      return state.status === "starting" || state.status === "active"
        ? { ...state, status: "active", error: null }
        : state;
    case "projection-deactivated":
    case "reset":
      return {
        ...DEFAULT_REALTIME_VOICE_STATE,
        modality: state.modality,
      };
    case "mute-changed":
      return state.status === "active" ? { ...state, muted: event.muted } : state;
    case "modality-changed":
      return state.status === "idle" || state.status === "error"
        ? { ...state, modality: event.modality, error: null, status: "idle" }
        : state;
    case "failed":
      return {
        ...state,
        status: "error",
        muted: true,
        error: event.message,
      };
  }
}

interface RealtimeVoiceStore {
  readonly byThreadId: Partial<Record<ThreadId, RealtimeVoiceState>>;
  readonly dispatch: (threadId: ThreadId, event: RealtimeVoiceEvent) => void;
  readonly reset: () => void;
}

export const useRealtimeVoiceStore = create<RealtimeVoiceStore>()((set) => ({
  byThreadId: {},
  dispatch: (threadId, event) =>
    set((store) => ({
      byThreadId: {
        ...store.byThreadId,
        [threadId]: reduceRealtimeVoiceState(
          store.byThreadId[threadId] ?? DEFAULT_REALTIME_VOICE_STATE,
          event,
        ),
      },
    })),
  reset: () => set({ byThreadId: {} }),
}));

export function readRealtimeVoiceState(threadId: ThreadId): RealtimeVoiceState {
  return useRealtimeVoiceStore.getState().byThreadId[threadId] ?? DEFAULT_REALTIME_VOICE_STATE;
}
