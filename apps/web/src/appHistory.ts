import { type RouterHistory, useRouter } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";

type HistoryMove = "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";

/**
 * Where the app stands in its own history: the entry on screen, and the
 * furthest entry forward that is still there to return to.
 */
export interface HistoryPosition {
  readonly index: number;
  readonly furthest: number;
}

/**
 * The position after a move to the entry at `index`. Going somewhere new
 * drops everything ahead, as a browser does; going back keeps it.
 */
export function nextHistoryPosition(
  position: HistoryPosition,
  move: HistoryMove,
  index: number,
): HistoryPosition {
  if (move === "PUSH") return { index, furthest: index };
  return { index, furthest: Math.max(position.furthest, index) };
}

interface HistoryTracker {
  readonly read: () => HistoryPosition;
  readonly subscribe: (listener: () => void) => () => void;
}

function indexOf(history: RouterHistory): number {
  return history.location.state.__TSR_index ?? 0;
}

// One per history, kept for its life: the first reader starts it, so it has
// seen every move since the window opened.
const trackers = new WeakMap<RouterHistory, HistoryTracker>();

function trackerFor(history: RouterHistory): HistoryTracker {
  const existing = trackers.get(history);
  if (existing) return existing;
  let position: HistoryPosition = { index: indexOf(history), furthest: indexOf(history) };
  const listeners = new Set<() => void>();
  history.subscribe(({ action }) => {
    const next = nextHistoryPosition(position, action.type, indexOf(history));
    if (next.index === position.index && next.furthest === position.furthest) return;
    position = next;
    for (const listener of listeners) listener();
  });
  const tracker: HistoryTracker = {
    read: () => position,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  trackers.set(history, tracker);
  return tracker;
}

/**
 * Back and forward through the app's own pages (the title row's arrows, the
 * Go menu and their shortcuts). Each says whether it has anywhere to go: the
 * first page the window opened on has no back, and nothing has a forward
 * until the user went back from somewhere.
 */
export function useAppHistory(): {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly back: () => void;
  readonly forward: () => void;
} {
  const router = useRouter();
  const tracker = trackerFor(router.history);
  const position = useSyncExternalStore(tracker.subscribe, tracker.read, tracker.read);
  const canGoBack = position.index > 0;
  const canGoForward = position.index < position.furthest;
  const back = useCallback(() => {
    if (trackerFor(router.history).read().index > 0) router.history.back();
  }, [router]);
  const forward = useCallback(() => {
    const current = trackerFor(router.history).read();
    if (current.index < current.furthest) router.history.forward();
  }, [router]);
  return { canGoBack, canGoForward, back, forward };
}
