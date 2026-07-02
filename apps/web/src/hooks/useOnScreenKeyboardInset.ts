import { useCallback, useSyncExternalStore } from "react";

function getServerSnapshot(): number {
  return 0;
}

function readKeyboardInset(): number {
  const viewport = window.visualViewport;
  if (!viewport) {
    return 0;
  }
  // Pinch zoom also shrinks the visual viewport; only a 1:1 scale reliably
  // means the height delta comes from the on-screen keyboard.
  if (Math.abs(viewport.scale - 1) > 0.01) {
    return 0;
  }
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/**
 * Height (px) of the layout viewport's bottom edge covered by the on-screen
 * keyboard. Non-zero only on browsers where the keyboard overlays the page
 * instead of resizing it (iOS Safari); with `interactive-widget=
 * resizes-content` honored (Android Chrome) the layout viewport shrinks and
 * this stays 0. Pass `enabled: false` to skip the viewport listeners while
 * the caller's overlay is closed.
 */
export function useOnScreenKeyboardInset(enabled: boolean): number {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!enabled || typeof window === "undefined") return () => {};
      const viewport = window.visualViewport;
      if (!viewport) return () => {};
      viewport.addEventListener("resize", callback);
      viewport.addEventListener("scroll", callback);
      return () => {
        viewport.removeEventListener("resize", callback);
        viewport.removeEventListener("scroll", callback);
      };
    },
    [enabled],
  );

  const getSnapshot = useCallback(() => {
    if (!enabled || typeof window === "undefined") return 0;
    return readKeyboardInset();
  }, [enabled]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
