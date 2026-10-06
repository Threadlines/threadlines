import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/SettingsPanels";
import { parseProviderSettingsSearch } from "../components/settings/settingsNavigation";

function SettingsProvidersRoute() {
  const { instance, section } = Route.useSearch();
  return (
    <ProviderSettingsPanel
      focusedInstanceId={instance ?? null}
      showCommunityAgents={section === "community"}
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (search) => parseProviderSettingsSearch(search),
  component: SettingsProvidersRoute,
});
