/**
 * Where focus goes when a dialog opened from somewhere else closes: the
 * element that opened it (a sidebar or setup button), or a function for a
 * place that has no element to hold, like the composer when the command
 * palette handed over to the dialog.
 */
export type DialogReturnFocus = HTMLElement | (() => void);

/** The element focused right now, to return to later; null when nothing is. */
export function captureReturnFocus(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * The dialog's `finalFocus` answer. An element that left the page (a sheet
 * that closed) falls back to the dialog's own default.
 */
export function resolveDialogReturnFocus(
  returnFocus: DialogReturnFocus | null,
): HTMLElement | boolean {
  if (returnFocus === null) return true;
  if (typeof returnFocus === "function") {
    returnFocus();
    return false;
  }
  return returnFocus.isConnected ? returnFocus : true;
}
