import { createFileRoute } from "@tanstack/react-router";

import { FleetLayout } from "../components/fleet/FleetLayout";

export const Route = createFileRoute("/_chat/fleet")({
  component: FleetLayout,
});
