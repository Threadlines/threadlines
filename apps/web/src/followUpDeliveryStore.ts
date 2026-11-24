import type { FollowUpDelivery, ScopedThreadRef } from "@threadlines/contracts";
import { scopedThreadKey } from "@threadlines/client-runtime";
import { create } from "zustand";

interface FollowUpDeliveryOverrideState {
  /**
   * Per-thread composer overrides of the global `followUpDelivery` setting.
   * In memory only: a reload falls back to the global setting.
   */
  readonly overridesByThreadKey: Readonly<Record<string, FollowUpDelivery>>;
  readonly setOverride: (
    threadRef: ScopedThreadRef,
    delivery: FollowUpDelivery,
    globalDefault: FollowUpDelivery,
  ) => void;
  readonly clearOverride: (threadRef: ScopedThreadRef) => void;
}

export const useFollowUpDeliveryStore = create<FollowUpDeliveryOverrideState>((set) => ({
  overridesByThreadKey: {},
  setOverride: (threadRef, delivery, globalDefault) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if (delivery === globalDefault) {
        if (!(key in state.overridesByThreadKey)) return state;
        const { [key]: _previous, ...rest } = state.overridesByThreadKey;
        return { overridesByThreadKey: rest };
      }
      if (state.overridesByThreadKey[key] === delivery) return state;
      return {
        overridesByThreadKey: { ...state.overridesByThreadKey, [key]: delivery },
      };
    }),
  clearOverride: (threadRef) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if (!(key in state.overridesByThreadKey)) return state;
      const { [key]: _previous, ...rest } = state.overridesByThreadKey;
      return { overridesByThreadKey: rest };
    }),
}));

/** Effective mid-turn delivery for a thread: its composer override, else the global setting. */
export function resolveFollowUpDelivery(
  overridesByThreadKey: Readonly<Record<string, FollowUpDelivery>>,
  threadRef: ScopedThreadRef,
  globalDefault: FollowUpDelivery,
): FollowUpDelivery {
  return overridesByThreadKey[scopedThreadKey(threadRef)] ?? globalDefault;
}

export function resetFollowUpDeliveryOverridesForTests() {
  useFollowUpDeliveryStore.setState({ overridesByThreadKey: {} });
}
