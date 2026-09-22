/**
 * The dictation status the server streams, shared by every consumer in one
 * client.
 *
 * The composer control and the Settings section both need it, and both can be
 * mounted at once, so subscriptions are refcounted per environment: the first
 * consumer opens the stream, the last one closes it, and the last value stays
 * cached so a remount renders immediately instead of flashing "unknown".
 *
 * @module dictationStatusStore
 */
import type { DictationStatus, EnvironmentId } from "@threadlines/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { readEnvironmentApi } from "../environmentApi";

interface DictationStatusStore {
  readonly byEnvironmentId: Partial<Record<EnvironmentId, DictationStatus>>;
  readonly setStatus: (environmentId: EnvironmentId, status: DictationStatus) => void;
  readonly reset: () => void;
}

export const useDictationStatusStore = create<DictationStatusStore>()((set) => ({
  byEnvironmentId: {},
  setStatus: (environmentId, status) =>
    set((store) => ({
      byEnvironmentId: { ...store.byEnvironmentId, [environmentId]: status },
    })),
  reset: () => set({ byEnvironmentId: {} }),
}));

interface Subscription {
  count: number;
  unsubscribe: () => void;
}

const subscriptions = new Map<EnvironmentId, Subscription>();

function retainStatusStream(environmentId: EnvironmentId): () => void {
  const existing = subscriptions.get(environmentId);
  if (existing) {
    existing.count += 1;
  } else {
    const api = readEnvironmentApi(environmentId);
    const unsubscribe = api
      ? api.dictation.subscribeStatus((status) => {
          useDictationStatusStore.getState().setStatus(environmentId, status);
        })
      : () => undefined;
    subscriptions.set(environmentId, { count: 1, unsubscribe });
  }

  return () => {
    const subscription = subscriptions.get(environmentId);
    if (!subscription) {
      return;
    }
    subscription.count -= 1;
    if (subscription.count <= 0) {
      subscriptions.delete(environmentId);
      subscription.unsubscribe();
    }
  };
}

/**
 * The environment's dictation status, `undefined` until the first message
 * arrives. Controls render disabled rather than guessing while it is unknown.
 */
export function useDictationStatus(
  environmentId: EnvironmentId | null | undefined,
): DictationStatus | undefined {
  useEffect(() => {
    if (!environmentId) {
      return;
    }
    return retainStatusStream(environmentId);
  }, [environmentId]);

  return useDictationStatusStore((store) =>
    environmentId ? store.byEnvironmentId[environmentId] : undefined,
  );
}

/** Non-React read of the last status seen for an environment. */
export function readDictationStatus(
  environmentId: EnvironmentId | null | undefined,
): DictationStatus | undefined {
  return environmentId
    ? useDictationStatusStore.getState().byEnvironmentId[environmentId]
    : undefined;
}

export function __resetDictationStatusForTests(): void {
  for (const subscription of subscriptions.values()) {
    subscription.unsubscribe();
  }
  subscriptions.clear();
  useDictationStatusStore.getState().reset();
}
