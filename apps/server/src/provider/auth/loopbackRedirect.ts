/**
 * Finishing a sign-in from a browser on another device.
 *
 * Many sign-ins (`codex login`, Antigravity) send the browser back to a
 * listener on the signing-in computer's own loopback address, the OAuth
 * `redirect_uri`. A browser on a phone or another computer can't reach it:
 * its page ends on an address that doesn't load. The user pastes that
 * address, and the computer replays it to its own listener. Only a redirect
 * this sign-in printed is ever replayed: the same loopback host, port and
 * path, its exact `state`, and one result.
 *
 * @module provider/auth/loopbackRedirect
 */
import {
  type LoopbackRedirect,
  loopbackRedirectOfSignInPage,
  signInScanTail,
} from "@threadlines/shared/signInRedirect";
import { request as httpRequest } from "node:http";

const REPLAY_TIMEOUT_MS = 10_000;
/** A listener's own redirects followed after the callback (`codex login` sends one, to /success). */
const REPLAY_MAX_HOPS = 3;
/** Output kept between chunks for the scan: a page address split across them. */
const SCAN_TAIL_CHARS = 8_192;

/** A hyperlink (OSC 8) and its target: a short label or a wrapped link hides the address. */
const HYPERLINK_TARGET =
  // oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\u001B\]8;[^;\u0007\u001B]*;([^\u0007\u001B]*)(?:\u0007|\u001B\\)/gu;
const TERMINAL_CODES =
  // oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/gu;
const PAGE_URL = /https?:\/\/[^\s"'<>)\]]+/gu;

/**
 * Scans a sign-in command's output, chunk by chunk, for the loopback
 * redirects of the pages it prints. Kept as it arrives, so output that
 * scrolls the page away (a redraw, a progress bar) can't lose it.
 */
export class PrintedRedirects {
  private tail = "";
  private readonly found: LoopbackRedirect[] = [];

  /** Every redirect printed so far, oldest first. */
  get all(): ReadonlyArray<LoopbackRedirect> {
    return this.found;
  }

  push(chunk: string): void {
    const raw = `${this.tail}${chunk}`;
    const text = raw
      .replace(HYPERLINK_TARGET, (_, target: string) => (target ? `\n${target}\n` : ""))
      .replace(TERMINAL_CODES, "\n");
    for (const match of text.matchAll(PAGE_URL)) {
      // An address at the very end may still be arriving.
      if (match.index + match[0].length >= text.length) continue;
      const redirect = loopbackRedirectOfSignInPage(match[0]);
      if (redirect && !this.found.some((known) => known.state === redirect.state)) {
        this.found.push(redirect);
      }
    }
    this.tail = signInScanTail(raw, SCAN_TAIL_CHARS);
  }
}

/**
 * The pasted address, if it is this sign-in's redirect: the same loopback
 * host, port and path as the pending `redirect_uri`, its exact `state`, one
 * `code` or `error`, and the expected issuer when one is named. Otherwise the
 * reason, worded for the user.
 */
export function checkLoopbackRedirect(
  raw: string,
  pending: LoopbackRedirect,
  options?: { readonly issuer?: { readonly url: string; readonly name: string } },
): URL | string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That isn't a web address.";
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== pending.redirect.hostname ||
    url.port !== pending.redirect.port ||
    url.pathname !== pending.redirect.pathname
  ) {
    return `That address isn't this sign-in's. Paste the full address your browser shows after you approve, starting with ${pending.redirect.origin}.`;
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    return "That address belongs to a different sign-in attempt.";
  }
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (codes.length + errors.length !== 1) return "That address has no sign-in result in it.";
  const issuer = url.searchParams.get("iss");
  if (options?.issuer && issuer !== null && issuer !== options.issuer.url) {
    return `That address didn't come from ${options.issuer.name}.`;
  }
  return url;
}

/**
 * The pasted address checked against every redirect this sign-in printed:
 * the one it belongs to, or why not, measured against the newest.
 */
export function matchPrintedRedirect(
  raw: string,
  printed: ReadonlyArray<LoopbackRedirect>,
): { readonly url: URL; readonly redirect: LoopbackRedirect } | string {
  let reason: string | null = null;
  for (const redirect of printed.toReversed()) {
    const checked = checkLoopbackRedirect(raw, redirect);
    if (typeof checked !== "string") return { url: checked, redirect };
    reason ??= checked;
  }
  return reason ?? "This sign-in isn't waiting for a browser address.";
}

interface ReplayAnswer {
  readonly status: number;
  readonly location: string | null;
}

/** One GET to `target`, saying it is for `host`: no proxy, no redirects followed. */
function getOnce(target: URL, host: string): Promise<ReplayAnswer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      target,
      { method: "GET", agent: false, timeout: REPLAY_TIMEOUT_MS, headers: { host } },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, location: response.headers.location ?? null });
      },
    );
    request.on("timeout", () => request.destroy(new Error("The sign-in did not answer.")));
    request.on("error", reject);
    request.end();
  });
}

function isConnectionRefused(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "ECONNREFUSED"
  );
}

/** `getOnce`, trying IPv4 then IPv6 for `localhost`: the listener binds one of them. */
async function getLoopback(url: URL): Promise<ReplayAnswer> {
  if (url.hostname !== "localhost") return await getOnce(url, url.host);
  const ipv4 = new URL(url);
  ipv4.hostname = "127.0.0.1";
  try {
    return await getOnce(ipv4, url.host);
  } catch (error) {
    if (!isConnectionRefused(error)) throw error;
    const ipv6 = new URL(url);
    ipv6.hostname = "[::1]";
    return await getOnce(ipv6, url.host);
  }
}

/**
 * Replays the address to the sign-in's listener on this computer and
 * follows the listener's own redirects, as the browser would have: only on
 * the same loopback origin, a few at most (`codex login` finishes once its
 * /success page is asked for). Resolves with the last status code.
 */
export async function replayLoopbackRedirect(url: URL): Promise<number> {
  let current = url;
  for (let hop = 1; ; hop += 1) {
    const answer = await getLoopback(current);
    if (answer.status < 300 || answer.status >= 400 || answer.location === null) {
      return answer.status;
    }
    let next: URL;
    try {
      next = new URL(answer.location, current);
    } catch {
      return answer.status;
    }
    if (next.origin !== url.origin || hop >= REPLAY_MAX_HOPS) return answer.status;
    current = next;
  }
}
