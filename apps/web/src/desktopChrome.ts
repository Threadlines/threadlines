import { isElectron, isMarketingCaptureMode } from "./env";
import { isMacPlatform } from "./lib/utils";

export const isMacElectron =
  isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

export const ELECTRON_HEADER_HEIGHT_CLASS = "h-[52px]";
export const MAC_TRAFFIC_LIGHT_CLEARANCE_HEADER_CLASS = "h-[82px] items-end pb-3 pt-[30px]";

/**
 * The thread list's header row (the wordmark), on every platform: the height
 * of a top bar, starting clear of whatever window controls reach past the
 * rail. On macOS that puts it beside the traffic lights, where the sidebar
 * toggle used to sit before it moved into the rail.
 */
export const SIDEBAR_LIST_HEADER_ROW_CLASS =
  "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] items-center pr-3 pl-[var(--sidebar-list-header-left)]";

export function needsMacTrafficLightClearance(sidebarOpen: boolean): boolean {
  return isMacElectron && !isMarketingCaptureMode && !sidebarOpen;
}
