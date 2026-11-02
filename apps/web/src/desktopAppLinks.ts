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
 * Asks the browser to open `link` once per page load, unprompted, only where
 * a computer without the app shows nothing for it: Chromium browsers (Chrome,
 * Edge, Arc, Brave) on macOS and Windows ask before opening an app and stay
 * quiet when none answers. Safari and Firefox put up an error, and Linux
 * hands every link to xdg-open, so Chrome there asks to open that even when
 * nothing would answer (an AppImage install, which claims no scheme).
 * Elsewhere the button is the way in.
 */
export function tryDesktopAppLinkOnce(link: string): void {
  if (triedLinks.has(link) || !opensUnansweredLinksQuietly()) return;
  triedLinks.add(link);
  window.location.href = link;
}

function opensUnansweredLinksQuietly(): boolean {
  const userAgentData = (
    navigator as Navigator & {
      readonly userAgentData?: {
        readonly brands?: ReadonlyArray<{ readonly brand: string }>;
        readonly platform?: string;
      };
    }
  ).userAgentData;
  const chromium = userAgentData?.brands?.some((entry) => entry.brand === "Chromium") ?? false;
  return chromium && (userAgentData?.platform === "macOS" || userAgentData?.platform === "Windows");
}
