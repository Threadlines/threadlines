import type { ScopedThreadRef } from "@threadlines/contracts";
import { type AppLinkChannel, appThreadLink } from "@threadlines/shared/appThreadLinks";

import { APP_BUILD_CHANNEL_LABEL } from "./branding";

/**
 * Links from the hosted app into the desktop app (see
 * @threadlines/shared/appThreadLinks), for a browser on the computer that
 * runs Threadlines. Each hosted app opens the desktop app on its own channel:
 * the nightly hosted app opens the nightly app.
 */
const DESKTOP_APP_LINK_CHANNEL: AppLinkChannel =
  APP_BUILD_CHANNEL_LABEL === "Dev"
    ? "dev"
    : APP_BUILD_CHANNEL_LABEL === "Nightly"
      ? "nightly"
      : "latest";

/** The link that opens this thread in the desktop app, or null for ids a link can't carry. */
export function desktopAppThreadLink(threadRef: ScopedThreadRef): string | null {
  return appThreadLink(DESKTOP_APP_LINK_CHANNEL, threadRef);
}

const triedLinks = new Set<string>();

/**
 * Asks the browser to open `link` once per page load, unprompted. Only
 * Chromium browsers (Chrome, Edge, Arc, Brave): they ask before opening an
 * app and stay quiet when none answers the link, where Safari and Firefox
 * put up an error. Elsewhere the button is the way in.
 */
export function tryDesktopAppLinkOnce(link: string): void {
  if (triedLinks.has(link) || !isChromiumBrowser()) return;
  triedLinks.add(link);
  window.location.href = link;
}

function isChromiumBrowser(): boolean {
  const userAgentData = (
    navigator as Navigator & {
      readonly userAgentData?: { readonly brands?: ReadonlyArray<{ readonly brand: string }> };
    }
  ).userAgentData;
  return userAgentData?.brands?.some((entry) => entry.brand === "Chromium") ?? false;
}
