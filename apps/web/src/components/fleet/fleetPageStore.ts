import { create } from "zustand";

import type { FleetModel } from "./fleet.logic";

/**
 * What the Fleet page and its list of computers (the list beside the rail)
 * share: the page builds the model once and publishes it here, and either
 * side narrows the page to one computer. Lives only while the page is open:
 * the page clears it when it closes, as the old in-page filter did.
 */
interface FleetPageState {
  readonly model: FleetModel | null;
  readonly selectedComputerId: string | null;
  readonly publish: (model: FleetModel | null) => void;
  /** Narrows to `computerId`, or shows every computer again with null. */
  readonly select: (computerId: string | null) => void;
  /** Narrows to `computerId`, or clears it when it is already the one shown. */
  readonly toggle: (computerId: string) => void;
}

export const useFleetPageStore = create<FleetPageState>()((set) => ({
  model: null,
  selectedComputerId: null,
  publish: (model) =>
    set((state) =>
      model === null ? { model: null, selectedComputerId: null } : { ...state, model },
    ),
  select: (computerId) => set({ selectedComputerId: computerId }),
  toggle: (computerId) =>
    set((state) => ({
      selectedComputerId: state.selectedComputerId === computerId ? null : computerId,
    })),
}));
