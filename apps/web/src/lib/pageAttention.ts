import { COMPUTER_IN_USE_MS } from "@threadlines/shared/phoneAlerts";
import { createContext, useContext, useEffect, useState } from "react";

/**
 * Whether the user can be looking at this page: it is on screen and its window
 * has focus. In the desktop app the window answers for itself, because inside
 * the page focus moving into a browser panel (<webview>) reads the same as the
 * user leaving the app.
 */
export function isPageAttended(): boolean {
  if (document.visibilityState !== "visible") return false;
  return window.desktopBridge?.isWindowFocused?.() ?? document.hasFocus();
}

/** Calls `listener` whenever {@link isPageAttended} may have changed. */
export function onPageAttentionChange(listener: () => void): () => void {
  window.addEventListener("focus", listener);
  // A window can lose focus while it stays visible (another app in front).
  window.addEventListener("blur", listener);
  document.addEventListener("visibilitychange", listener);
  const stopWindowFocus = window.desktopBridge?.onWindowFocusChange?.(listener);
  return () => {
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
    document.removeEventListener("visibilitychange", listener);
    stopWindowFocus?.();
  };
}

/** {@link isPageAttended}, kept current for a component. */
export function usePageAttended(): boolean {
  const [attended, setAttended] = useState(isPageAttended);
  useEffect(() => {
    const sync = () => setAttended(isPageAttended());
    // It may have changed between the first render and this effect.
    sync();
    return onPageAttentionChange(sync);
  }, []);
  return attended;
}

/** When someone last touched this window, by this page's clock. Loading it counts. */
let lastUsedAt = Date.now();
const useListeners = new Set<() => void>();
let stopUseTracking: (() => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Hovering in passing isn't using it: the two kinds of input that need the window in front. */
const PASSING_INPUT = new Set(["pointermove", "wheel"]);
const INPUT_EVENTS = ["keydown", "pointerdown", "touchstart", "pointermove", "wheel"] as const;
/** How often the desktop app asks about input this page can't hear. */
const SYSTEM_IDLE_POLL_MS = 30_000;

/**
 * After the clock steps back, the last touch reads as still ahead, which would
 * keep an empty chair "in use" for as long as the step. Past a small skew it
 * says nothing, so the page counts as idle until the next touch.
 */
const CLOCK_SKEW_MS = 60_000;
const forgetTouchFromTheFuture = (now: number) => {
  if (lastUsedAt > now + CLOCK_SKEW_MS) lastUsedAt = now - COMPUTER_IN_USE_MS;
};

/** How long the idle timer sleeps at most, so a clock change is noticed soon after. */
const IDLE_RECHECK_MS = 60_000;

const armIdleTimer = () => {
  if (idleTimer !== null) clearTimeout(idleTimer);
  const left = lastUsedAt + COMPUTER_IN_USE_MS - Date.now();
  idleTimer = setTimeout(
    () => {
      idleTimer = null;
      const now = Date.now();
      forgetTouchFromTheFuture(now);
      if (now - lastUsedAt >= COMPUTER_IN_USE_MS) {
        for (const listener of useListeners) listener();
      } else {
        armIdleTimer();
      }
    },
    Math.min(Math.max(left, 0), IDLE_RECHECK_MS),
  );
};

const noteUsedAt = (at: number) => {
  const now = Date.now();
  forgetTouchFromTheFuture(now);
  if (at <= lastUsedAt) return;
  const wasIdle = now - lastUsedAt >= COMPUTER_IN_USE_MS;
  lastUsedAt = at;
  // The timer sees the new time when it fires, so only an idle page needs a new one.
  if (idleTimer === null) armIdleTimer();
  if (wasIdle) for (const listener of useListeners) listener();
};

function startUseTracking(): () => void {
  const onInput = (event: Event) => {
    const now = Date.now();
    // A mouse sends these many times a second: the cheap check comes first.
    if (Math.abs(now - lastUsedAt) < 1_000) return;
    if (PASSING_INPUT.has(event.type) && !isPageAttended()) return;
    noteUsedAt(now);
  };
  const options = { capture: true, passive: true };
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, options);
  // Keys and clicks inside the browser panel (<webview>) never reach this page.
  // While this window has focus, they are what the computer's idle time measures.
  const readSystemIdle = window.desktopBridge?.getSystemIdleMs;
  const poll = readSystemIdle
    ? setInterval(() => {
        if (!isPageAttended()) return;
        void readSystemIdle()
          .then((idleMs) => noteUsedAt(Date.now() - idleMs))
          .catch(() => undefined);
      }, SYSTEM_IDLE_POLL_MS)
    : null;
  armIdleTimer();
  return () => {
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, options);
    if (poll !== null) clearInterval(poll);
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };
}

/** Milliseconds since someone last touched this window (once anything is listening). */
export function pageIdleMs(): number {
  const now = Date.now();
  forgetTouchFromTheFuture(now);
  return Math.max(0, now - lastUsedAt);
}

/**
 * Whether someone is using this page: it is attended, and they touched it
 * within COMPUTER_IN_USE_MS. A window left in front of an empty chair is
 * attended for hours, and nobody is looking at what it shows.
 */
export function isPageInUse(): boolean {
  return isPageAttended() && pageIdleMs() < COMPUTER_IN_USE_MS;
}

/**
 * Calls `listener` when someone starts or stops using this page, or when
 * {@link isPageAttended} may have changed. Starting to listen is what starts
 * watching for input.
 */
export function onPageUseChange(listener: () => void): () => void {
  useListeners.add(listener);
  stopUseTracking ??= startUseTracking();
  const stopAttention = onPageAttentionChange(listener);
  return () => {
    stopAttention();
    useListeners.delete(listener);
    if (useListeners.size === 0) {
      stopUseTracking?.();
      stopUseTracking = null;
    }
  };
}

/** {@link isPageInUse}, kept current for a component. */
export function usePageInUse(): boolean {
  const [inUse, setInUse] = useState(isPageInUse);
  useEffect(() => {
    const sync = () => setInUse(isPageInUse());
    sync();
    return onPageUseChange(sync);
  }, []);
  return inUse;
}

/**
 * False inside a part of the page that stays mounted while hidden: the chat
 * column the expanded browser panel covers. What it shows stops polling.
 */
export const SurfaceShownContext = createContext(true);

/** Whether the user can be looking at this part of the page: the page is attended and the part shown. */
export function useSurfaceAttended(): boolean {
  const shown = useContext(SurfaceShownContext);
  return usePageAttended() && shown;
}
