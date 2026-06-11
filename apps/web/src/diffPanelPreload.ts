/**
 * Warms the lazy DiffPanel chunk before the user opens a diff, so the
 * source-control-to-diff transition skips the Suspense skeleton. Safe to call
 * repeatedly; the import is requested once per session.
 */
let diffPanelPreloadRequested = false;

export function preloadDiffPanel(): void {
  if (diffPanelPreloadRequested) {
    return;
  }
  diffPanelPreloadRequested = true;
  void import("./components/DiffPanel");
}

/** Idle-schedules the preload; returns a cancel function for effect cleanup. */
export function schedulePreloadDiffPanel(): () => void {
  if (diffPanelPreloadRequested || typeof window === "undefined") {
    return () => undefined;
  }
  if (typeof window.requestIdleCallback === "function") {
    const idleId = window.requestIdleCallback(() => preloadDiffPanel(), { timeout: 2_000 });
    return () => window.cancelIdleCallback(idleId);
  }
  const timeoutId = window.setTimeout(() => preloadDiffPanel(), 350);
  return () => window.clearTimeout(timeoutId);
}
