import { useMemo } from "react";

import { createWindowDragPress, type WindowDragPressHandlers } from "../lib/windowDragPress";

/**
 * Press-and-drag on a header button moves the desktop window (see
 * windowDragPress). Spread the result on the button. Null outside the
 * desktop app, or on a desktop build without the bridge call: the button
 * then behaves exactly as it always did.
 */
export function useWindowDragPress(): WindowDragPressHandlers | null {
  return useMemo(() => {
    const setDragging =
      typeof window === "undefined" ? undefined : window.desktopBridge?.setWindowDragging;
    return setDragging ? createWindowDragPress(setDragging) : null;
  }, []);
}
