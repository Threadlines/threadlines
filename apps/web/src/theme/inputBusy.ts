import { useEffect, useState } from "react";

/** Input this recent counts as busy; the backdrop runtime adds its own 400 ms hold. */
export const INPUT_BUSY_QUIET_MS = 150;

/**
 * The user is scrolling, typing, dragging or resizing, or did within the
 * last moment. The theme's art holds still while it's true
 * (ThemeBackdropLayer.tsx), so the app always wins.
 */
export function useInputBusy(): boolean {
  const [inputBusy, setInputBusy] = useState(false);
  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    const mark = () => {
      if (!busy) {
        busy = true;
        setInputBusy(true);
      }
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(() => {
        quiet = null;
        busy = false;
        setInputBusy(false);
      }, INPUT_BUSY_QUIET_MS);
    };
    const onPointerMove = (event: PointerEvent) => {
      // Dragging: a divider, the list's edge, a selection, a scrollbar.
      if (event.buttons !== 0) mark();
    };
    // The user's own scrolling arrives as wheel (trackpad momentum included),
    // keys, touch and scrollbar drags. Scroll events alone aren't input: the
    // chat scrolls itself while it follows a reply streaming in.
    const options = { capture: true, passive: true } as const;
    document.addEventListener("wheel", mark, options);
    document.addEventListener("touchmove", mark, options);
    document.addEventListener("keydown", mark, options);
    document.addEventListener("input", mark, options);
    document.addEventListener("pointermove", onPointerMove, options);
    window.addEventListener("resize", mark);
    return () => {
      if (quiet !== null) clearTimeout(quiet);
      document.removeEventListener("wheel", mark, options);
      document.removeEventListener("touchmove", mark, options);
      document.removeEventListener("keydown", mark, options);
      document.removeEventListener("input", mark, options);
      document.removeEventListener("pointermove", onPointerMove, options);
      window.removeEventListener("resize", mark);
    };
  }, []);
  return inputBusy;
}
