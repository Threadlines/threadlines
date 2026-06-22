import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsConnectionsRoute() {
  const { authGateState } = Route.useRouteContext();
  return (
    <ConnectionsSettings surface={authGateState.status === "hosted-static" ? "phone" : "full"} />
  );
}

export const Route = createFileRoute("/settings/connections")({
  component: SettingsConnectionsRoute,
});
