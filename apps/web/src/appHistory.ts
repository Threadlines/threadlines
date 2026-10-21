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

/**
 * Where the app stands when it starts on the entry at `index`: after a reload,
 * the furthest entry the previous page load reached (kept in session storage)
 * is still there to go forward to.
 */
export function initialHistoryPosition(
  index: number,
  storedFurthest: number | null,
): HistoryPosition {
  return { index, furthest: Math.max(index, storedFurthest ?? index) };
}

interface HistoryTracker {
  readonly read: () => HistoryPosition;
  readonly subscribe: (listener: () => void) => () => void;
}

function indexOf(history: RouterHistory): number {
  return history.location.state.__TSR_index ?? 0;
}

// The furthest entry survives a reload in session storage, which lives
// exactly as long as the browser history it describes (one tab or window).
const FURTHEST_STORAGE_KEY = "threadlines:app-history-furthest";

function readStoredFurthest(): number | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(FURTHEST_STORAGE_KEY);
    const value = raw == null ? Number.NaN : Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function storeFurthest(furthest: number): void {
  try {
    globalThis.sessionStorage?.setItem(FURTHEST_STORAGE_KEY, String(furthest));
  } catch {
    // Storage can be unavailable (private modes); forward then resets on reload.
  }
}

// One per history, kept for its life: the first reader starts it, so it has
// seen every move since the window opened (and, through session storage,
// how far forward the entries went before a reload).
const trackers = new WeakMap<RouterHistory, HistoryTracker>();

function trackerFor(history: RouterHistory): HistoryTracker {
  const existing = trackers.get(history);
  if (existing) return existing;
  let position = initialHistoryPosition(indexOf(history), readStoredFurthest());
  storeFurthest(position.furthest);
  const listeners = new Set<() => void>();
  history.subscribe(({ action }) => {
    const next = nextHistoryPosition(position, action.type, indexOf(history));
    if (next.index === position.index && next.furthest === position.furthest) return;
    position = next;
    storeFurthest(position.furthest);
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
