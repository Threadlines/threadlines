import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsSettingsPanel } from "../components/settings/ExtensionsSettings";
import { parseExtensionsSettingsTab } from "../components/settings/ExtensionsSettings.logic";

function SettingsPluginsRoute() {
  return <ExtensionsSettingsPanel />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
  // Omitted rather than defaulted: with no tab in the URL the panel falls back to the tab it
  // remembers from the last visit.
  validateSearch: (search: Record<string, unknown>) => {
    const tab = parseExtensionsSettingsTab(search.tab);
    return tab ? { tab } : {};
  },
});
