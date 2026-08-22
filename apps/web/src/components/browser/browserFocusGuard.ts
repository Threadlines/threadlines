/**
 * Keeps agent-driven browser work from moving the user's focus.
 *
 * The input an agent dispatches into a guest page never touches the host
 * document, but one consequence of it does: when a click or script focuses an
 * element inside the guest, Chromium advances focus to the <webview> element
 * in the embedding page, which blurs whatever the user was typing into. The
 * guest cannot be told not to do this, so the host undoes it instead: focus
 * that lands on a webview with no recent sign of the user wanting it there is
 * put back where it was.
 *
 * Watched from the losing side (focusout on the blurred element), not the
 * winning one: Chromium does not reliably fire focus events on the embedding
 * element when focus enters guest content, but the element being robbed
 * always hears about it.
 *
 * "The user wanting it there" is any of: a pointer or key press inside the
 * browser panel (the panel reports those via noteBrowserUserIntent -- a click
 * elsewhere in the app says nothing about the webview), a Tab keypress
 * (keyboard navigation), or real input inside the guest page itself. That
 * last one is invisible to the host document, so the main process reports it
 * (onPreviewUserControl) and the guard listens for it directly.
 */

/** How long a sign of user intent keeps the webview's focus legitimate. */
const USER_INTENT_WINDOW_MS = 400;
/**
 * A real user click inside the guest announces itself over IPC a beat after
 * the focus moves; the restore waits long enough to hear it before deciding
 * the focus was stolen.
 */
const RESTORE_DELAY_MS = 80;
/**
 * A page that re-grabs focus as fast as it is returned wins. Fighting it
 * forever would turn one stolen focus into a metronome.
 */
const MAX_RESTORES = 4;
const RESTORE_BUDGET_WINDOW_MS = 2_000;

let lastUserIntentAt = 0;

/** Call when the user demonstrably meant to interact with the browser panel. */
export function noteBrowserUserIntent(): void {
  lastUserIntentAt = Date.now();
}

function isWebview(node: unknown): boolean {
  return node instanceof HTMLElement && node.tagName === "WEBVIEW";
}

function listen(doc: Document): () => void {
  const restoresAt: number[] = [];
  let pending: number | null = null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab") noteBrowserUserIntent();
  };
  const onFocusOut = (event: FocusEvent) => {
    const robbed = event.target;
    // A webview losing focus is the restore itself, or the user moving on;
    // either way not a theft.
    if (!(robbed instanceof HTMLElement) || isWebview(robbed)) {
      return;
    }
    if (Date.now() - lastUserIntentAt < USER_INTENT_WINDOW_MS) {
      return;
    }
    const intentAtBlur = lastUserIntentAt;
    if (pending !== null) window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      // Only a blur that resolved to a webview holding the focus is the bug;
      // focus that went to another element -- or nowhere -- is left alone.
      if (!isWebview(doc.activeElement)) return;
      // Intent that arrived while waiting -- the IPC report of a click inside
      // the guest, most likely -- makes this the user's focus, not a theft.
      if (lastUserIntentAt !== intentAtBlur) return;
      if (!robbed.isConnected) return;
      const now = Date.now();
      while (restoresAt.length > 0 && now - restoresAt[0]! > RESTORE_BUDGET_WINDOW_MS) {
        restoresAt.shift();
      }
      if (restoresAt.length >= MAX_RESTORES) return;
      restoresAt.push(now);
      robbed.focus({ preventScroll: true });
    }, RESTORE_DELAY_MS);
  };

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusout", onFocusOut, true);
  const unsubscribeUserControl = window.desktopBridge?.onPreviewUserControl?.(() => {
    noteBrowserUserIntent();
  });
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    unsubscribeUserControl?.();
    if (pending !== null) window.clearTimeout(pending);
  };
}

let installs = 0;
let uninstall: (() => void) | null = null;

/**
 * Watches the document for a webview ending up with the focus and restores
 * what the user had. Reference-counted so any number of panels share one set
 * of listeners; the returned cleanup releases this caller's hold.
 */
export function installBrowserFocusGuard(doc: Document = document): () => void {
  installs += 1;
  if (installs === 1) {
    uninstall = listen(doc);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) {
      uninstall?.();
      uninstall = null;
    }
  };
}
