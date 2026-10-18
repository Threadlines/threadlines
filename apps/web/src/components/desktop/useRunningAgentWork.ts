import type { EnvironmentId } from "@threadlines/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { selectRunningSidebarThreadsByLocation, useStore } from "../../store";

export interface RunningAgentWork {
  /** Running threads on this computer: the work closing the app stops. */
  readonly localCount: number;
  /**
   * One entry per other computer with running threads, its name or null when
   * it has none yet. Those threads keep running when this app closes.
   */
  readonly remoteMachineLabels: ReadonlyArray<string | null>;
}

function normalizeLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Live agent work split by where it runs, for the prompts that warn before
 * the desktop app closes. Mount it only while such a prompt is open: it reads
 * every sidebar thread on each store change.
 */
export function useRunningAgentWork(): RunningAgentWork {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localCount = useStore(
    (state) => selectRunningSidebarThreadsByLocation(state, primaryEnvironmentId).local.length,
  );
  const remoteEnvironmentIds = useStore(
    useShallow((state): EnvironmentId[] => [
      ...new Set(
        selectRunningSidebarThreadsByLocation(state, primaryEnvironmentId).remote.map(
          (thread) => thread.environmentId,
        ),
      ),
    ]),
  );
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const registryById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const remoteMachineLabels = useMemo(
    () =>
      remoteEnvironmentIds.map(
        (environmentId) =>
          normalizeLabel(runtimeById[environmentId]?.descriptor?.label) ??
          normalizeLabel(registryById[environmentId]?.label),
      ),
    [registryById, remoteEnvironmentIds, runtimeById],
  );
  return { localCount, remoteMachineLabels };
}
