import { useMemo } from "react";

import { createWindowDragPress, type WindowDragPressHandlers } from "../lib/windowDragPress";

/**
 * Press-and-drag on a header button moves the desktop window (see
 * windowDragPress). Spread the result on the button. Null outside the
 * desktop app, where the desktop app can't move its window (Linux under
 * Wayland), or on a desktop build without the bridge calls: the button then
 * behaves exactly as it always did.
 */
export function useWindowDragPress(): WindowDragPressHandlers | null {
  return useMemo(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    const setDragging = bridge?.setWindowDragging;
    return setDragging && bridge?.canMoveWindow?.() === true
      ? createWindowDragPress(setDragging)
      : null;
  }, []);
}
