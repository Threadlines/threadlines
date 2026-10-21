import { create } from "zustand";

import type { FleetData } from "./useFleetModel";

/**
 * What the Fleet pages share with their list of computers beside the rail,
 * which sits outside the page's tree: the Fleet layout builds the data once
 * and publishes it here. Lives only while a Fleet page is open.
 */
interface FleetPageState {
  readonly data: FleetData | null;
  readonly publish: (data: FleetData | null) => void;
}

export const useFleetPageStore = create<FleetPageState>()((set) => ({
  data: null,
  publish: (data) => set({ data }),
}));
