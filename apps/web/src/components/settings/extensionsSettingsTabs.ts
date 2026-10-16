/**
 * The plugins page's tabs. The page holds two unrelated jobs — installing
 * plugins and managing skills — so it splits into tabs. The tab lives in the
 * URL so a link can point at either one, and is remembered so returning to
 * settings lands where you left.
 *
 * Kept apart from ExtensionsSettings.logic: the route validates its search
 * with these, and route validation loads with the app itself, while the
 * page's other logic loads with the page.
 */

export const EXTENSIONS_SETTINGS_TABS = ["plugins", "skills"] as const;
export type ExtensionsSettingsTab = (typeof EXTENSIONS_SETTINGS_TABS)[number];

/** Route search validation. Returns undefined for a missing or unknown tab. */
export function parseExtensionsSettingsTab(value: unknown): ExtensionsSettingsTab | undefined {
  return EXTENSIONS_SETTINGS_TABS.find((tab) => tab === value);
}

/** The URL is explicit intent, so it beats the remembered tab. */
export function resolveExtensionsSettingsTab(
  searchTab: ExtensionsSettingsTab | undefined,
  rememberedTab: ExtensionsSettingsTab | undefined,
): ExtensionsSettingsTab {
  return searchTab ?? rememberedTab ?? "plugins";
}
