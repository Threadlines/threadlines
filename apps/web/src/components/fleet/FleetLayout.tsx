import { Outlet } from "@tanstack/react-router";
import { createContext, useContext, useEffect } from "react";

import { useFleetPageStore } from "./fleetPageStore";
import { type FleetData, useFleetModel } from "./useFleetModel";

const FleetDataContext = createContext<FleetData | null>(null);

/** The Fleet data a Fleet page renders from; only inside FleetLayout. */
export function useFleetData(): FleetData {
  const data = useContext(FleetDataContext);
  if (data === null) throw new Error("useFleetData must be used inside FleetLayout.");
  return data;
}

/**
 * Every Fleet page (All computers, one computer): builds the fleet once, for
 * the page below it and for the list of computers beside the rail.
 */
export function FleetLayout() {
  const data = useFleetModel();
  const publish = useFleetPageStore((state) => state.publish);
  useEffect(() => {
    publish(data);
  }, [data, publish]);
  useEffect(() => () => publish(null), [publish]);
  return (
    <FleetDataContext value={data}>
      <Outlet />
    </FleetDataContext>
  );
}
