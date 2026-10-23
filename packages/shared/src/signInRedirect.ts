/**
 * Sign-in pages that send the browser back to the signing-in computer's own
 * loopback address: an OAuth `redirect_uri` like `codex login`'s
 * `http://localhost:1455/auth/callback`. A browser on another device ends on
 * an address it can't reach; the computer running the sign-in can take that
 * address pasted and replay it to its own listener.
 *
 * @module signInRedirect
 */

/** The redirect a sign-in waits on: where its listener is, and the attempt's `state`. */
export interface LoopbackRedirect {
  readonly redirect: URL;
  readonly state: string;
}

/** A host on the computer itself, as WHATWG URL parsing writes it. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
  );
}

/**
 * The loopback redirect a sign-in page waits on, from the page's address: an
 * http `redirect_uri` on the signing-in computer's loopback, with the
 * attempt's `state`. Null for any other page.
 */
export function loopbackRedirectOfSignInPage(pageUrl: string): LoopbackRedirect | null {
  let page: URL;
  let redirect: URL;
  try {
    page = new URL(pageUrl);
    redirect = new URL(page.searchParams.get("redirect_uri") ?? "");
  } catch {
    return null;
  }
  const state = page.searchParams.get("state");
  if (redirect.protocol !== "http:" || !isLoopbackHostname(redirect.hostname) || !state) {
    return null;
  }
  return { redirect, state };
}

/**
 * One whole code at a given index: an OSC string with its end, a CSI
 * sequence, or a two-character escape (never `ESC ]`, which starts an OSC).
 */
const ESCAPE_CODE_AT =
  // oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/uy;
/** The longest code kept whole across the cut: a link's target is one address. */
const OPEN_CODE_MAX_CHARS = 16_384;

/**
 * The raw terminal output a sign-in page scan keeps for the next chunk: the
 * last `keepChars`, unless that cut lands inside a code. Then the tail starts
 * at the code instead, so a link's target is never split from its code and
 * run into the text after it.
 */
export function signInScanTail(raw: string, keepChars: number): string {
  const cut = raw.length - keepChars;
  if (cut <= 0) return raw;
  const codeStart = raw.lastIndexOf("\u001B", cut - 1);
  if (codeStart === -1) return raw.slice(cut);
  ESCAPE_CODE_AT.lastIndex = codeStart;
  // An unfinished code runs to the end of the output so far.
  const codeEnd = ESCAPE_CODE_AT.test(raw) ? ESCAPE_CODE_AT.lastIndex : raw.length;
  if (codeEnd <= cut) return raw.slice(cut);
  return raw.length - codeStart <= OPEN_CODE_MAX_CHARS ? raw.slice(codeStart) : raw.slice(codeEnd);
}
