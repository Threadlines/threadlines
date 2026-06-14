import { isElectron } from "./env";
import { isMacPlatform } from "./lib/utils";

export const isMacElectron =
  isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

export const ELECTRON_HEADER_HEIGHT_CLASS = "h-[52px]";
export const MAC_TRAFFIC_LIGHT_CLEARANCE_HEADER_CLASS = "h-[82px] items-end pb-3 pt-[30px]";

export function needsMacTrafficLightClearance(sidebarOpen: boolean): boolean {
  return isMacElectron && !sidebarOpen;
}
