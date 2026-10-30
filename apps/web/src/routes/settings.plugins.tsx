import { createFileRoute } from "@tanstack/react-router";

import { placeScopeSearch } from "../appPlaceLinks";
import { ExtensionsSettingsPanel } from "../components/settings/ExtensionsSettings";
import { parseExtensionsSettingsTab } from "../components/settings/extensionsSettingsTabs";

function SettingsPluginsRoute() {
  return <ExtensionsSettingsPanel />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
  // Omitted rather than defaulted: with no tab in the URL the panel falls back to the tab it
  // remembers from the last visit.
  // `environment` and `project`: a place link opening the page on a thread's
  // computer and project (appPlaceLinks).
  validateSearch: (search: Record<string, unknown>) => {
    const tab = parseExtensionsSettingsTab(search.tab);
    return { ...(tab ? { tab } : {}), ...placeScopeSearch(search) };
  },
});
