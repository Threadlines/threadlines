import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useSettings } from "./useSettings";

/**
 * The logical project list: one row per repository, however many machines and
 * checkouts it lives on.
 *
 * The sidebar and the composer's project picker have to agree about what a
 * project is — a repo present on two machines is one entry in both, or the same
 * repo shows up twice in one place and once in the other. Wiring the grouping
 * (store projects, grouping settings, which environment is primary, what each
 * environment is called) belongs in one place, so this is it.
 */
export function useSidebarProjectSnapshots(): SidebarProjectSnapshot[] {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((store) => store.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((store) => store.byId);

  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        // The label a machine reports while connected wins over the one it was
        // saved under, so a renamed machine reads correctly without re-pairing.
        resolveEnvironmentLabel: (environmentId) =>
          savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ??
          savedEnvironmentRegistry[environmentId]?.label ??
          null,
      }),
    [
      projects,
      projectGroupingSettings,
      primaryEnvironmentId,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
    ],
  );
}
