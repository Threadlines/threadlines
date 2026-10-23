import { useEffect, useSyncExternalStore } from "react";

/**
 * Who needs the left screen edge for their own touches.
 *
 * In the iPhone home-screen app a swipe in from that edge opens the thread
 * list, through a thin strip laid over it. A surface whose content runs up to
 * the edge (the terminal, 4px in) claims it while it is on screen, and the
 * strip steps aside until the last claim is let go.
 */
let claimCount = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds the left screen edge while `active`; lets it go on unmount. */
export function useClaimScreenEdge(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    claimCount += 1;
    notify();
    return () => {
      claimCount -= 1;
      notify();
    };
  }, [active]);
}

/** Whether anything on screen holds the left screen edge. */
export function useScreenEdgeClaimed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => claimCount > 0,
    () => false,
  );
}
