import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

function ArchivedSettingsRouteView() {
  const { authGateState } = Route.useRouteContext();
  return <ArchivedThreadsPanel hostedStatic={authGateState.status === "hosted-static"} />;
}

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedSettingsRouteView,
});
