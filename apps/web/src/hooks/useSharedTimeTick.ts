import { useSyncExternalStore } from "react";

/**
 * One clock per interval that every caller reads together. Use it where two
 * views decide the same thing from the time and must agree, like the sidebar
 * and the family tabs filing threads (`useInboxThreads`). A label that only
 * shows its own age wants `useRelativeTimeTick` instead, which starts fresh
 * when it mounts.
 *
 * It ticks only while something reads it, and its time is never older than
 * one interval: a caller that mounts after a quiet spell gets the time now.
 */
export interface SharedClock {
  readonly subscribe: (onTick: () => void) => () => void;
  readonly getSnapshot: () => number;
}

const clocks = new Map<number, SharedClock>();

export function sharedClock(intervalMs: number): SharedClock {
  const existing = clocks.get(intervalMs);
  if (existing !== undefined) return existing;
  let nowMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  // Each tick lands one interval after the last reading, so no reading outlives it.
  const schedule = () => {
    timer = setTimeout(
      () => {
        nowMs = Date.now();
        schedule();
        notify();
      },
      Math.max(0, nowMs + intervalMs - Date.now()),
    );
  };
  const clock: SharedClock = {
    subscribe: (onTick) => {
      listeners.add(onTick);
      if (timer === null) schedule();
      return () => {
        listeners.delete(onTick);
        if (listeners.size === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => {
      // Too old to share: nothing kept it ticking, or its tick is late (a sleeping computer,
      // a background tab). Read the time now; a ticking clock tells every reader after this
      // render, and restarts its interval from here.
      if (Date.now() - nowMs >= intervalMs) {
        nowMs = Date.now();
        if (timer !== null) {
          clearTimeout(timer);
          schedule();
          queueMicrotask(notify);
        }
      }
      return nowMs;
    },
  };
  clocks.set(intervalMs, clock);
  return clock;
}

/** The shared clock's time for `intervalMs`, re-rendering on each tick. */
export function useSharedTimeTick(intervalMs: number): number {
  const clock = sharedClock(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot);
}
