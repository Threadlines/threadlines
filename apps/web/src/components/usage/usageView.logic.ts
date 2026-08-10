import type { UsageProviderKind, UsageSource } from "@threadlines/contracts";
import {
  enumerateDays,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatTokensCompact,
  formatUsd,
} from "@threadlines/shared/usageFormat";
import type { CostQuality, DailyTotals, MergedUsage } from "@threadlines/shared/usageMerge";

import type { UsageEnvironmentReport } from "~/lib/usageReactQuery";

/** Product names, as the providers write them. */
export const USAGE_PROVIDER_LABELS: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** For the narrow columns where the product name would not fit. */
export const USAGE_PROVIDER_SHORT_LABELS: Record<UsageProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * The only brand hues in the app, defined in `index.css` for both themes.
 *
 * Held as CSS variables rather than utility classes because the chart paints
 * them into SVG fill/stroke attributes as well as into HTML.
 */
export const USAGE_PROVIDER_COLORS: Record<UsageProviderKind, string> = {
  claude: "var(--provider-claude)",
  codex: "var(--provider-codex)",
};

/**
 * Paint order, not stacking order: the series overlap, and Claude is usually the
 * larger of the two, so it draws last and keeps its outline unbroken.
 */
export const USAGE_PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude"];

/** Reading order for legends and rows: the same order every time. */
export const USAGE_PROVIDER_READING_ORDER: readonly UsageProviderKind[] = ["claude", "codex"];

export type UsageChartMode = "cost" | "tokens";

export const USAGE_CHART_MODES: readonly UsageChartMode[] = ["cost", "tokens"];

export const USAGE_CHART_MODE_LABELS: Record<UsageChartMode, string> = {
  cost: "Cost",
  tokens: "Tokens",
};

export const USAGE_CHART_TITLES: Record<UsageChartMode, string> = {
  cost: "Daily cost",
  tokens: "Daily tokens",
};

/** The hero follows the chart's cost|tokens mode; these are its labels. */
export const USAGE_HERO_LABELS: Record<UsageChartMode, string> = {
  cost: "API-equivalent cost",
  tokens: "Processed tokens",
};

export type UsageBreakdown = "models" | "days";

export const USAGE_BREAKDOWNS: readonly UsageBreakdown[] = ["models", "days"];

export const USAGE_BREAKDOWN_LABELS: Record<UsageBreakdown, string> = {
  models: "Model",
  days: "Day",
};

export interface UsageDayRow {
  readonly day: string;
  readonly label: string;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly costShare: number;
}

/**
 * The days breakdown, newest first. Days without activity are dropped: unlike
 * the chart, where a gap is information, a table of zero rows buries the days
 * that had something to say.
 */
export function buildUsageDayRows(merged: MergedUsage): readonly UsageDayRow[] {
  return merged.daily
    .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
    .map((entry) => ({
      day: entry.day,
      label: formatDayShort(entry.day),
      totalTokens: entry.totalTokens,
      costUsd: entry.costUsd,
      costShare: merged.costUsd === 0 ? 0 : entry.costUsd / merged.costUsd,
    }))
    .toReversed();
}

/**
 * Chart user units. Height matches the rendered pixel height so vertical
 * geometry is 1:1; width is nominal, since the SVG stretches horizontally to
 * whatever the hero column gives it.
 */
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 200;
const GRIDLINE_COUNT = 4;

export interface UsageChartSeries {
  readonly provider: UsageProviderKind;
  readonly color: string;
  /** Closed shape from the zero baseline, for the translucent fill. */
  readonly areaPath: string;
  /** The same curve without the baseline, for the stroke on top. */
  readonly linePath: string;
}

export interface UsageChartGridline {
  readonly value: number;
  readonly label: string;
  /** Distance from the top of the plot, as a percentage. */
  readonly topPercent: number;
}

export interface UsageChartColumnEntry {
  readonly provider: UsageProviderKind;
  /** Formatted in the chart's mode, so the card needs no arithmetic. */
  readonly valueLabel: string;
}

/** One hoverable day: everything the tracking card says about it. */
export interface UsageChartColumn {
  readonly day: string;
  readonly label: string;
  readonly entries: readonly UsageChartColumnEntry[];
  readonly totalLabel: string;
  readonly hasActivity: boolean;
}

export interface UsageAreaChart {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly series: readonly UsageChartSeries[];
  readonly gridlines: readonly UsageChartGridline[];
  /** Window start, midpoint and end. Three ticks, whatever the window length. */
  readonly axisLabels: readonly string[];
  readonly columns: readonly UsageChartColumn[];
  readonly isEmpty: boolean;
}

function chartValue(
  totals: { readonly costUsd: number; readonly totalTokens: number } | undefined,
  mode: UsageChartMode,
): number {
  if (!totals) return 0;
  return mode === "cost" ? totals.costUsd : totals.totalTokens;
}

/**
 * One smooth area per provider across every calendar day of the window,
 * including the days with no activity — gaps are information, and dropping them
 * would compress the axis into a lie about when the work happened.
 */
export function buildUsageAreaChart(input: {
  readonly daily: readonly DailyTotals[];
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly mode: UsageChartMode;
}): UsageAreaChart {
  const byDay = new Map(input.daily.map((entry) => [entry.day, entry]));
  const days = enumerateDays(input.sinceDay, input.untilDay);

  const valuesByProvider = new Map<UsageProviderKind, number[]>(
    USAGE_PROVIDER_ORDER.map((provider) => [
      provider,
      days.map((day) => chartValue(byDay.get(day)?.byProvider.get(provider), input.mode)),
    ]),
  );

  const peak = [...valuesByProvider.values()]
    .flat()
    .reduce((highest, value) => Math.max(highest, value), 0);
  const axisMax = niceAxisMax(peak);

  const series: UsageChartSeries[] = [];
  for (const provider of USAGE_PROVIDER_ORDER) {
    const values = valuesByProvider.get(provider) ?? [];
    if (values.every((value) => value === 0)) continue;
    const points = monotonePoints(values, axisMax);
    series.push({
      provider,
      color: USAGE_PROVIDER_COLORS[provider],
      areaPath: `${points} L ${CHART_WIDTH} ${CHART_HEIGHT} L 0 ${CHART_HEIGHT} Z`,
      linePath: points,
    });
  }

  return {
    viewBoxWidth: CHART_WIDTH,
    viewBoxHeight: CHART_HEIGHT,
    series,
    gridlines: axisMax === 0 ? [] : buildGridlines(axisMax, input.mode),
    axisLabels: axisTickDays(days).map((day) => formatDayShort(day).toUpperCase()),
    columns: days.map((day) => {
      const entry = byDay.get(day);
      const formatValue = input.mode === "cost" ? formatUsd : formatTokensCompact;
      return {
        day,
        label: formatDayShort(day),
        // Every charted provider gets a row, zeros included: the card answers
        // "who was quiet that day" as much as "who was busy". Reading order,
        // not paint order, so the card matches the legend and the hero.
        entries: USAGE_PROVIDER_READING_ORDER.filter((provider) =>
          series.some((line) => line.provider === provider),
        ).map((provider) => ({
          provider,
          valueLabel: formatValue(chartValue(entry?.byProvider.get(provider), input.mode)),
        })),
        totalLabel: formatValue(chartValue(entry, input.mode)),
        hasActivity: (entry?.totalTokens ?? 0) > 0,
      };
    }),
    isEmpty: series.length === 0,
  };
}

/** Start, middle and end, de-duplicated for windows too short to have three. */
function axisTickDays(days: readonly string[]): readonly string[] {
  if (days.length === 0) return [];
  const ticks = [days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]];
  return [...new Set(ticks.filter((day): day is string => day !== undefined))];
}

function buildGridlines(axisMax: number, mode: UsageChartMode): readonly UsageChartGridline[] {
  return Array.from({ length: GRIDLINE_COUNT }, (_unused, index) => {
    const fraction = (GRIDLINE_COUNT - index) / GRIDLINE_COUNT;
    const value = axisMax * fraction;
    return {
      value,
      label: mode === "cost" ? formatUsd(value) : formatTokens(value),
      topPercent: (1 - fraction) * 100,
    };
  });
}

const AXIS_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/**
 * The smallest round ceiling above the peak that also divides evenly into
 * {@link GRIDLINE_COUNT} bands, so every gridline label is a number a reader can
 * hold in their head.
 */
export function niceAxisMax(peak: number): number {
  if (!(peak > 0)) return 0;
  const band = peak / GRIDLINE_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(band));
  const normalized = band / magnitude;
  const step = AXIS_STEPS.find((candidate) => normalized <= candidate + 1e-9) ?? 10;
  return step * magnitude * GRIDLINE_COUNT;
}

/**
 * A monotone cubic through the daily values, as an SVG path.
 *
 * Fritsch-Carlson tangents rather than a plain Catmull-Rom: a smooth curve that
 * overshoots would draw days below zero and peaks the data never reached, which
 * on a spend chart is not a stylistic quibble.
 */
function monotonePoints(values: readonly number[], axisMax: number): string {
  if (values.length === 0) return "M 0 " + String(CHART_HEIGHT);
  const stepX = values.length > 1 ? CHART_WIDTH / (values.length - 1) : 0;
  const toY = (value: number) =>
    axisMax === 0 ? CHART_HEIGHT : CHART_HEIGHT - (value / axisMax) * CHART_HEIGHT;
  const ys = values.map(toY);
  if (ys.length === 1) {
    // One day: a flat segment, so the fill still has a shape to close.
    return `M 0 ${round(ys[0] ?? CHART_HEIGHT)} L ${CHART_WIDTH} ${round(ys[0] ?? CHART_HEIGHT)}`;
  }

  const tangents = monotoneTangents(ys, stepX);
  let path = `M 0 ${round(ys[0] ?? 0)}`;
  for (let index = 0; index < ys.length - 1; index += 1) {
    const x0 = index * stepX;
    const x1 = (index + 1) * stepX;
    const y0 = ys[index] ?? 0;
    const y1 = ys[index + 1] ?? 0;
    const m0 = tangents[index] ?? 0;
    const m1 = tangents[index + 1] ?? 0;
    const control = stepX / 3;
    path += ` C ${round(x0 + control)} ${round(y0 + m0 * control)} ${round(x1 - control)} ${round(y1 - m1 * control)} ${round(x1)} ${round(y1)}`;
  }
  return path;
}

function monotoneTangents(ys: readonly number[], stepX: number): readonly number[] {
  const secants = ys.slice(0, -1).map((y, index) => ((ys[index + 1] ?? y) - y) / stepX);
  return ys.map((_unused, index) => {
    const before = secants[index - 1];
    const after = secants[index];
    if (before === undefined) return after ?? 0;
    if (after === undefined) return before;
    // A local extremum: a flat tangent is the only one that cannot overshoot.
    if (before * after <= 0) return 0;
    const average = (before + after) / 2;
    const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
    return Math.sign(average) * Math.min(Math.abs(average), limit);
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `2026-07-12` and `2026-08-10` to `Jul 12 to Aug 10`. */
export function formatUsageDateRange(sinceDay: string, untilDay: string): string {
  return `${formatDayShort(sinceDay)} to ${formatDayShort(untilDay)}`;
}

export interface UsageStat {
  readonly label: string;
  readonly value: string;
  /** One line of context, or nothing when the figure has none worth adding. */
  readonly context: string | null;
}

/**
 * The band under the hero: what the tokens were, not just how many.
 *
 * Every sub-line is a ratio the totals alone do not give, so a reader can tell a
 * heavy day from a heavy month, and cache reads from cache writes.
 */
export function buildUsageStats(merged: MergedUsage): readonly UsageStat[] {
  // A day with any tokens at all. Dividing by calendar days instead would make
  // a week off look like a drop in intensity rather than a week off.
  const activeDays = merged.daily.filter((entry) => entry.totalTokens > 0).length;
  const observedInput =
    merged.cachedInputTokens + merged.uncachedInputTokens + merged.cacheCreationTokens;

  return [
    {
      label: "Processed tokens",
      value: formatTokensCompact(merged.totalTokens),
      context:
        activeDays === 0
          ? null
          : `${formatTokensCompact(merged.totalTokens / activeDays)} per active day`,
    },
    {
      label: "Cached input",
      value: formatTokensCompact(merged.cachedInputTokens),
      context:
        observedInput === 0
          ? null
          : `${formatPercent(merged.cachedInputTokens / observedInput)} of observed input`,
    },
    {
      label: "Uncached input",
      value: formatTokensCompact(merged.uncachedInputTokens),
      context: `${formatTokensCompact(merged.cacheCreationTokens)} cache writes`,
    },
    {
      label: "Output",
      value: formatTokensCompact(merged.outputTokens),
      context:
        merged.reasoningTokens === 0
          ? null
          : `includes ${formatTokensCompact(merged.reasoningTokens)} reasoning`,
    },
    {
      label: "Cache savings",
      value: formatUsd(merged.costQuality.cacheSavingsUsd),
      context:
        merged.costUsd === 0
          ? null
          : `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the API-equivalent cost`,
    },
  ];
}

/**
 * Models worth a row.
 *
 * A scan turns up placeholder model names (`<synthetic>` among them) carrying
 * neither tokens nor cost. They are real records, but a row of zeros tells a
 * reader nothing except that the table is noisy.
 */
export function visibleUsageModels(merged: MergedUsage): MergedUsage["models"] {
  return merged.models.filter((model) => model.totalTokens > 0 || model.costUsd > 0);
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
