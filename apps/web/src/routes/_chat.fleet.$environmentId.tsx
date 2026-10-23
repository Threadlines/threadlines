import { createFileRoute } from "@tanstack/react-router";

import { FleetComputerView } from "../components/fleet/FleetComputerView";

function FleetEnvironmentRoute() {
  const { environmentId } = Route.useParams();
  return <FleetComputerView entryKey={environmentId} />;
}

export const Route = createFileRoute("/_chat/fleet/$environmentId")({
  component: FleetEnvironmentRoute,
});
