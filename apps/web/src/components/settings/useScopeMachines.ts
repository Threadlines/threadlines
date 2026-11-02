import type { EnvironmentId } from "@threadlines/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import type { ExtensionScopeMachineInput } from "./ExtensionsSettings.logic";

/**
 * Every computer this client knows about, this device first, for settings
 * pages that pick a computer and project (Plugins & Skills, Agent
 * Instructions). Same source and ordering the sidebar's picker uses, so the
 * lists never disagree.
 */
export function useScopeMachines(): ReadonlyArray<ExtensionScopeMachineInput> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  return useMemo(() => {
    const resolveLabel = (environmentId: EnvironmentId, isPrimary: boolean) =>
      resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId,
        runtimeLabel: savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ?? null,
        savedLabel: savedEnvironmentRegistry[environmentId]?.label ?? null,
      });
    const savedOptions = Object.values(savedEnvironmentRegistry)
      .filter((record) => record.environmentId !== primaryEnvironmentId)
      .map((record) => ({
        environmentId: record.environmentId,
        label: resolveLabel(record.environmentId, false),
        isPrimary: false,
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
    return primaryEnvironmentId === null
      ? savedOptions
      : [
          {
            environmentId: primaryEnvironmentId,
            label: resolveLabel(primaryEnvironmentId, true),
            isPrimary: true,
          },
          ...savedOptions,
        ];
  }, [primaryEnvironmentId, savedEnvironmentRegistry, savedEnvironmentRuntimeById]);
}
