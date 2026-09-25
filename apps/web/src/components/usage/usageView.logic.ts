import {
  ProviderDriverKind,
  USAGE_MAX_WINDOW_DAYS,
  USAGE_WINDOW_DAY_OPTIONS,
  type ServerProvider,
  type UsageProviderKind,
  type UsageSource,
  type UsageWindowDays,
} from "@threadlines/contracts";
import {
  enumerateDays,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatTokensCompact,
  formatUsd,
  windowStartDay,
} from "@threadlines/shared/usageFormat";
import {
  sumUsagePeriods,
  type CostQuality,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
  type ModelTotals,
  type PeriodTotals,
  type UsageBreakdown,
  type UsageTally,
} from "@threadlines/shared/usageMerge";

import type { UsageEnvironmentReport } from "~/lib/usageReactQuery";
import { deriveProviderAccountUsagePresentationForProvider } from "~/lib/providerUsage";
import { formatProviderDriverKindLabel } from "~/providerModels";

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
 * The two brand hues, defined in `index.css` for both themes.
 *
 * Held as CSS variables rather than utility classes because the page paints
 * them into inline styles for bars and meters.
 */
export const USAGE_PROVIDER_COLORS: Record<UsageProviderKind, string> = {
  claude: "var(--provider-claude)",
  codex: "var(--provider-codex)",
};

/** Reading order for legends and rows: the same order every time. */
export const USAGE_PROVIDER_READING_ORDER: readonly UsageProviderKind[] = ["claude", "codex"];

/**
 * The per-model series colors from `index.css`, in stacking order. The order
 * is what the color-vision check validated, so bars stack in slot order.
 */
const USAGE_MODEL_COLORS = [
  "var(--usage-model-1)",
  "var(--usage-model-2)",
  "var(--usage-model-3)",
  "var(--usage-model-4)",
  "var(--usage-model-5)",
  "var(--usage-model-6)",
] as const;

export const USAGE_OTHER_MODEL_COLOR = "var(--usage-model-other)";

/** Series key for the models past the palette, folded into one gray band. */
const OTHER_MODELS_KEY = "other";

/**
 * Which palette slot each model owns.
 *
 * Assigned from the whole scan rather than the selected window, so switching
 * between 7, 30 and 90 days never repaints a model: color follows the model,
 * not its rank in the window. The leading Claude model takes slot 1, the
 * terracotta family; the rest fill the slots in token order.
 */
export function assignUsageModelSlots(models: readonly ModelTotals[]): ReadonlyMap<string, number> {
  const ranked = [...models].sort((a, b) => b.totalTokens - a.totalTokens);
  const slots = new Map<string, number>();
  const claudeLead = ranked.find((model) => model.provider === "claude");
  if (claudeLead) slots.set(claudeLead.key, 0);
  let next = claudeLead ? 1 : 0;
  for (const model of ranked) {
    if (next >= USAGE_MODEL_COLORS.length) break;
    if (slots.has(model.key)) continue;
    slots.set(model.key, next);
    next += 1;
  }
  return slots;
}

export function usageModelColor(slots: ReadonlyMap<string, number>, key: string): string {
  const slot = slots.get(key);
  return slot === undefined ? USAGE_OTHER_MODEL_COLOR : (USAGE_MODEL_COLORS[slot] ?? "");
}

/** Placeholder models (`<synthetic>` among them) carry neither tokens nor cost. */
export function visibleUsageModels(breakdown: UsageBreakdown): readonly ModelTotals[] {
  return breakdown.models.filter((model) => model.totalTokens > 0 || model.costUsd > 0);
}

/* -------------------------------------------------------------------------- */
/* Token kinds                                                                */
/* -------------------------------------------------------------------------- */

export type UsageTokenKind = "output" | "fresh" | "writes" | "reads";

interface UsageTokenKindSpec {
  readonly kind: UsageTokenKind;
  /** Ink density, heaviest for the tokens that cost the most per token. */
  readonly color: string;
  readonly read: (tally: UsageTally) => number;
}

/** Stacking order, bottom first: the scarce, expensive kinds sit on the baseline. */
const USAGE_TOKEN_KINDS: readonly UsageTokenKindSpec[] = [
  {
    kind: "output",
    color: "color-mix(in srgb, var(--foreground) 88%, transparent)",
    read: (tally) => tally.outputTokens,
  },
  {
    kind: "fresh",
    color: "color-mix(in srgb, var(--foreground) 62%, transparent)",
    read: (tally) => tally.uncachedInputTokens,
  },
  {
    kind: "writes",
    color: "color-mix(in srgb, var(--foreground) 40%, transparent)",
    read: (tally) => tally.cacheCreationTokens,
  },
  {
    kind: "reads",
    color: "color-mix(in srgb, var(--foreground) 20%, transparent)",
    read: (tally) => tally.cachedInputTokens,
  },
];

export interface UsageTokenMixRow {
  readonly kind: UsageTokenKind;
  readonly label: string;
  readonly hint: string | null;
  readonly tokens: number;
  readonly share: number;
  readonly color: string;
}

/**
 * The hero's reading order, largest first in practice: cache reads are the
 * agent re-reading its own context each turn and usually dwarf the rest.
 */
export const USAGE_TOKEN_MIX_ORDER: readonly UsageTokenKind[] = [
  "reads",
  "writes",
  "fresh",
  "output",
];

export const USAGE_TOKEN_KIND_LABELS: Record<UsageTokenKind, string> = {
  output: "Output",
  fresh: "Fresh input",
  writes: "Cache writes",
  reads: "Cache reads",
};

export function buildUsageTokenMix(merged: UsageBreakdown): readonly UsageTokenMixRow[] {
  return USAGE_TOKEN_MIX_ORDER.flatMap((kind) => {
    const spec = USAGE_TOKEN_KINDS.find((entry) => entry.kind === kind);
    if (!spec) return [];
    const tokens = spec.read(merged);
    return [
      {
        kind,
        label: USAGE_TOKEN_KIND_LABELS[kind],
        hint:
          kind === "reads"
            ? "re-read from cache"
            : kind === "output" && merged.reasoningTokens > 0
              ? `${formatTokensCompact(merged.reasoningTokens)} reasoning`
              : null,
        tokens,
        share: merged.totalTokens === 0 ? 0 : tokens / merged.totalTokens,
        color: spec.color,
      },
    ];
  });
}

/* -------------------------------------------------------------------------- */
/* Windows and periods                                                        */
/* -------------------------------------------------------------------------- */

/** The windows the page offers: the last 24 hours, then the day windows. */
export type UsagePageWindow = "24h" | UsageWindowDays;

export const USAGE_PAGE_WINDOWS: readonly UsagePageWindow[] = ["24h", ...USAGE_WINDOW_DAY_OPTIONS];

export function formatUsagePageWindow(window: UsagePageWindow): string {
  return window === "24h" ? "24h" : `${window}d`;
}

export type UsagePeriodUnit = "day" | "hour";

/** How many hours the 24h window shows; the same number before it is the comparison. */
const USAGE_WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** Start of the hour holding `timestampMs`, the same boundaries the server buckets on. */
export function hourStartOf(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

/** The words a unit brings to every label on the page. */
const USAGE_UNIT_WORDS = {
  day: {
    periodic: "Daily",
    plural: "days",
    listTitle: "Days",
    busiest: "Busiest day",
    current: "Today",
    currentSoFar: "Today so far",
    anAverage: "an average day",
    yourAverage: "your daily average",
  },
  hour: {
    periodic: "Hourly",
    plural: "hours",
    listTitle: "Hours",
    busiest: "Busiest hour",
    current: "This hour",
    currentSoFar: "This hour so far",
    anAverage: "an average hour",
    yourAverage: "your hourly average",
  },
} as const satisfies Record<UsagePeriodUnit, Record<string, string>>;

export function usageListTitle(unit: UsagePeriodUnit): string {
  return USAGE_UNIT_WORDS[unit].listTitle;
}

/** One day or one hour of the window, present whether or not it had usage. */
export interface UsagePeriod {
  readonly key: string;
  /** "Wed Sep 23" or "Wed 2 PM". */
  readonly label: string;
  /** For the chart's axis: "Sep 23" or "2 PM". */
  readonly tickLabel: string;
  /** Today, or this hour: still filling up. */
  readonly isCurrent: boolean;
  readonly totals: PeriodTotals | null;
}

/**
 * Everything the page draws for the selected window, in one shape whether the
 * window counts days or hours: every period in order, the window added up,
 * and the same stretch right before it for comparison.
 */
export interface UsageWindowView {
  readonly unit: UsagePeriodUnit;
  /** Oldest first, one per calendar day or hour, idle ones included. */
  readonly periods: readonly UsagePeriod[];
  readonly breakdown: UsageBreakdown;
  readonly rangeLabel: string;
  readonly previous:
    | { readonly totalTokens: number; readonly rangeLabel: string }
    | { readonly unavailable: string };
}

/** A day window, narrowed from the scan by {@link deriveUsageWindow}. */
export function buildDayWindowView(input: {
  /** The window's merge. */
  readonly merged: MergedUsage;
  /** The whole scan's days, which reach back before the window. */
  readonly scanDaily: readonly DailyTotals[];
  readonly scanSinceDay: string;
  readonly sinceDay: string;
  readonly untilDay: string;
}): UsageWindowView {
  const byDay = new Map(input.merged.daily.map((entry) => [entry.day, entry]));
  const days = enumerateDays(input.sinceDay, input.untilDay);
  const previousUntil = windowStartDay(input.sinceDay, 2);
  const previousSince = windowStartDay(previousUntil, days.length);
  const previousTotal = input.scanDaily
    .filter((entry) => entry.day >= previousSince && entry.day <= previousUntil)
    .reduce((sum, entry) => sum + entry.totalTokens, 0);

  return {
    unit: "day",
    periods: days.map((day) => ({
      key: day,
      label: formatDayWithWeekday(day),
      tickLabel: formatDayShort(day),
      isCurrent: day === input.untilDay,
      totals: byDay.get(day) ?? null,
    })),
    breakdown: input.merged,
    rangeLabel: formatUsageDateRange(input.sinceDay, input.untilDay),
    // The scan reaches back USAGE_MAX_WINDOW_DAYS, so the longest window has
    // nothing to compare against and says so rather than using a partial one.
    previous:
      previousSince < input.scanSinceDay
        ? { unavailable: `Usage reaches back ${USAGE_MAX_WINDOW_DAYS} days` }
        : previousTotal === 0
          ? { unavailable: `No activity in the ${days.length} days before` }
          : {
              totalTokens: previousTotal,
              rangeLabel: formatUsageDateRange(previousSince, previousUntil),
            },
  };
}

/**
 * Hour labels in the viewer's zone. Buckets start on absolute hours, which a
 * half-hour zone (India, Newfoundland, central Australia) sees at :30 past, so
 * minutes show whenever the local start is not on the hour.
 */
function hourFormatter(options: Intl.DateTimeFormatOptions): (hourStartMs: number) => string {
  const onTheHour = new Intl.DateTimeFormat("en-US", { ...options, hour: "numeric" });
  const offTheHour = new Intl.DateTimeFormat("en-US", {
    ...options,
    hour: "numeric",
    minute: "2-digit",
  });
  return (hourStartMs) =>
    (new Date(hourStartMs).getMinutes() === 0 ? onTheHour : offTheHour).format(hourStartMs);
}

const formatHourTick = hourFormatter({});
const formatHourLabel = hourFormatter({ weekday: "short" });
const formatHourRangeStart = hourFormatter({ month: "short", day: "numeric" });

/**
 * The last 24 hours, ending with the hour that holds `anchorMs`. Labels are in
 * the viewer's own time zone; the hours themselves are absolute, so every
 * machine's usage lines up whatever its zone.
 */
export function buildHourWindowView(input: {
  readonly hourly: readonly HourlyTotals[];
  /** When the scan was read. The window ends on that hour, not on "now". */
  readonly anchorMs: number;
}): UsageWindowView {
  const lastHour = hourStartOf(input.anchorMs);
  const firstHour = lastHour - (USAGE_WINDOW_HOURS - 1) * HOUR_MS;
  const byHour = new Map(input.hourly.map((entry) => [entry.hourStartMs, entry]));
  const hours = Array.from({ length: USAGE_WINDOW_HOURS }, (_unused, index) => {
    return firstHour + index * HOUR_MS;
  });
  const inWindow = hours.flatMap((hour) => {
    const entry = byHour.get(hour);
    return entry ? [entry] : [];
  });
  const previousTotal = input.hourly
    .filter((entry) => entry.hourStartMs < firstHour)
    .filter((entry) => entry.hourStartMs >= firstHour - USAGE_WINDOW_HOURS * HOUR_MS)
    .reduce((sum, entry) => sum + entry.totalTokens, 0);

  return {
    unit: "hour",
    periods: hours.map((hour) => ({
      key: String(hour),
      label: formatHourLabel(hour),
      tickLabel: formatHourTick(hour),
      isCurrent: hour === lastHour,
      totals: byHour.get(hour) ?? null,
    })),
    breakdown: sumUsagePeriods(inWindow),
    rangeLabel: `${formatHourRangeStart(firstHour)} to now`,
    previous:
      previousTotal === 0
        ? { unavailable: `No activity in the ${USAGE_WINDOW_HOURS} hours before` }
        : { totalTokens: previousTotal, rangeLabel: `the ${USAGE_WINDOW_HOURS} hours before` },
  };
}

/**
 * One line naming the machines whose server predates hourly usage, for the
 * 24h window only: their days count, but their hours would silently read as
 * zero without it.
 */
export function formatHourlyMissingNote(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  const one = labels.length === 1;
  return `${labels.join(", ")} ${one ? "runs" : "run"} an older Threadlines, so ${
    one ? "its" : "their"
  } last 24 hours are not counted here.`;
}

/* -------------------------------------------------------------------------- */
/* Chart                                                                      */
/* -------------------------------------------------------------------------- */

export type UsageChartGroup = "models" | "providers" | "kinds";

export const USAGE_CHART_GROUPS: readonly UsageChartGroup[] = ["models", "providers", "kinds"];

export const USAGE_CHART_GROUP_LABELS: Record<UsageChartGroup, string> = {
  models: "By model",
  providers: "By provider",
  kinds: "By token type",
};

export type UsageChartMetric = "tokens" | "cost";

export const USAGE_CHART_METRICS: readonly UsageChartMetric[] = ["tokens", "cost"];

export const USAGE_CHART_METRIC_LABELS: Record<UsageChartMetric, string> = {
  tokens: "Tokens",
  cost: "Cost",
};

/**
 * Whether a split can be drawn in a measure. Buckets carry one cost figure for
 * all their tokens, so cost cannot be divided by token kind, and cache reads
 * cannot be taken out of it.
 */
export function usageChartGroupSupportsMetric(
  group: UsageChartGroup,
  metric: UsageChartMetric,
): boolean {
  return !(group === "kinds" && metric === "cost");
}

export function usageChartTitle(
  unit: UsagePeriodUnit,
  metric: UsageChartMetric,
  includeCacheReads: boolean,
): string {
  const periodic = USAGE_UNIT_WORDS[unit].periodic;
  if (metric === "cost") return `${periodic} API-equivalent cost`;
  return includeCacheReads ? `${periodic} tokens` : `${periodic} tokens, without cache reads`;
}

interface UsageChartSeriesSpec {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly value: (period: PeriodTotals) => number;
}

export interface UsageChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export interface UsageChartGridline {
  readonly value: number;
  readonly label: string;
  /** Distance from the top of the plot, as a percentage. */
  readonly topPercent: number;
}

export interface UsageChartSegment {
  readonly key: string;
  readonly color: string;
  /** Share of the column's own height. */
  readonly percent: number;
}

export interface UsageChartEntry {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly valueLabel: string;
  readonly shareLabel: string;
}

/** One day or hour: its bar, and everything the hover card says about it. */
export interface UsageChartColumn {
  readonly key: string;
  /** For the hover card, with "today so far" or "this hour so far" when current. */
  readonly label: string;
  /** Bar height as a share of the plot. */
  readonly heightPercent: number;
  /** Bottom first, in series order, zeros dropped. */
  readonly segments: readonly UsageChartSegment[];
  /** Largest first, so the card reads as "who carried the day". */
  readonly entries: readonly UsageChartEntry[];
  readonly totalLabel: string;
  /** Against the average active period in the window, or `null` when idle. */
  readonly comparisonLabel: string | null;
}

export interface UsageBarChart {
  /** Legend order, which is also stacking order from the baseline up. */
  readonly series: readonly UsageChartSeries[];
  readonly gridlines: readonly UsageChartGridline[];
  /** Window start, midpoint and end. Three ticks, whatever the window length. */
  readonly axisLabels: readonly string[];
  readonly columns: readonly UsageChartColumn[];
  readonly isEmpty: boolean;
}

const GRIDLINE_COUNT = 4;

function tallyValue(
  tally: UsageTally | undefined,
  metric: UsageChartMetric,
  includeCacheReads: boolean,
): number {
  if (!tally) return 0;
  if (metric === "cost") return tally.costUsd;
  return includeCacheReads ? tally.totalTokens : tally.totalTokens - tally.cachedInputTokens;
}

function chartSeriesSpecs(input: {
  readonly group: UsageChartGroup;
  readonly metric: UsageChartMetric;
  readonly includeCacheReads: boolean;
  readonly breakdown: UsageBreakdown;
  readonly modelSlots: ReadonlyMap<string, number>;
}): readonly UsageChartSeriesSpec[] {
  const { metric, includeCacheReads } = input;
  if (input.group === "providers") {
    const present = new Set(input.breakdown.providers.map((entry) => entry.provider));
    return USAGE_PROVIDER_READING_ORDER.filter((provider) => present.has(provider)).map(
      (provider) => ({
        key: provider,
        label: USAGE_PROVIDER_LABELS[provider],
        color: USAGE_PROVIDER_COLORS[provider],
        value: (period) => tallyValue(period.byProvider.get(provider), metric, includeCacheReads),
      }),
    );
  }
  if (input.group === "kinds") {
    return USAGE_TOKEN_KINDS.filter((spec) => includeCacheReads || spec.kind !== "reads").map(
      (spec) => ({
        key: spec.kind,
        label: USAGE_TOKEN_KIND_LABELS[spec.kind],
        color: spec.color,
        value: (period) => spec.read(period),
      }),
    );
  }
  const models = visibleUsageModels(input.breakdown);
  const slotted = models
    .filter((model) => input.modelSlots.has(model.key))
    .sort((a, b) => (input.modelSlots.get(a.key) ?? 0) - (input.modelSlots.get(b.key) ?? 0));
  const folded = models.filter((model) => !input.modelSlots.has(model.key));
  const specs: UsageChartSeriesSpec[] = slotted.map((model) => ({
    key: model.key,
    label: model.model,
    color: usageModelColor(input.modelSlots, model.key),
    value: (period) => tallyValue(period.byModel.get(model.key), metric, includeCacheReads),
  }));
  if (folded.length > 0) {
    specs.push({
      key: OTHER_MODELS_KEY,
      label: formatMoreModels(folded.length),
      color: USAGE_OTHER_MODEL_COLOR,
      value: (period) =>
        folded.reduce(
          (sum, model) =>
            sum + tallyValue(period.byModel.get(model.key), metric, includeCacheReads),
          0,
        ),
    });
  }
  return specs;
}

function formatMoreModels(count: number): string {
  return count === 1 ? "1 more model" : `${count} more models`;
}

/**
 * One stacked bar per day or hour of the window, idle ones included: a gap is
 * information, and dropping it would compress the axis into a lie about when
 * the work happened.
 */
export function buildUsageBarChart(input: {
  readonly view: UsageWindowView;
  readonly group: UsageChartGroup;
  readonly metric: UsageChartMetric;
  readonly includeCacheReads: boolean;
  readonly modelSlots: ReadonlyMap<string, number>;
}): UsageBarChart {
  const { view } = input;
  const words = USAGE_UNIT_WORDS[view.unit];
  const specs = chartSeriesSpecs({ ...input, breakdown: view.breakdown });
  const formatValue = input.metric === "cost" ? formatUsd : formatTokensCompact;

  const valuesByPeriod = view.periods.map((period) =>
    specs.map((spec) => (period.totals ? Math.max(0, spec.value(period.totals)) : 0)),
  );
  const totals = valuesByPeriod.map((values) => values.reduce((sum, value) => sum + value, 0));
  const activeTotals = totals.filter((total) => total > 0);
  const average =
    activeTotals.length === 0
      ? 0
      : activeTotals.reduce((sum, total) => sum + total, 0) / activeTotals.length;
  const axisMax = niceAxisMax(Math.max(0, ...totals));
  // A series that is zero across the whole window earns no legend entry.
  const present = specs.map((_spec, index) =>
    valuesByPeriod.some((values) => (values[index] ?? 0) > 0),
  );

  return {
    series: specs.flatMap((spec, index) =>
      present[index] ? [{ key: spec.key, label: spec.label, color: spec.color }] : [],
    ),
    gridlines: axisMax === 0 ? [] : buildGridlines(axisMax, input.metric),
    // The window always ends now, and "today" or "now" orients a reader faster
    // than a date or hour they would have to check against a clock.
    axisLabels: axisTicks(view.periods).map((period, index, ticks) =>
      index === ticks.length - 1
        ? view.unit === "day"
          ? "TODAY"
          : "NOW"
        : period.tickLabel.toUpperCase(),
    ),
    columns: view.periods.map((period, periodIndex) => {
      const values = valuesByPeriod[periodIndex] ?? [];
      const total = totals[periodIndex] ?? 0;
      const indexed = specs.map((spec, index) => ({ spec, value: values[index] ?? 0 }));
      return {
        key: period.key,
        label: period.isCurrent
          ? `${period.label} · ${words.currentSoFar.toLowerCase()}`
          : period.label,
        heightPercent: axisMax === 0 ? 0 : (total / axisMax) * 100,
        segments: indexed
          .filter((entry) => entry.value > 0)
          .map((entry) => ({
            key: entry.spec.key,
            color: entry.spec.color,
            percent: (entry.value / total) * 100,
          })),
        entries: indexed
          .filter((entry) => entry.value > 0)
          .sort((a, b) => b.value - a.value)
          .map((entry) => ({
            key: entry.spec.key,
            label: entry.spec.label,
            color: entry.spec.color,
            valueLabel: formatValue(entry.value),
            shareLabel: formatPercent(entry.value / total, 0),
          })),
        totalLabel: formatValue(total),
        comparisonLabel:
          total > 0 && average > 0
            ? formatAgainstAverage(total / average, words.yourAverage)
            : null,
      };
    }),
    isEmpty: activeTotals.length === 0,
  };
}

function formatAgainstAverage(ratio: number, yourAverage: string): string {
  return ratio >= 1
    ? `${ratio.toFixed(1)}x ${yourAverage}`
    : `${formatPercent(ratio, 0)} of ${yourAverage}`;
}

/** Start, middle and end, de-duplicated for windows too short to have three. */
function axisTicks(periods: readonly UsagePeriod[]): readonly UsagePeriod[] {
  if (periods.length === 0) return [];
  const ticks = [
    periods[0],
    periods[Math.floor((periods.length - 1) / 2)],
    periods[periods.length - 1],
  ];
  return [...new Set(ticks.filter((period): period is UsagePeriod => period !== undefined))];
}

function buildGridlines(axisMax: number, metric: UsageChartMetric): readonly UsageChartGridline[] {
  return Array.from({ length: GRIDLINE_COUNT }, (_unused, index) => {
    const fraction = (GRIDLINE_COUNT - index) / GRIDLINE_COUNT;
    const value = axisMax * fraction;
    return {
      value,
      label: metric === "cost" ? formatUsd(value) : formatTokens(value),
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `2026-09-23` to `Wed Sep 23`. */
export function formatDayWithWeekday(day: string): string {
  const [year = 0, month = 1, dayOfMonth = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay()] ?? "";
  return `${weekday} ${formatDayShort(day)}`;
}

/** `2026-07-12` and `2026-08-10` to `Jul 12 to Aug 10`. */
export function formatUsageDateRange(sinceDay: string, untilDay: string): string {
  return `${formatDayShort(sinceDay)} to ${formatDayShort(untilDay)}`;
}

/* -------------------------------------------------------------------------- */
/* Stats band                                                                 */
/* -------------------------------------------------------------------------- */

export interface UsageStat {
  readonly label: string;
  readonly value: string;
  /** One line of context, or nothing when the figure has none worth adding. */
  readonly context: string | null;
}

/** The band's labels, which the loading state shows before any figure exists. */
export function usageStatLabels(unit: UsagePeriodUnit, periodCount: number): readonly string[] {
  const words = USAGE_UNIT_WORDS[unit];
  return [
    `${words.periodic} average`,
    words.busiest,
    words.currentSoFar,
    "Cache hit rate",
    `vs previous ${periodCount} ${words.plural}`,
  ];
}

/**
 * The band under the hero: how a usual day or hour looks, and how this window
 * compares with the stretch before it.
 *
 * Averages divide by periods that had any tokens at all. Dividing by calendar
 * days would make a week off look like a drop in intensity rather than a week
 * off.
 */
export function buildUsageStats(view: UsageWindowView): readonly UsageStat[] {
  const words = USAGE_UNIT_WORDS[view.unit];
  const [
    averageLabel = "",
    busiestLabel = "",
    currentLabel = "",
    cacheLabel = "",
    previousLabel = "",
  ] = usageStatLabels(view.unit, view.periods.length);
  const { breakdown } = view;
  const active = view.periods.filter((period) => (period.totals?.totalTokens ?? 0) > 0);
  const average = active.length === 0 ? 0 : breakdown.totalTokens / active.length;
  const busiest = active.reduce<UsagePeriod | null>(
    (best, period) =>
      best === null || (period.totals?.totalTokens ?? 0) > (best.totals?.totalTokens ?? 0)
        ? period
        : best,
    null,
  );
  const current = view.periods.find((period) => period.isCurrent)?.totals?.totalTokens ?? 0;
  const observedInput =
    breakdown.uncachedInputTokens + breakdown.cachedInputTokens + breakdown.cacheCreationTokens;

  return [
    {
      label: averageLabel,
      value: formatTokensCompact(average),
      context: `${active.length} of ${view.periods.length} ${words.plural} active`,
    },
    {
      label: busiestLabel,
      value: formatTokensCompact(busiest?.totals?.totalTokens ?? 0),
      context: busiest ? busiest.label : null,
    },
    {
      label: currentLabel,
      value: formatTokensCompact(current),
      context:
        average === 0 ? null : `${formatPercent(current / average, 0)} of ${words.anAverage}`,
    },
    {
      label: cacheLabel,
      value: formatPercent(observedInput === 0 ? 0 : breakdown.cachedInputTokens / observedInput),
      context: "of input came from cache",
    },
    "unavailable" in view.previous
      ? { label: previousLabel, value: "n/a", context: view.previous.unavailable }
      : {
          label: previousLabel,
          value: formatChange(breakdown.totalTokens / view.previous.totalTokens - 1),
          context:
            view.unit === "day"
              ? `${formatTokensCompact(view.previous.totalTokens)} from ${view.previous.rangeLabel}`
              : `${formatTokensCompact(view.previous.totalTokens)} in ${view.previous.rangeLabel}`,
        },
  ];
}

function formatChange(change: number): string {
  return `${change >= 0 ? "+" : "-"}${formatPercent(Math.abs(change), 0)}`;
}

/* -------------------------------------------------------------------------- */
/* Models and periods                                                         */
/* -------------------------------------------------------------------------- */

export interface UsageModelRow extends ModelTotals {
  readonly color: string;
  readonly cacheHitShare: number;
  /**
   * Tokens across the window, binned to at most 30 bars. Each bar is keyed by
   * the first period it covers, with a height from 0 to 1.
   */
  readonly trend: readonly { readonly key: string; readonly height: number }[];
}

const TREND_MAX_BINS = 30;

export function buildUsageModelRows(input: {
  readonly view: UsageWindowView;
  readonly modelSlots: ReadonlyMap<string, number>;
}): readonly UsageModelRow[] {
  const { periods } = input.view;
  const binCount = Math.min(TREND_MAX_BINS, periods.length);
  const perBin = periods.length / Math.max(1, binCount);

  return visibleUsageModels(input.view.breakdown).map((model) => {
    const bins = Array.from({ length: binCount }, (_unused, bin) => {
      const binPeriods = periods.slice(Math.floor(bin * perBin), Math.floor((bin + 1) * perBin));
      return {
        key: binPeriods[0]?.key ?? String(bin),
        tokens: binPeriods.reduce(
          (sum, period) => sum + (period.totals?.byModel.get(model.key)?.totalTokens ?? 0),
          0,
        ),
      };
    });
    const peak = Math.max(0, ...bins.map((bin) => bin.tokens));
    const observedInput =
      model.uncachedInputTokens + model.cachedInputTokens + model.cacheCreationTokens;
    return {
      ...model,
      color: usageModelColor(input.modelSlots, model.key),
      cacheHitShare: observedInput === 0 ? 0 : model.cachedInputTokens / observedInput,
      trend: bins.map((bin) => ({ key: bin.key, height: peak === 0 ? 0 : bin.tokens / peak })),
    };
  });
}

export interface UsagePeriodModel {
  readonly key: string;
  readonly model: string;
  readonly color: string;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly records: number;
  /** Share of the period's tokens. */
  readonly share: number;
}

export interface UsagePeriodRow {
  readonly key: string;
  /** "Today" or "This hour" for the current period. */
  readonly label: string;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly records: number;
  /** Bar length against the busiest period in the window. */
  readonly widthPercent: number;
  /** The period's models in palette order, so every row's bar reads the same way. */
  readonly segments: readonly {
    readonly key: string;
    readonly color: string;
    readonly tokens: number;
  }[];
  /** Largest first. */
  readonly models: readonly UsagePeriodModel[];
}

const MIN_PERIOD_SEGMENT_SHARE = 0.005;

/**
 * The days or hours breakdown, newest first. Idle periods are dropped: unlike
 * the chart, where a gap is information, a table of zero rows buries the ones
 * that had something to say.
 */
export function buildUsagePeriodRows(input: {
  readonly view: UsageWindowView;
  readonly modelSlots: ReadonlyMap<string, number>;
}): readonly UsagePeriodRow[] {
  const words = USAGE_UNIT_WORDS[input.view.unit];
  const active = input.view.periods.flatMap((period) =>
    period.totals && (period.totals.totalTokens > 0 || period.totals.costUsd > 0)
      ? [{ period, totals: period.totals }]
      : [],
  );
  const busiest = Math.max(0, ...active.map((entry) => entry.totals.totalTokens));
  const slotOf = (key: string) => input.modelSlots.get(key) ?? USAGE_MODEL_COLORS.length;

  return active
    .map(({ period, totals }) => {
      const models = [...totals.byModel.entries()]
        .filter(([, tally]) => tally.totalTokens > 0 || tally.costUsd > 0)
        .map(([key, tally]) => ({
          key,
          model: tally.model,
          color: usageModelColor(input.modelSlots, key),
          totalTokens: tally.totalTokens,
          costUsd: tally.costUsd,
          records: tally.records,
          share: totals.totalTokens === 0 ? 0 : tally.totalTokens / totals.totalTokens,
        }));
      return {
        key: period.key,
        label: period.isCurrent ? words.current : period.label,
        totalTokens: totals.totalTokens,
        costUsd: totals.costUsd,
        records: totals.records,
        widthPercent: busiest === 0 ? 0 : (totals.totalTokens / busiest) * 100,
        segments: [...models]
          // A sliver narrower than its own gap is noise; the expanded list keeps it.
          .filter((model) => model.share >= MIN_PERIOD_SEGMENT_SHARE)
          .sort((a, b) => slotOf(a.key) - slotOf(b.key) || b.totalTokens - a.totalTokens)
          .map((model) => ({ key: model.key, color: model.color, tokens: model.totalTokens })),
        models: models.sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd),
      };
    })
    .toReversed();
}

/* -------------------------------------------------------------------------- */
/* Plan limits                                                                */
/* -------------------------------------------------------------------------- */

export interface UsagePlanLimitMeter {
  readonly key: string;
  readonly label: string;
  /** "62% used · resets in 1h 48m", worded by the shared presentation. */
  readonly detail: string;
  readonly usedPercent: number;
  readonly warning: boolean;
  readonly reachedLimit: boolean;
}

export interface UsagePlanLimitRow {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly provider: UsageProviderKind | null;
  readonly meters: readonly UsagePlanLimitMeter[];
}

const USAGE_PROVIDER_BY_DRIVER: ReadonlyMap<ProviderDriverKind, UsageProviderKind> = new Map([
  [ProviderDriverKind.make("claudeAgent"), "claude"],
  [ProviderDriverKind.make("codex"), "codex"],
]);

/**
 * The subscription windows each enabled provider reports: the same meters the
 * provider cards in Settings and the composer's hover card draw, read through
 * the same presentation. Providers with nothing to meter (API keys) are left
 * out rather than shown as empty rows.
 */
export function buildUsagePlanLimitRows(
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): readonly UsagePlanLimitRow[] {
  return providers.flatMap((provider) => {
    if (!provider.enabled) return [];
    const presentation = deriveProviderAccountUsagePresentationForProvider(provider, nowMs);
    if (!presentation) return [];
    const meters: UsagePlanLimitMeter[] = presentation.windows.map((window) => ({
      key: window.key,
      label: window.label,
      detail: window.detail,
      usedPercent: window.usedPercent,
      warning: window.warning,
      reachedLimit: window.reachedLimit,
    }));
    if (presentation.spendControl) {
      meters.push({
        key: "spend-control",
        label: presentation.spendControl.label,
        detail: presentation.spendControl.detail,
        usedPercent: presentation.spendControl.usedPercent,
        warning: presentation.spendControl.warning,
        reachedLimit: presentation.spendControl.reachedLimit,
      });
    }
    if (meters.length === 0) return [];
    return [
      {
        instanceId: provider.instanceId,
        driver: provider.driver,
        label: provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver),
        provider: USAGE_PROVIDER_BY_DRIVER.get(provider.driver) ?? null,
        meters,
      },
    ];
  });
}

/* -------------------------------------------------------------------------- */
/* Machines                                                                   */
/* -------------------------------------------------------------------------- */

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
