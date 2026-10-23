import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
import { parseConnectionsSettingsSearch } from "../components/settings/settingsNavigation";

function SettingsConnectionsRoute() {
  const { authGateState } = Route.useRouteContext();
  const { section } = Route.useSearch();
  return (
    <ConnectionsSettings
      surface={authGateState.status === "hosted-static" ? "phone" : "full"}
      focusSection={section}
    />
  );
}

export const Route = createFileRoute("/settings/connections")({
  validateSearch: (search) => parseConnectionsSettingsSearch(search),
  component: SettingsConnectionsRoute,
});
