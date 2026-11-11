/**
 * Which permissions a page in the in-app browser gets.
 *
 * Deliberately short: a page under development has no reason to reach the
 * microphone or camera, and the default-deny keeps a mistyped URL from
 * prompting for hardware.
 *
 * - `clipboard-sanitized-write` (not `clipboard-write`, which Electron does not
 *   recognise) is what `navigator.clipboard.writeText()` checks. Allowed for
 *   every origin, so framework error overlays with a "copy" button keep working.
 * - Reading the clipboard and showing notifications are allowed only for pages
 *   served from this machine or this network. The browser goes to public sites
 *   too, and a public page has no business reading what you copied.
 * - Motion sensors, background sync, payment handlers and the screen wake lock
 *   are allowed for every origin, because Chrome allows them for every site
 *   without asking. A page can ask how each permission stands, and sign-in
 *   bot checks do: a browser that answers "denied" to all of them, these
 *   included, is one no person could have set up, and GoDaddy's check turned
 *   a hand-typed sign-in away. Electron can only answer granted or denied, so
 *   what Chrome would ask about still reads as denied, as it does for someone
 *   who has turned those off.
 */

import { isPrivateNetworkHost } from "@threadlines/shared/preview";

/**
 * Whether the page at `requestingUrl` may use `permission`.
 *
 * `requestingUrl` is whatever Electron reports for the requester: a full URL
 * from the request handler, an origin from the check handler. Anything that
 * does not parse to an origin with a host (`about:blank`, opaque origins,
 * missing values) counts as public.
 */
export function isPreviewPermissionAllowed(
  permission: string,
  requestingUrl: string | null | undefined,
): boolean {
  switch (permission) {
    case "clipboard-sanitized-write":
    case "sensors":
    case "background-sync":
    case "payment-handler":
    case "screen-wake-lock":
      return true;
    case "clipboard-read":
    case "notifications":
      return isPrivateNetworkOrigin(requestingUrl);
    default:
      return false;
  }
}

function isPrivateNetworkOrigin(requestingUrl: string | null | undefined): boolean {
  if (requestingUrl === null || requestingUrl === undefined || requestingUrl === "") {
    return false;
  }
  try {
    // Through the origin rather than the hostname, so a `blob:` document is
    // judged by the page that made it rather than by its own empty host.
    const origin = new URL(requestingUrl).origin;
    return origin !== "null" && isPrivateNetworkHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}
