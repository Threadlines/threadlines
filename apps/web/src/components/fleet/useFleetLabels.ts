import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@threadlines/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { getPickerModelName } from "../chat/providerIconUtils";
import type { FleetComputer, FleetProvider, FleetThreadInput } from "./fleet.logic";

const NO_PROVIDER_ENTRIES: ReadonlyArray<ProviderInstanceEntry> = [];

/**
 * What Fleet calls each computer's agents and models. Instance ids are named
 * per computer, so the same id can be a different agent elsewhere: each is
 * looked up on the computer it runs on.
 */
export function useFleetLabels(computers: ReadonlyArray<FleetComputer>): {
  readonly providerLabel: (provider: FleetProvider) => string;
  readonly modelNameOf: (thread: FleetThreadInput) => string | null;
} {
  const providersOn = useEnvironmentProviders();
  const byEnvironmentId = useMemo(() => {
    const entries = new Map<EnvironmentId, ReadonlyArray<ProviderInstanceEntry>>();
    for (const computer of computers) {
      if (computer.environmentId === null) continue;
      entries.set(
        computer.environmentId,
        deriveProviderInstanceEntries(providersOn(computer.environmentId)),
      );
    }
    return entries;
  }, [computers, providersOn]);
  const entriesFor = useCallback(
    (environmentId: EnvironmentId | null) =>
      environmentId === null
        ? NO_PROVIDER_ENTRIES
        : (byEnvironmentId.get(environmentId) ?? NO_PROVIDER_ENTRIES),
    [byEnvironmentId],
  );
  const providerLabel = useCallback(
    (provider: FleetProvider) => {
      const entries = entriesFor(provider.environmentId);
      const entry =
        (provider.instanceId === null
          ? undefined
          : entries.find((candidate) => candidate.instanceId === provider.instanceId)) ??
        entries.find((candidate) => candidate.driverKind === provider.driverKind);
      return (
        entry?.displayName ??
        PROVIDER_DISPLAY_NAMES[provider.driverKind as ProviderDriverKind] ??
        provider.driverKind
      );
    },
    [entriesFor],
  );
  const modelNameOf = useCallback(
    (thread: FleetThreadInput) => {
      const selection = thread.modelSelection;
      if (selection === null) return null;
      const entry = entriesFor(thread.environmentId).find(
        (candidate) => candidate.instanceId === selection.instanceId,
      );
      const model = entry?.models.find((candidate) => candidate.slug === selection.model);
      return entry && model ? getPickerModelName(model, entry.driverKind) : selection.model;
    },
    [entriesFor],
  );
  return { providerLabel, modelNameOf };
}
