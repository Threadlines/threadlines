import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import {
  createFrameDeferredNotifications,
  FRAME_DEFERRAL_FALLBACK_MS,
} from "./frameDeferredNotifications";

interface CounterState {
  readonly count: number;
  readonly bump: () => void;
}

function createCounterStore() {
  const notifications = createFrameDeferredNotifications();
  const store = create<CounterState>()(
    notifications.middleware((set) => ({
      count: 0,
      bump: () => set((state) => ({ count: state.count + 1 })),
    })),
  );
  const heard: Array<readonly [number, number]> = [];
  store.subscribe((state, previous) => heard.push([previous.count, state.count]));
  return { store, heard, defer: notifications.defer };
}

describe("createFrameDeferredNotifications", () => {
  let frames: Array<() => void>;
  let visibilityState: DocumentVisibilityState;
  let visibilityListeners: Array<() => void>;

  const runFrame = () => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback();
  };

  beforeEach(() => {
    frames = [];
    visibilityState = "visible";
    visibilityListeners = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames[handle - 1] = () => undefined;
    });
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

  it("applies deferred writes at once and tells subscribers once, on the next frame", () => {
    const { store, heard, defer } = createCounterStore();

    defer(() => store.getState().bump());
    defer(() => store.getState().bump());

    expect(store.getState().count).toBe(2);
    expect(heard).toEqual([]);
    runFrame();
    expect(heard).toEqual([[0, 2]]);
  });

  it("tells subscribers about waiting writes with the next write made at once", () => {
    const { store, heard, defer } = createCounterStore();

    defer(() => store.getState().bump());
    store.getState().bump();
    expect(heard).toEqual([[0, 2]]);

    runFrame();
    vi.advanceTimersByTime(1_000);
    expect(heard).toEqual([[0, 2]]);
  });

  it("tells subscribers at once while no frame is coming", () => {
    const { store, heard, defer } = createCounterStore();

    visibilityState = "hidden";
    defer(() => store.getState().bump());
    expect(heard).toEqual([[0, 1]]);

    visibilityState = "visible";
    defer(() => store.getState().bump());
    expect(heard).toEqual([[0, 1]]);
    visibilityState = "hidden";
    for (const listener of visibilityListeners) listener();
    expect(heard).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("does not wait forever for a frame that never comes", () => {
    const { store, heard, defer } = createCounterStore();

    defer(() => store.getState().bump());
    vi.advanceTimersByTime(FRAME_DEFERRAL_FALLBACK_MS - 1);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([[0, 1]]);
  });
});
