/**
 * Clipboard access for every surface in the app, including insecure ones.
 *
 * `navigator.clipboard` is a secure-context API. A phone paired over plain
 * `http://<lan-ip>:<port>` does not get it, which used to leave those surfaces
 * with no copy affordance at all. `document.execCommand("copy")` is deprecated
 * but still works in insecure contexts, so it is the fallback. When neither is
 * available the caller is expected to reveal the value so the user can select
 * it by hand.
 */

export class ClipboardUnavailableError extends Error {
  constructor() {
    super("Clipboard copy is unavailable in this browser context.");
    this.name = "ClipboardUnavailableError";
  }
}

function hasAsyncClipboard(): boolean {
  return typeof navigator !== "undefined" && navigator.clipboard?.writeText != null;
}

function hasExecCommandCopy(): boolean {
  return typeof document !== "undefined" && typeof document.execCommand === "function";
}

/**
 * Whether a copy action can be offered at all. False only when the browser has
 * neither the async Clipboard API nor `execCommand`, in which case UI should
 * show the value instead of a copy button.
 */
export function isClipboardCopySupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return hasAsyncClipboard() || hasExecCommandCopy();
}

function copyWithExecCommand(value: string): boolean {
  if (!hasExecCommandCopy()) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  // Keep the node off-screen but still selectable: `display: none` and
  // `visibility: hidden` both make the selection (and therefore the copy) fail.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);

  const previousSelectionRange =
    (document.getSelection()?.rangeCount ?? 0) > 0
      ? document.getSelection()?.getRangeAt(0)
      : undefined;
  const previouslyFocused = document.activeElement;

  try {
    // `execCommand("copy")` copies the document selection, and the browser only
    // honours it while the copying element owns focus.
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousSelectionRange) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(previousSelectionRange);
    }
    if (previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}

/**
 * Copies `value`, preferring the async Clipboard API and falling back to
 * `execCommand`. Rejects with {@link ClipboardUnavailableError} when neither
 * path can copy, so callers can reveal the value instead.
 */
export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof window === "undefined") {
    throw new ClipboardUnavailableError();
  }

  if (hasAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      // Permission-denied and non-user-gesture failures are recoverable via
      // execCommand, so only give up once that has been tried too.
      if (!copyWithExecCommand(value)) {
        throw error instanceof Error ? error : new ClipboardUnavailableError();
      }
      return;
    }
  }

  if (!copyWithExecCommand(value)) {
    throw new ClipboardUnavailableError();
  }
}
