import type { UsageProviderKind, UsageSource } from "@threadlines/contracts";
import {
  enumerateDays,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@threadlines/shared/usageFormat";
import type { CostQuality, DailyTotals } from "@threadlines/shared/usageMerge";

import type { UsageEnvironmentReport } from "~/lib/usageReactQuery";

export const USAGE_PROVIDER_LABELS: Record<UsageProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Two tones from the existing palette rather than brand colors: the app has one
 * graph accent, so the second provider takes a neutral.
 */
export const USAGE_PROVIDER_BAR_CLASSES: Record<UsageProviderKind, string> = {
  claude: "bg-primary-graph",
  codex: "bg-foreground/35",
};

/** Stacking order, so a provider keeps the same position in every bar. */
export const USAGE_PROVIDER_ORDER: readonly UsageProviderKind[] = ["claude", "codex"];

export interface UsageChartSegment {
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
  /** Share of the tallest day in the window, as a percentage of bar height. */
  readonly heightPercent: number;
}

export interface UsageChartBar {
  readonly day: string;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly segments: readonly UsageChartSegment[];
  /** Native-tooltip text; the page deliberately has no tooltip system. */
  readonly title: string;
}

/**
 * One bar per calendar day of the requested window, including days with no
 * activity — gaps are information, and dropping them would compress the axis
 * into a lie about when the work happened.
 */
export function buildUsageChartBars(input: {
  readonly daily: readonly DailyTotals[];
  readonly sinceDay: string;
  readonly untilDay: string;
}): readonly UsageChartBar[] {
  const byDay = new Map(input.daily.map((entry) => [entry.day, entry]));
  const peakTokens = input.daily.reduce((peak, entry) => Math.max(peak, entry.totalTokens), 0);

  return enumerateDays(input.sinceDay, input.untilDay).map((day) => {
    const entry = byDay.get(day);
    const segments = USAGE_PROVIDER_ORDER.flatMap((provider) => {
      const providerTotals = entry?.byProvider.get(provider);
      if (!providerTotals || providerTotals.totalTokens === 0) return [];
      return [
        {
          provider,
          totalTokens: providerTotals.totalTokens,
          heightPercent: peakTokens === 0 ? 0 : (providerTotals.totalTokens / peakTokens) * 100,
        },
      ];
    });

    return {
      day,
      totalTokens: entry?.totalTokens ?? 0,
      costUsd: entry?.costUsd ?? 0,
      segments,
      title: describeUsageDay(day, entry ?? null, segments),
    };
  });
}

function describeUsageDay(
  day: string,
  entry: DailyTotals | null,
  segments: readonly UsageChartSegment[],
): string {
  if (!entry || entry.totalTokens === 0) {
    return `${formatDayShort(day)}: no recorded usage`;
  }
  const breakdown = segments
    .map(
      (segment) =>
        `${USAGE_PROVIDER_LABELS[segment.provider]} ${formatTokens(segment.totalTokens)}`,
    )
    .join(", ");
  return `${formatDayShort(day)}: ${formatTokens(entry.totalTokens)} tokens, ${formatUsd(entry.costUsd)} API-equivalent (${breakdown})`;
}

/**
 * Roughly six date ticks, whatever the window length, so 90 days does not turn
 * the axis into a smear.
 */
export function shouldLabelUsageTick(index: number, count: number): boolean {
  if (count === 0) return false;
  const step = Math.max(1, Math.ceil(count / 6));
  return index % step === 0 || index === count - 1;
}

export type UsageMachineState = "reporting" | "stale" | "not-reporting";

export interface UsageMachineRow {
  readonly environmentId: string;
  readonly label: string;
  readonly state: UsageMachineState;
  readonly detail: string | null;
  readonly sources: readonly UsageSource[];
}

/**
 * A row per environment the app knows about, including the ones that answered
 * nothing. Silently dropping an unreachable machine would make the totals look
 * complete when they are not.
 */
export function buildUsageMachineRows(input: {
  readonly environments: readonly UsageEnvironmentReport[];
  readonly staleEnvironments: readonly string[];
}): readonly UsageMachineRow[] {
  const stale = new Set(input.staleEnvironments);

  return [...input.environments]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((environment) => {
      if (!environment.summary) {
        return {
          environmentId: environment.environmentId,
          label: environment.label,
          state: "not-reporting" as const,
          detail: environment.error,
          sources: [],
        };
      }
      const isStale = stale.has(environment.environmentId);
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        state: isStale ? ("stale" as const) : ("reporting" as const),
        detail: isStale ? "Running an older usage format; excluded from the totals." : null,
        sources: environment.summary.sources,
      };
    });
}

export const USAGE_MACHINE_STATE_LABELS: Record<UsageMachineState, string> = {
  reporting: "Reporting",
  stale: "Out of date",
  "not-reporting": "Not reporting",
};

/** How trustworthy the cost column is, in one line. */
export function formatCostQualityFootnote(costQuality: CostQuality): string {
  return [
    `Priced from provider records ${formatPercent(costQuality.providerReportedShare, 0)}`,
    `model rates ${formatPercent(costQuality.modelPricedShare, 0)}`,
    `unpriced ${formatPercent(costQuality.unpricedShare, 0)}`,
  ].join(" · ");
}
