import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsGeneralRoute() {
  const { authGateState } = Route.useRouteContext();
  return (
    <GeneralSettingsPanel surface={authGateState.status === "hosted-static" ? "phone" : "full"} />
  );
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
