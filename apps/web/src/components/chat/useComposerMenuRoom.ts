import { type RefObject, useLayoutEffect, useState } from "react";

/** The command menu's list at full height (`max-h-72`). */
const MENU_FULL_HEIGHT_PX = 288;
/** One row. Below this there is no list to speak of, whatever the room. */
const MENU_MIN_HEIGHT_PX = 40;
/** The menu's own margin above the editor, plus air under the column's top edge. */
const MENU_GAP_PX = 16;

function roomAbove(anchor: HTMLElement, column: HTMLElement | null): number {
  const columnTop = column ? column.getBoundingClientRect().top : 0;
  return anchor.getBoundingClientRect().top - columnTop - MENU_GAP_PX;
}

/**
 * How tall the composer's command menu may be while it is open, or null while
 * it is closed.
 *
 * The menu opens upward from the editor and is not portalled, so the chat
 * column bounds it. With the composer at the bottom of a thread there is
 * always room. In the new-thread hero the composer sits mid-column and the
 * column scrolls, so the room above is measured. On opening, the column is
 * scrolled back to make as much of it as there is; after that the cap follows
 * the room as the column is scrolled or the pane changes size.
 */
export function useComposerMenuRoom(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): number | null {
  const [room, setRoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) {
      return;
    }
    const column = anchor.closest<HTMLElement>("[data-chat-column]");
    const measure = () => {
      setRoom(
        Math.max(
          MENU_MIN_HEIGHT_PX,
          Math.min(MENU_FULL_HEIGHT_PX, Math.floor(roomAbove(anchor, column))),
        ),
      );
    };

    const available = roomAbove(anchor, column);
    if (column && available < MENU_FULL_HEIGHT_PX && column.scrollTop > 0) {
      column.scrollTop -= Math.min(column.scrollTop, MENU_FULL_HEIGHT_PX - available);
    }
    measure();

    // The window, the terminal and the pane dividers all resize the column;
    // the composer growing a line moves the anchor inside it.
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    if (column) {
      observer.observe(column);
      column.addEventListener("scroll", measure, { passive: true });
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      column?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, open]);

  // A measurement left over from the last time it was open says nothing now.
  return open ? room : null;
}
