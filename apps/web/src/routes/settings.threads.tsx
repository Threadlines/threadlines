import { createFileRoute } from "@tanstack/react-router";

import { ThreadsSettingsPanel } from "../components/settings/ThreadsSettings";

function SettingsThreadsRoute() {
  const { authGateState } = Route.useRouteContext();
  return (
    <ThreadsSettingsPanel surface={authGateState.status === "hosted-static" ? "phone" : "full"} />
  );
}

export const Route = createFileRoute("/settings/threads")({
  component: SettingsThreadsRoute,
});
