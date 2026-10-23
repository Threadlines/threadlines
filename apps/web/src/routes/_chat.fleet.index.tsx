import { createFileRoute } from "@tanstack/react-router";

import { FleetView } from "../components/fleet/FleetView";

export const Route = createFileRoute("/_chat/fleet/")({
  component: FleetView,
});
