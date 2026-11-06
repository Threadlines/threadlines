import { useEffect, useState } from "react";

/** A resize or divider drag this recent counts as busy; the backdrop runtime adds its own 400 ms hold. */
export const LAYOUT_BUSY_QUIET_MS = 150;

/** Where a drag reshapes the layout: the dividers between panes and the sidebar's edge. */
const DIVIDER_SELECTOR = '[role="separator"], [data-slot="sidebar-rail"]';

/**
 * The user is resizing the window or dragging a divider, or did within the
 * last moment. The theme's art holds still while it's true
 * (ThemeBackdropLayer.tsx): the layout changes every step, and the art's
 * canvas with the window.
 *
 * Typing and scrolling don't count. The art runs in its own process and
 * costs the app nothing measurable while the user types or scrolls, and
 * stopping it there was the most visible thing about it.
 */
export function useLayoutBusy(): boolean {
  const [layoutBusy, setLayoutBusy] = useState(false);
  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    let onDivider = false;
    const mark = () => {
      if (!busy) {
        busy = true;
        setLayoutBusy(true);
      }
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(() => {
        quiet = null;
        busy = false;
        setLayoutBusy(false);
      }, LAYOUT_BUSY_QUIET_MS);
    };
    const onPointerDown = (event: PointerEvent) => {
      onDivider =
        event.target instanceof Element && event.target.closest(DIVIDER_SELECTOR) !== null;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (onDivider && event.buttons !== 0) mark();
    };
    const onPointerEnd = () => {
      onDivider = false;
    };
    const options = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", onPointerDown, options);
    document.addEventListener("pointermove", onPointerMove, options);
    document.addEventListener("pointerup", onPointerEnd, options);
    document.addEventListener("pointercancel", onPointerEnd, options);
    window.addEventListener("resize", mark);
    return () => {
      if (quiet !== null) clearTimeout(quiet);
      document.removeEventListener("pointerdown", onPointerDown, options);
      document.removeEventListener("pointermove", onPointerMove, options);
      document.removeEventListener("pointerup", onPointerEnd, options);
      document.removeEventListener("pointercancel", onPointerEnd, options);
      window.removeEventListener("resize", mark);
    };
  }, []);
  return layoutBusy;
}
