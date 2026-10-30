import { createFileRoute } from "@tanstack/react-router";

import { FleetLayout } from "../components/fleet/FleetLayout";
import { usePlaceArrival } from "../hooks/usePlaceArrival";

function FleetRoute() {
  usePlaceArrival();
  return <FleetLayout />;
}

export const Route = createFileRoute("/_chat/fleet")({
  component: FleetRoute,
});
