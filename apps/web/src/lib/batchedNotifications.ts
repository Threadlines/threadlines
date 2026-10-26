import type { StateCreator, StoreApi } from "zustand";

/**
 * How long a batched write waits before subscribers hear of it. Several
 * threads streaming at once then cost about ten renders a second whatever the
 * display's refresh rate (a 120 Hz screen has a frame for nearly every
 * event), and a sidebar row is never late enough for anyone to see.
 */
export const BATCHED_NOTIFICATION_DELAY_MS = 100;

type Listener<T> = (state: T, previousState: T) => void;

/**
 * Lets a zustand store tell its subscribers about some writes in batches
 * instead of once per write.
 *
 * A write made inside `batch` changes the state at once, so `getState()` is
 * always current, but subscribers (every mounted hook reading the store) hear
 * about it up to BATCHED_NOTIFICATION_DELAY_MS later, together with every
 * other batched write since. Any other write tells them at once, batched
 * writes included, so nothing written at once is ever held back. A hidden
 * page is told at once: its timers can be slowed to once a minute, and what
 * it still drives (the Dock badge, keeping the computer awake) must not wait.
 *
 * Pass the store's state creator through `middleware`; one instance serves
 * one store.
 */
export function createBatchedNotifications(delayMs = BATCHED_NOTIFICATION_DELAY_MS) {
  let store: StoreApi<unknown> | null = null;
  const listeners = new Set<Listener<unknown>>();
  let toldState: unknown;
  let batching = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watchingVisibility = false;
  let flushing = false;
  let writtenWhileFlushing = false;
  /** Rounds one flush runs before a listener that keeps writing is left to the timer. */
  const maxRounds = 32;

  /**
   * Tells every subscriber about the current state, if they have not heard of
   * it. A listener that writes the store while being told finishes this round
   * first: every subscriber hears each state in order, then the newer one.
   */
  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (store === null) return;
    if (flushing) {
      writtenWhileFlushing = true;
      return;
    }
    flushing = true;
    let rounds = 0;
    try {
      do {
        writtenWhileFlushing = false;
        const state = store.getState();
        if (Object.is(state, toldState)) break;
        const previousState = toldState;
        toldState = state;
        for (const listener of listeners) listener(state, previousState);
        rounds += 1;
      } while (writtenWhileFlushing && rounds < maxRounds);
    } finally {
      flushing = false;
    }
    // A listener answering every write with another would spin here forever;
    // what it wrote last goes out with the next batch instead.
    if (writtenWhileFlushing) timer ??= setTimeout(flush, delayMs);
  }

  function pageVisible(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "visible";
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    if (!watchingVisibility) {
      watchingVisibility = true;
      // A page going hidden is told what is waiting now (see above).
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") flush();
      });
    }
    timer = setTimeout(flush, delayMs);
  }

  function middleware<T>(createState: StateCreator<T, [], []>): StateCreator<T, [], []> {
    return (set, get, api) => {
      store = api as StoreApi<unknown>;
      api.subscribe(() => {
        if (batching > 0 && pageVisible()) {
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

  /** Runs `write`; the store's subscribers hear about its writes within the batch delay. */
  function batch(write: () => void): void {
    batching += 1;
    try {
      write();
    } finally {
      batching -= 1;
    }
  }

  return { middleware, batch, flush };
}
