import type { DesktopAppBranding } from "@threadlines/contracts";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Threadlines";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_BUILD_CHANNEL_LABEL =
  APP_STAGE_LABEL === "Dev" ? "Dev" : APP_STAGE_LABEL === "Nightly" ? "Nightly" : "Stable";
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  (APP_STAGE_LABEL === "Dev" ? `${APP_BASE_NAME} (${APP_STAGE_LABEL})` : APP_BASE_NAME);
// An unpackaged dev Electron app reports the Electron binary's own version
// through app.getVersion(), so a "Dev" stage prefers the web bundle's
// git-derived version instead.
const trustedInjectedVersion =
  injectedDesktopAppBranding && injectedDesktopAppBranding.stageLabel !== "Dev"
    ? injectedDesktopAppBranding.version
    : null;
export const APP_VERSION =
  trustedInjectedVersion ??
  import.meta.env.APP_VERSION ??
  injectedDesktopAppBranding?.version ??
  "0.0.0";
