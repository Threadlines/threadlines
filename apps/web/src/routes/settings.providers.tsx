import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/SettingsPanels";
import { parseProviderSettingsSearch } from "../components/settings/settingsNavigation";

function SettingsProvidersRoute() {
  const { instance } = Route.useSearch();
  return <ProviderSettingsPanel focusedInstanceId={instance ?? null} />;
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (search) => parseProviderSettingsSearch(search),
  component: SettingsProvidersRoute,
});
