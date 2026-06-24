import { isElectron } from "./env";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";

export const isMacElectron =
  isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

export const ELECTRON_HEADER_HEIGHT_CLASS = "h-[52px]";
export const MAC_TRAFFIC_LIGHT_CLEARANCE_HEADER_CLASS = "h-[82px] items-end pb-3 pt-[30px]";
export const MAC_SIDEBAR_WORDMARK_SPACER_CLASS = "h-10 shrink-0";
export const MAC_SIDEBAR_WORDMARK_ROW_CLASS = "flex h-8 min-h-8 items-center px-3";
export const WINDOWS_SIDEBAR_WORDMARK_ROW_CLASS =
  "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] items-center pr-3 pl-[var(--workspace-titlebar-content-left)]";

export function needsMacTrafficLightClearance(sidebarOpen: boolean): boolean {
  return isMacElectron && !sidebarOpen;
}

export function resolveElectronSidebarWordmarkLayout(platform: string): {
  spacerClassName: string | null;
  wordmarkRowClassName: string;
} {
  if (isWindowsPlatform(platform)) {
    return {
      spacerClassName: null,
      wordmarkRowClassName: WINDOWS_SIDEBAR_WORDMARK_ROW_CLASS,
    };
  }

  return {
    spacerClassName: MAC_SIDEBAR_WORDMARK_SPACER_CLASS,
    wordmarkRowClassName: MAC_SIDEBAR_WORDMARK_ROW_CLASS,
  };
}
