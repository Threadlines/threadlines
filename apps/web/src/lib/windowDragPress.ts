/**
 * Press and drag on a header control that is also a button (the project
 * name, the thread title) moves the desktop window; a plain click still
 * does what the button does. The buttons can't sit in the window's drag
 * area, so the desktop app moves the window itself while the page says a
 * drag is on (`setWindowDragging` on the desktop bridge).
 *
 * A primary press is captured, so the moves keep coming outside the button.
 * Past DRAG_START_PX it becomes a drag: the desktop app starts following the
 * cursor, and the click that ends it is swallowed so the menu stays shut.
 * Its release, a cancel, or losing the capture stops the move. The press
 * itself keeps the browser from turning it into a mouse press, so a menu
 * that would open on mousedown waits for the click instead. The keyboard
 * isn't involved: Enter and Space click as before.
 *
 * @module windowDragPress
 */

/** How far a press moves before it is a drag rather than a click, in CSS px. */
export const DRAG_START_PX = 4;

interface PressEvent {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface PointerDownEvent extends PressEvent {
  readonly button: number;
  readonly isPrimary: boolean;
  readonly currentTarget: { setPointerCapture: (pointerId: number) => void };
  preventDefault: () => void;
}

interface ClickEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface WindowDragPressHandlers {
  readonly onPointerDown: (event: PointerDownEvent) => void;
  readonly onPointerMove: (event: PressEvent) => void;
  readonly onPointerUp: (event: PressEvent) => void;
  readonly onPointerCancel: (event: PressEvent) => void;
  readonly onLostPointerCapture: (event: PressEvent) => void;
  readonly onClickCapture: (event: ClickEvent) => void;
}

/** The handlers for one control; `setDragging` is the desktop bridge's. */
export function createWindowDragPress(
  setDragging: (dragging: boolean) => Promise<void>,
): WindowDragPressHandlers {
  let press: { pointerId: number; x: number; y: number; dragging: boolean } | null = null;
  // The click after a release that ended a drag isn't a click.
  let swallowClick = false;

  const tell = (dragging: boolean) => {
    void setDragging(dragging).catch(() => undefined);
  };

  const end = (event: PressEvent, { released }: { readonly released: boolean }) => {
    if (press === null || press.pointerId !== event.pointerId) return;
    if (press.dragging) {
      tell(false);
      // Only a release is followed by a click.
      if (released) swallowClick = true;
    }
    press = null;
  };

  return {
    onPointerDown: (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      swallowClick = false;
    },
    onPointerMove: (event) => {
      if (press === null || press.dragging || press.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= DRAG_START_PX) return;
      press.dragging = true;
      tell(true);
    },
    onPointerUp: (event) => end(event, { released: true }),
    onPointerCancel: (event) => end(event, { released: false }),
    onLostPointerCapture: (event) => end(event, { released: false }),
    onClickCapture: (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
