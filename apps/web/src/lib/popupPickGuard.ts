/**
 * Everything that floats over the page and goes away once it has been used.
 * Hover surfaces (tooltips, preview cards) and toasts are left out: nobody
 * picks from them, and what sits under them is meant to stay clickable.
 */
const VANISHING_POPUP_SELECTOR = [
  "alert-dialog-popup",
  "autocomplete-popup",
  "combobox-popup",
  "command-dialog-popup",
  "composer-command-menu",
  "dialog-popup",
  "drawer-popup",
  "menu-popup",
  "menu-sub-content",
  "popover-popup",
  "select-popup",
  "sheet-popup",
  "transcript-selection-popover",
]
  .map((slot) => `[data-slot="${slot}"]`)
  // Our own full-window viewers (a file preview, an expanded image) have no slot.
  .concat('[role="dialog"]')
  .join(",");

/** The longest double-click Windows allows by default; macOS is close to it. */
const SECOND_PRESS_WINDOW_MS = 500;
/** A double-click barely moves. Further than this is someone aiming elsewhere. */
const SECOND_PRESS_RADIUS_PX = 8;

interface PopupClick {
  readonly popup: Element;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

function isSecondPress(click: PopupClick, press: PointerEvent): boolean {
  // A popup still open (a checkbox menu, a panel) takes repeat clicks as usual.
  // A closed one can stay in the page, as a dropdown's does, so it says closed.
  const popupGone = !click.popup.isConnected || click.popup.hasAttribute("data-closed");
  return (
    popupGone &&
    press.timeStamp - click.at <= SECOND_PRESS_WINDOW_MS &&
    Math.hypot(press.clientX - click.x, press.clientY - click.y) <= SECOND_PRESS_RADIUS_PX
  );
}

function swallow(event: Event): void {
  event.stopImmediatePropagation();
  event.preventDefault();
}

/**
 * A double-click on a popup's row picks on the first click and closes the
 * popup, which leaves the second click to land on whatever was underneath: a
 * thread row, a link, a confirm button. This swallows that second press whole,
 * for every popup in the app, so it neither activates what is under the pointer
 * nor dismisses a panel that is still open. Listens on the window in the capture
 * phase, ahead of React and every popup's own handlers. Returns the way to undo it.
 */
export function installPopupPickGuard(): () => void {
  let lastClick: PopupClick | null = null;
  let swallowingPress = false;

  const onPointerDown = (event: PointerEvent) => {
    swallowingPress = event.button === 0 && lastClick !== null && isSecondPress(lastClick, event);
    if (swallowingPress) swallow(event);
  };
  const onRestOfPress = (event: Event) => {
    if (swallowingPress) swallow(event);
  };
  const onClick = (event: MouseEvent) => {
    // No pointer behind it (`detail` 0) means a keyboard or a script, which a
    // press abandoned by dragging away must not eat.
    if (event.detail === 0) return;
    if (swallowingPress) {
      swallow(event);
      return;
    }
    const popup =
      event.isTrusted && event.target instanceof Element
        ? event.target.closest(VANISHING_POPUP_SELECTOR)
        : null;
    if (popup) {
      lastClick = { popup, x: event.clientX, y: event.clientY, at: event.timeStamp };
    }
  };

  const restOfPress = ["mousedown", "pointerup", "mouseup", "dblclick"] as const;
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("click", onClick, true);
  for (const type of restOfPress) window.addEventListener(type, onRestOfPress, true);
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("click", onClick, true);
    for (const type of restOfPress) window.removeEventListener(type, onRestOfPress, true);
  };
}
