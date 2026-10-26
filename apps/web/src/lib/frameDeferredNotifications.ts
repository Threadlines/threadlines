import type { StateCreator, StoreApi } from "zustand";

/** How long deferred writes wait for an animation frame that never comes (a stalled compositor). */
export const FRAME_DEFERRAL_FALLBACK_MS = 100;

type Listener<T> = (state: T, previousState: T) => void;

/**
 * Lets a zustand store tell its subscribers about some writes once per
 * animation frame instead of once per write.
 *
 * A write made inside `defer` changes the state at once, so `getState()` is
 * always current, but subscribers (every mounted hook reading the store) hear
 * about it on the next animation frame, together with every other deferred
 * write since. Any other write tells them at once, deferred writes included.
 * The browser paints after its animation-frame callbacks, so a deferred write
 * still reaches the screen in the frame it would have anyway; what it saves
 * is the renders in between, which nobody sees. Where no frame is coming (a
 * hidden page, or no `requestAnimationFrame` at all) deferred writes tell
 * subscribers at once.
 *
 * Pass the store's state creator through `middleware`; one instance serves
 * one store.
 */
export function createFrameDeferredNotifications() {
  let store: StoreApi<unknown> | null = null;
  const listeners = new Set<Listener<unknown>>();
  let toldState: unknown;
  let deferring = 0;
  let frame: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  function cancelScheduled(): void {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (fallback !== null) {
      clearTimeout(fallback);
      fallback = null;
    }
  }

  /** Tells every subscriber about the current state, if they have not heard of it. */
  function flush(): void {
    cancelScheduled();
    if (store === null) return;
    const state = store.getState();
    if (Object.is(state, toldState)) return;
    const previousState = toldState;
    toldState = state;
    for (const listener of listeners) listener(state, previousState);
  }

  function frameIsComing(): boolean {
    return (
      typeof requestAnimationFrame === "function" &&
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    );
  }

  let watchingVisibility = false;

  function scheduleFlush(): void {
    if (frame !== null) return;
    if (!watchingVisibility) {
      watchingVisibility = true;
      // A page going hidden stops animation frames; what waits for one is told now.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") flush();
      });
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      flush();
    });
    fallback = setTimeout(flush, FRAME_DEFERRAL_FALLBACK_MS);
  }

  function middleware<T>(createState: StateCreator<T, [], []>): StateCreator<T, [], []> {
    return (set, get, api) => {
      store = api as StoreApi<unknown>;
      api.subscribe(() => {
        if (deferring > 0 && frameIsComing()) {
          scheduleFlush();
          return;
        }
        flush();
      });
      api.subscribe = (listener) => {
        listeners.add(listener as Listener<unknown>);
        return () => {
          listeners.delete(listener as Listener<unknown>);
        };
      };
      const initialState = createState(set, get, api);
      toldState = initialState;
      return initialState;
    };
  }

  /** Runs `write`; the store's subscribers hear about its writes by the next frame. */
  function defer(write: () => void): void {
    deferring += 1;
    try {
      write();
    } finally {
      deferring -= 1;
    }
  }

  return { middleware, defer, flush };
}
