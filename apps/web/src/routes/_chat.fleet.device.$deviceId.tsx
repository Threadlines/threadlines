import { createFileRoute } from "@tanstack/react-router";

import { FLEET_DEVICE_KEY_PREFIX } from "../components/fleet/fleetLinks.logic";
import { FleetComputerView } from "../components/fleet/FleetComputerView";

/** A linked computer that hasn't introduced itself yet, by its device on the computer it linked to. */
function FleetDeviceRoute() {
  const { deviceId } = Route.useParams();
  return <FleetComputerView entryKey={`${FLEET_DEVICE_KEY_PREFIX}${deviceId}`} />;
}

export const Route = createFileRoute("/_chat/fleet/device/$deviceId")({
  component: FleetDeviceRoute,
});
