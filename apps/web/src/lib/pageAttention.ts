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
