import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import { BATCHED_NOTIFICATION_DELAY_MS, createBatchedNotifications } from "./batchedNotifications";

interface CounterState {
  readonly count: number;
  readonly bump: () => void;
}

function createCounterStore() {
  const notifications = createBatchedNotifications();
  const store = create<CounterState>()(
    notifications.middleware((set) => ({
      count: 0,
      bump: () => set((state) => ({ count: state.count + 1 })),
    })),
  );
  const heard: Array<readonly [number, number]> = [];
  store.subscribe((state, previous) => heard.push([previous.count, state.count]));
  return { store, heard, batch: notifications.batch };
}

describe("createBatchedNotifications", () => {
  let visibilityState: DocumentVisibilityState;
  let visibilityListeners: Array<() => void>;

  beforeEach(() => {
    visibilityState = "visible";
    visibilityListeners = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type: string, listener: () => void) => visibilityListeners.push(listener),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("applies batched writes at once and tells subscribers once, after the delay", () => {
    const { store, heard, batch } = createCounterStore();

    batch(() => store.getState().bump());
    batch(() => store.getState().bump());

    expect(store.getState().count).toBe(2);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(BATCHED_NOTIFICATION_DELAY_MS - 1);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([[0, 2]]);
  });

  it("tells subscribers about waiting writes with the next write made at once", () => {
    const { store, heard, batch } = createCounterStore();

    batch(() => store.getState().bump());
    store.getState().bump();
    expect(heard).toEqual([[0, 2]]);

    vi.advanceTimersByTime(BATCHED_NOTIFICATION_DELAY_MS * 10);
    expect(heard).toEqual([[0, 2]]);
  });

  it("tells a hidden page at once, and what waits when the page goes hidden", () => {
    const { store, heard, batch } = createCounterStore();

    visibilityState = "hidden";
    batch(() => store.getState().bump());
    expect(heard).toEqual([[0, 1]]);

    visibilityState = "visible";
    batch(() => store.getState().bump());
    expect(heard).toEqual([[0, 1]]);
    visibilityState = "hidden";
    for (const listener of visibilityListeners) listener();
    expect(heard).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});
