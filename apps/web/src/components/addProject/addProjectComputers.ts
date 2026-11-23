import type { EnvironmentId } from "@threadlines/contracts";
import { useMemo } from "react";

import {
  readPrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";

export interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
}

/**
 * The computers a project can be added on: this one first, then the linked
 * ones by name. Empty until the computer list arrives on a cold start.
 */
export function useAddProjectEnvironmentOptions(): ReadonlyArray<AddProjectEnvironmentOption> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironmentLabel = readPrimaryEnvironmentDescriptor()?.label ?? null;
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  return useMemo(() => {
    const options: AddProjectEnvironmentOption[] = [];
    const seenEnvironmentIds = new Set<EnvironmentId>();

    if (primaryEnvironmentId) {
      seenEnvironmentIds.add(primaryEnvironmentId);
      options.push({
        environmentId: primaryEnvironmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: true,
          environmentId: primaryEnvironmentId,
          runtimeLabel: primaryEnvironmentLabel,
        }),
        isPrimary: true,
      });
    }

    for (const record of Object.values(savedEnvironmentRegistry)) {
      if (seenEnvironmentIds.has(record.environmentId)) {
        continue;
      }

      const runtimeState = savedEnvironmentRuntimeById[record.environmentId];
      options.push({
        environmentId: record.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId: record.environmentId,
          runtimeLabel: runtimeState?.descriptor?.label ?? null,
          savedLabel: record.label,
        }),
        isPrimary: false,
      });
    }

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  }, [
    primaryEnvironmentId,
    primaryEnvironmentLabel,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);
}

function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

/**
 * The computer's platform in `navigator.platform` terms, which decides what
 * reads as a path there (a Windows drive letter only on Windows).
 */
export function useEnvironmentBrowsePlatform(environmentId: EnvironmentId | null): string {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useMemo(() => {
    const os =
      environmentId && primaryEnvironmentId && environmentId === primaryEnvironmentId
        ? (readPrimaryEnvironmentDescriptor()?.platform.os ?? null)
        : environmentId
          ? (savedEnvironmentRuntimeById[environmentId]?.descriptor?.platform.os ??
            savedEnvironmentRuntimeById[environmentId]?.serverConfig?.environment.platform.os ??
            null)
          : null;
    return getEnvironmentBrowsePlatform(os);
  }, [environmentId, primaryEnvironmentId, savedEnvironmentRuntimeById]);
}
