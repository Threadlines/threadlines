/**
 * How the palette's Settings source sees Settings: as the hosted phone app
 * shows it, or in full. The same answer the settings menu gives
 * (SettingsSidebarNav), kept in one place the palette and its tests share.
 */
import type { SettingsSurface } from "../components/settings/settingsPlaceAvailability";
import { isHostedStaticApp } from "../hostedPairing";

export function paletteSettingsSurface(): SettingsSurface {
  return isHostedStaticApp() ? "phone" : "full";
}
