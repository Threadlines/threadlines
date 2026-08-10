import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageWindowDays,
} from "@threadlines/contracts";
import { makeTodayUsageWindow, makeUsageWindow } from "@threadlines/shared/usageFormat";
import {
  mergeUsage,
  type EnvironmentUsage,
  type MergedUsage,
} from "@threadlines/shared/usageMerge";
import { queryOptions } from "@tanstack/react-query";
import { useMemo } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";

/** An environment the page will ask for usage, connected or not. */
export interface UsageEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * What one environment contributed.
 *
 * A machine that could not be reached keeps its row with `summary: null` rather
 * than disappearing: a total that quietly omits a computer is worse than one
 * that says which computer is missing.
 */
export interface UsageEnvironmentReport {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary | null;
  readonly error: string | null;
}

export interface UsageAcrossEnvironments {
  readonly window: UsageSummaryInput;
  readonly merged: MergedUsage;
  readonly environments: readonly UsageEnvironmentReport[];
}

/** A few minutes: a transcript scan is disk work, and usage is not live data. */
const USAGE_STALE_TIME_MS = 5 * 60_000;

function normalizeTargets(
  targets: ReadonlyArray<UsageEnvironmentTarget>,
): ReadonlyArray<UsageEnvironmentTarget> {
  return [...targets].sort((left, right) => left.environmentId.localeCompare(right.environmentId));
}

async function readUsageAcrossEnvironments(
  targets: ReadonlyArray<UsageEnvironmentTarget>,
  window: UsageSummaryInput,
): Promise<UsageAcrossEnvironments> {
  const reads = await Promise.allSettled(
    targets.map(async (target) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api?.usage) {
        throw new Error(`Environment ${target.environmentId} is unavailable.`);
      }
      return api.usage.summary(window);
    }),
  );

  const environments: UsageEnvironmentReport[] = targets.map((target, index) => {
    const read = reads[index];
    if (read?.status === "fulfilled") {
      return {
        environmentId: target.environmentId,
        label: target.label,
        summary: read.value,
        error: null,
      };
    }
    return {
      environmentId: target.environmentId,
      label: target.label,
      summary: null,
      error: read?.status === "rejected" ? describeUsageReadFailure(read.reason) : "Unavailable",
    };
  });

  const contributions: EnvironmentUsage[] = environments.flatMap((environment) =>
    environment.summary
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            summary: environment.summary,
          },
        ]
      : [],
  );

  return {
    window,
    merged: mergeUsage(contributions, USAGE_CONTRACT_VERSION),
    environments,
  };
}

function describeUsageReadFailure(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  return "Unavailable";
}

/**
 * The page's query. Every environment is asked in parallel and the failures are
 * kept alongside the successes, so the merge can be honest about coverage.
 */
export function usageSummaryQueryOptions(input: {
  readonly targets: ReadonlyArray<UsageEnvironmentTarget>;
  readonly windowDays: UsageWindowDays;
}) {
  const targets = normalizeTargets(input.targets);
  return queryOptions({
    queryKey: [
      "usage",
      "summary",
      input.windowDays,
      targets.map((target) => target.environmentId),
    ] as const,
    // The window is built inside the fetch rather than in the key so a session
    // left open past midnight rolls onto the new day at the next refetch.
    queryFn: () => readUsageAcrossEnvironments(targets, makeUsageWindow(input.windowDays)),
    enabled: targets.length > 0,
    staleTime: USAGE_STALE_TIME_MS,
  });
}

/**
 * Today alone, for the sidebar meter. Same key family as the page so the two
 * never collide, and a different window so neither refetches for the other.
 */
export function usageTodayQueryOptions(input: {
  readonly targets: ReadonlyArray<UsageEnvironmentTarget>;
}) {
  const targets = normalizeTargets(input.targets);
  return queryOptions({
    queryKey: ["usage", "summary", "today", targets.map((target) => target.environmentId)] as const,
    queryFn: () => readUsageAcrossEnvironments(targets, makeTodayUsageWindow()),
    enabled: targets.length > 0,
    staleTime: USAGE_STALE_TIME_MS,
  });
}

/**
 * Every environment the app knows about: this device plus each saved backend,
 * whether or not it is currently connected.
 */
export function useUsageEnvironmentTargets(): ReadonlyArray<UsageEnvironmentTarget> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryLabel = readPrimaryEnvironmentDescriptor()?.label ?? null;
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  return useMemo(() => {
    const targets: UsageEnvironmentTarget[] = [];
    const seen = new Set<EnvironmentId>();

    if (primaryEnvironmentId) {
      seen.add(primaryEnvironmentId);
      targets.push({
        environmentId: primaryEnvironmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: true,
          environmentId: primaryEnvironmentId,
          runtimeLabel: primaryLabel,
        }),
      });
    }

    for (const record of Object.values(savedEnvironmentsById)) {
      if (seen.has(record.environmentId)) continue;
      seen.add(record.environmentId);
      targets.push({
        environmentId: record.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId: record.environmentId,
          runtimeLabel:
            savedEnvironmentRuntimeById[record.environmentId]?.descriptor?.label ?? null,
          savedLabel: record.label,
        }),
      });
    }

    return normalizeTargets(targets);
  }, [primaryEnvironmentId, primaryLabel, savedEnvironmentRuntimeById, savedEnvironmentsById]);
}
