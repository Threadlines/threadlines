import { type CSSProperties, useCallback, useSyncExternalStore } from "react";

import { readVisualViewportInset, type VisualViewportEdge } from "~/lib/onScreenKeyboard";

function getServerSnapshot(): number {
  return 0;
}

function useVisualViewportInset(edge: VisualViewportEdge, enabled: boolean): number {
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
    return readVisualViewportInset(edge);
  }, [edge, enabled]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
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
  return useVisualViewportInset("bottom", enabled);
}

/**
 * The part of the layout viewport an on-screen keyboard leaves visible, as
 * CSS variables for an overlay pinned to the whole window (`inset-0`) to pad
 * itself by: `--keyboard-inset-bottom` is what the keyboard covers, and
 * `--keyboard-inset-top` is how far iOS Safari scrolled the page up to show a
 * focused field above it. Both are 0px without a keyboard and while
 * pinch-zoomed.
 */
export function useOnScreenKeyboardInsetVars(enabled: boolean): CSSProperties {
  const top = useVisualViewportInset("top", enabled);
  const bottom = useVisualViewportInset("bottom", enabled);
  return {
    "--keyboard-inset-top": `${top}px`,
    "--keyboard-inset-bottom": `${bottom}px`,
  } as CSSProperties;
}
