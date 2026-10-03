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
 * (keyboard navigation), or a pointer press inside the guest page itself.
 * That last one is invisible to the host document, so the main process
 * reports it (onPreviewUserControl) and the guard listens for it directly.
 * Keys and wheel turns in the guest are not intent: they reach the page only
 * once it holds focus, and while focus is stolen they are simply the user
 * still typing.
 *
 * While an agent is acting (holdFocusForAgent), a grab is put back on the next
 * task instead of after the wait, since every moment spent waiting is a
 * keystroke typed into the page. A user's own click that lands in that moment
 * announces itself just after, and the focus is handed back to the page.
 */

/** How long a sign of user intent keeps the webview's focus legitimate. */
const USER_INTENT_WINDOW_MS = 400;
/**
 * A real user click inside the guest announces itself over IPC a beat after
 * the focus moves; the restore waits long enough to hear it before deciding
 * the focus was stolen.
 */
const RESTORE_DELAY_MS = 80;
/** How often a look that found focus nowhere looks again: about a frame. */
const RECHECK_MS = 16;
/**
 * How long after an agent action ends a grab is still put down to it: pages
 * often focus a field a frame or two after the click that opened it.
 */
const AGENT_TAIL_MS = 500;
/**
 * How late the report of a user's click inside the guest may arrive and still
 * undo a restore it raced.
 */
const GIVE_BACK_WINDOW_MS = 300;
/**
 * A page that re-grabs focus as fast as it is returned wins. Fighting it
 * forever would turn one stolen focus into a metronome.
 */
const MAX_RESTORES = 4;
const RESTORE_BUDGET_WINDOW_MS = 2_000;

let lastUserIntentAt = 0;
let agentHolds = 0;
let agentTailUntil = 0;

/** Call when the user demonstrably meant to interact with the browser panel. */
export function noteBrowserUserIntent(): void {
  lastUserIntentAt = Date.now();
}

/**
 * Marks an agent action in progress, so focus it pulls onto a webview comes
 * back at once. The returned call ends the hold; calling it twice is harmless.
 */
export function holdFocusForAgent(): () => void {
  agentHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    agentHolds -= 1;
    agentTailUntil = Date.now() + AGENT_TAIL_MS;
  };
}

function isAgentActing(): boolean {
  return agentHolds > 0 || Date.now() < agentTailUntil;
}

type WebviewElement = HTMLElement & {
  readonly tagName: "WEBVIEW";
  readonly getWebContentsId?: () => number;
};

function isWebview(node: unknown): node is WebviewElement {
  return node instanceof HTMLElement && node.tagName === "WEBVIEW";
}

/** The guest behind a webview element, or null before it attaches. */
function webContentsIdOf(webview: WebviewElement): number | null {
  try {
    return webview.getWebContentsId?.() ?? null;
  } catch {
    return null;
  }
}

function listen(doc: Document): () => void {
  const restoresAt: number[] = [];
  let pending: number | null = null;
  let lastRestore: {
    readonly webview: WebviewElement;
    readonly restoredTo: HTMLElement;
    readonly at: number;
  } | null = null;

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
    const blurredAt = Date.now();
    if (blurredAt - lastUserIntentAt < USER_INTENT_WINDOW_MS) {
      return;
    }
    const intentAtBlur = lastUserIntentAt;
    const settle = () => {
      pending = null;
      // Only a blur that resolved to a webview holding the focus is the bug;
      // focus that went to another element is left alone. Focus can pass
      // through nowhere on its way into a guest, so finding it nowhere means
      // looking again until the full wait is up.
      const thief = doc.activeElement;
      if (!isWebview(thief)) {
        if ((thief === null || thief === doc.body) && Date.now() - blurredAt < RESTORE_DELAY_MS) {
          pending = window.setTimeout(settle, RECHECK_MS);
        }
        return;
      }
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
      lastRestore = { webview: thief, restoredTo: robbed, at: now };
      robbed.focus({ preventScroll: true });
    };
    if (pending !== null) window.clearTimeout(pending);
    // While an agent acts, look at once -- unless this grab follows the last
    // restore within one wait. That is the page taking focus straight back,
    // and the full wait lets a run of such grabs cost one restore rather than
    // the whole budget.
    const lastRestoredAt = restoresAt.at(-1);
    const regrab = lastRestoredAt !== undefined && blurredAt - lastRestoredAt < RESTORE_DELAY_MS;
    pending = window.setTimeout(settle, isAgentActing() && !regrab ? 0 : RESTORE_DELAY_MS);
  };
  // A click in the page that a restore beat to the punch: the user meant to be
  // there, so the page gets its focus back.
  const giveBack = (webContentsId: number) => {
    const restore = lastRestore;
    lastRestore = null;
    if (restore === null || Date.now() - restore.at > GIVE_BACK_WINDOW_MS) return;
    // Focus that has moved on since the restore is the user's newer choice.
    if (doc.activeElement !== restore.restoredTo) return;
    if (!restore.webview.isConnected || webContentsIdOf(restore.webview) !== webContentsId) {
      return;
    }
    restore.webview.focus({ preventScroll: true });
  };

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusout", onFocusOut, true);
  const unsubscribeUserControl = window.desktopBridge?.onPreviewUserControl?.((control) => {
    if (control.input !== "pointer") return;
    // Noted first, so the blur the give-back causes reads as the user's doing.
    noteBrowserUserIntent();
    giveBack(control.webContentsId);
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
