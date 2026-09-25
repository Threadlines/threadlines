import type { UsageProviderKind } from "@threadlines/contracts";
import {
  formatCount,
  formatPercent,
  formatTokens,
  formatTokensCompact,
  formatUsd,
} from "@threadlines/shared/usageFormat";
import type { UsageBreakdown } from "@threadlines/shared/usageMerge";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { useNavigateBackWithinApp } from "../../hooks/useNavigateBackWithinApp";
import { usageMeterColor } from "../../lib/providerUsage";
import { cn } from "../../lib/utils";
import {
  deriveUsageWindow,
  usageSummaryQueryOptions,
  useUsageEnvironmentTargets,
} from "../../lib/usageReactQuery";
import { useServerProviders } from "../../rpc/serverState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PageTitlebar } from "../PageTitlebar";
import { ClaudeAI, OpenAI, type Icon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Skeleton } from "../ui/skeleton";
import {
  assignUsageModelSlots,
  buildDayWindowView,
  buildHourWindowView,
  buildUsageBarChart,
  buildUsageMachineRows,
  buildUsageModelRows,
  buildUsagePeriodRows,
  buildUsagePlanLimitRows,
  buildUsageStats,
  buildUsageTokenMix,
  formatCostQualityFootnote,
  formatHourlyMissingNote,
  formatUsagePageWindow,
  USAGE_CHART_GROUP_LABELS,
  USAGE_CHART_GROUPS,
  USAGE_CHART_METRIC_LABELS,
  USAGE_CHART_METRICS,
  USAGE_MACHINE_STATE_LABELS,
  USAGE_PAGE_WINDOWS,
  USAGE_PROVIDER_COLORS,
  USAGE_PROVIDER_LABELS,
  USAGE_PROVIDER_READING_ORDER,
  USAGE_PROVIDER_SHORT_LABELS,
  USAGE_TOKEN_KIND_LABELS,
  USAGE_TOKEN_MIX_ORDER,
  usageChartGroupSupportsMetric,
  usageChartTitle,
  usageListTitle,
  usageStatLabels,
  visibleUsageModels,
  type UsageBarChart,
  type UsageChartGroup,
  type UsageChartMetric,
  type UsageMachineRow,
  type UsageModelRow,
  type UsagePageWindow,
  type UsagePeriodRow,
  type UsagePeriodUnit,
  type UsageStat,
  type UsageTokenMixRow,
} from "./usageView.logic";

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none";
const COLUMN_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-wider text-muted-foreground/40 select-none";
const NUMBER_CLASS = "font-mono tabular-nums";
const HERO_GRID_CLASS =
  "mt-7 grid grid-cols-1 gap-8 @4xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]";
const USAGE_STATS_BAND_CLASS =
  "mt-8 grid w-full min-w-0 max-w-full grid-cols-1 divide-y divide-border/60 overflow-x-clip border-y border-border/60 @xl:grid-cols-5 @xl:divide-x @xl:divide-y-0";
const USAGE_STAT_CELL_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-2.5 @xl:flex @xl:flex-col @xl:items-stretch @xl:gap-1 @xl:px-2 @xl:py-3.5 @xl:first:pl-0 @xl:last:pr-0 @4xl:px-4";
const USAGE_STAT_LABEL_CLASS = "min-w-0 whitespace-nowrap text-[9px] @4xl:text-[10px]";
const USAGE_STAT_VALUE_CLASS = "shrink-0 text-base leading-tight text-foreground @4xl:text-[20px]";
const USAGE_STAT_CONTEXT_CLASS =
  "col-span-2 min-w-0 [overflow-wrap:anywhere] text-[11px] leading-snug text-muted-foreground/55 @xl:col-auto @4xl:text-xs";
/**
 * Columns appear as the pane widens: name, tokens and share on a phone, then
 * cost, then the full set. Container queries, because the pane shares the
 * window with the sidebar and the viewport says little about its width.
 */
const MODEL_GRID_CLASS =
  "grid grid-cols-[minmax(0,1fr)_4rem_2.75rem] items-center gap-3 @xl:grid-cols-[minmax(0,1fr)_4.5rem_minmax(4rem,7rem)_4.5rem] @4xl:grid-cols-[minmax(0,1fr)_4.5rem_minmax(5rem,8rem)_4.5rem_4rem_4.5rem_5.5rem_4.5rem]";
const DAY_GRID_CLASS =
  "grid grid-cols-[6.5rem_3.75rem_minmax(0,1fr)] items-center gap-3 @xl:grid-cols-[7rem_4.5rem_minmax(0,1fr)_4.5rem] @4xl:grid-cols-[7.5rem_4.5rem_minmax(0,1.6fr)_minmax(0,1.2fr)_4.5rem_4.5rem]";
/** Scan freshness and plan-limit resets are relative labels; one slow clock drives both. */
const FRESHNESS_TICK_MS = 30_000;
/** The window a first-time reader gets: a week is too short to see a pattern. */
const DEFAULT_WINDOW: UsagePageWindow = 30;
/** Enough rows to see a fortnight or half a day at a glance; the rest are one click away. */
const PERIOD_ROW_LIMIT = 10;

/** The same glyphs the model picker draws, keyed by the usage contract's names. */
const USAGE_PROVIDER_ICONS: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
};

function shareDigits(share: number): number {
  return share > 0 && share < 0.1 ? 1 : 0;
}

/**
 * What the provider CLIs' own transcripts say this account has used, merged
 * across every computer Threadlines knows about. Tokens lead; cost is the API
 * list-price equivalent, never billed spend, and the page says so.
 *
 * One scan covers the longest window on offer and the selector narrows it here,
 * so switching between 24 hours and 7, 30 or 90 days is a recompute rather
 * than a wait.
 */
export function UsageView() {
  const [selectedWindow, setSelectedWindow] = useState<UsagePageWindow>(DEFAULT_WINDOW);
  const [chartGroup, setChartGroup] = useState<UsageChartGroup>("models");
  const [chartMetric, setChartMetric] = useState<UsageChartMetric>("tokens");
  const [includeCacheReads, setIncludeCacheReads] = useState(true);
  const handleBackClick = useNavigateBackWithinApp();
  const nowMs = useRelativeTimeTick(FRESHNESS_TICK_MS);
  const targets = useUsageEnvironmentTargets();
  const usageQuery = useQuery(usageSummaryQueryOptions({ targets }));
  const scan = usageQuery.data ?? null;

  // Day windows narrow the scan; the 24h window reads the scan's own hours.
  const view = useMemo(() => {
    if (!scan) return null;
    if (selectedWindow === "24h") {
      return buildHourWindowView({ hourly: scan.merged.hourly, anchorMs: scan.readAtMs });
    }
    const narrowed = deriveUsageWindow(scan, selectedWindow);
    return buildDayWindowView({
      merged: narrowed.merged,
      scanDaily: scan.merged.daily,
      scanSinceDay: scan.window.sinceDay,
      sinceDay: narrowed.window.sinceDay,
      untilDay: narrowed.window.untilDay,
    });
  }, [scan, selectedWindow]);

  // Slots come from the whole scan, so a window switch never repaints a model.
  const modelSlots = useMemo(
    () =>
      scan ? assignUsageModelSlots(visibleUsageModels(scan.merged)) : new Map<string, number>(),
    [scan],
  );
  const chart = useMemo(
    () =>
      view
        ? buildUsageBarChart({
            view,
            group: chartGroup,
            metric: chartMetric,
            includeCacheReads,
            modelSlots,
          })
        : null,
    [chartGroup, chartMetric, includeCacheReads, modelSlots, view],
  );
  const stats = useMemo(() => (view ? buildUsageStats(view) : []), [view]);
  const modelRows = useMemo(
    () => (view ? buildUsageModelRows({ view, modelSlots }) : []),
    [modelSlots, view],
  );
  const periodRows = useMemo(
    () => (view ? buildUsagePeriodRows({ view, modelSlots }) : []),
    [modelSlots, view],
  );
  const tokenMix = useMemo(() => (view ? buildUsageTokenMix(view.breakdown) : []), [view]);
  // The machines answered for the whole scan, not for the selected window, so
  // they are read from the scan and never move when the selector does.
  const machines = useMemo(
    () =>
      scan
        ? buildUsageMachineRows({
            environments: scan.environments,
            staleEnvironments: scan.merged.staleEnvironments,
          })
        : [],
    [scan],
  );
  const hourlyMissingNote = useMemo(() => {
    if (!scan || selectedWindow !== "24h") return null;
    const missing = new Set<string>(scan.merged.hourlyMissingEnvironments);
    return formatHourlyMissingNote(
      scan.environments
        .filter((environment) => missing.has(environment.environmentId))
        .map((environment) => environment.label),
    );
  }, [scan, selectedWindow]);

  const handleMetricChange = (metric: UsageChartMetric) => {
    setChartMetric(metric);
    // Cost has no split by token kind; fall back to the default split.
    if (!usageChartGroupSupportsMetric(chartGroup, metric)) setChartGroup("models");
  };

  const hasTargets = targets.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="usage-view">
      {!isElectron ? (
        <header className="shrink-0 border-b border-border pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)] md:hidden">
          <div className="flex min-h-7 items-center gap-2">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Back to previous page"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              data-testid="usage-mobile-back"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon />
            </Button>
            <span className="text-sm font-medium text-foreground">Usage</span>
          </div>
        </header>
      ) : null}
      <PageTitlebar label="Usage" mobile="none" />
      {/* The pane-wide element scrolls so the scrollbar hugs the pane's edge
          (like Settings); the reading column centers inside it. */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="usage-scroll">
        <div className="@container mx-auto flex min-h-full w-full max-w-[1200px] flex-col px-6 py-8">
          {/* The window picker changes every section, so it sits with the
              page title rather than with any one of them. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-lg font-medium tracking-tight">Usage</h1>
              {view ? (
                <span
                  className={cn(NUMBER_CLASS, "whitespace-nowrap text-xs text-muted-foreground/55")}
                  data-testid="usage-date-range"
                >
                  {view.rangeLabel}
                </span>
              ) : hasTargets && !usageQuery.isError ? (
                <Skeleton
                  className="h-3 w-32 rounded-full"
                  data-testid="usage-date-range-skeleton"
                />
              ) : null}
            </div>
            <div className="flex-1" />
            {hasTargets && !usageQuery.isError ? (
              <UsageWindowControls
                selected={selectedWindow}
                isFetching={usageQuery.isFetching}
                disabled={!view}
                onWindowChange={setSelectedWindow}
                onRefresh={() => void usageQuery.refetch()}
              />
            ) : null}
          </div>

          <UsagePlanLimits nowMs={nowMs} />

          {!hasTargets ? (
            <p className="mt-10 text-sm text-muted-foreground/60">
              No computers are connected, so there is nothing to report yet.
            </p>
          ) : usageQuery.isError ? (
            <p className="mt-10 text-sm text-muted-foreground/60">Usage could not be read.</p>
          ) : !scan || !view || !chart ? (
            <UsageLoadingSkeleton selectedWindow={selectedWindow} />
          ) : (
            <>
              {hourlyMissingNote ? (
                <p
                  className="mt-6 text-xs text-muted-foreground/70"
                  data-testid="usage-hourly-missing"
                >
                  {hourlyMissingNote}
                </p>
              ) : null}
              <div className={HERO_GRID_CLASS}>
                <UsageHero breakdown={view.breakdown} tokenMix={tokenMix} />
                <UsageChart
                  chart={chart}
                  unit={view.unit}
                  group={chartGroup}
                  metric={chartMetric}
                  includeCacheReads={includeCacheReads}
                  onGroupChange={setChartGroup}
                  onMetricChange={handleMetricChange}
                  onIncludeCacheReadsChange={setIncludeCacheReads}
                />
              </div>

              {/* A narrow pane uses compact label/value rows so none of the
                  context is lost. From tablet widths upward, all five stats
                  stay in one divided row; type and padding tighten until the
                  pane widens. */}
              <div className={USAGE_STATS_BAND_CLASS} data-testid="usage-stats-band">
                {stats.map((stat) => (
                  <UsageStatCell key={stat.label} stat={stat} />
                ))}
              </div>

              <UsageModelsSection rows={modelRows} />
              <UsagePeriodsSection rows={periodRows} unit={view.unit} />

              <section className="mt-8">
                <h2 className={SECTION_LABEL_CLASS}>Machines</h2>
                <div className="mt-2 flex flex-col divide-y divide-border/50">
                  {machines.map((machine) => (
                    <UsageMachineRowView key={machine.environmentId} machine={machine} />
                  ))}
                </div>
                {scan.merged.duplicateSources.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground/50">
                    Counted once: {scan.merged.duplicateSources.join(", ")} is the same folder
                    another computer already reported.
                  </p>
                ) : null}
              </section>

              <p className="mt-8 border-t border-border/50 pt-3 text-xs text-muted-foreground/55">
                {formatCostQualityFootnote(scan.merged.costQuality)}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UsageWindowControls({
  selected,
  isFetching = false,
  disabled = false,
  onWindowChange,
  onRefresh,
}: {
  readonly selected: UsagePageWindow;
  readonly isFetching?: boolean;
  readonly disabled?: boolean;
  readonly onWindowChange: (selected: UsagePageWindow) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1">
        {USAGE_PAGE_WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === selected}
            className={cn(
              "rounded px-1.5 py-1 font-mono text-xs tabular-nums transition-colors",
              disabled ? "cursor-default" : "cursor-pointer",
              option === selected
                ? "text-foreground"
                : cn("text-muted-foreground/55", !disabled && "hover:text-foreground"),
            )}
            data-testid={`usage-window-${option}`}
            disabled={disabled}
            onClick={() => onWindowChange(option)}
          >
            {formatUsagePageWindow(option)}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Refresh usage"
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/80 transition-colors focus-ring",
          disabled ? "cursor-default" : "cursor-pointer hover:bg-muted hover:text-foreground",
        )}
        data-testid="usage-refresh"
        disabled={disabled || isFetching}
        onClick={onRefresh}
      >
        <RotateCwIcon className={cn("size-3.5", isFetching && "animate-spin")} />
        Refresh
      </button>
    </div>
  );
}

/**
 * The subscription windows each provider reports, read from the same
 * presentation the composer and Settings use. Independent of the transcript
 * scan, so it shows while usage is still loading. Absent when no provider has
 * a plan to meter.
 */
function UsagePlanLimits({ nowMs }: { readonly nowMs: number }) {
  const providers = useServerProviders();
  const rows = useMemo(() => buildUsagePlanLimitRows(providers, nowMs), [providers, nowMs]);
  if (rows.length === 0) return null;
  return (
    <section className="mt-6" data-testid="usage-plan-limits">
      <h2 className={SECTION_LABEL_CLASS}>Plan limits</h2>
      <div className="mt-1 flex flex-col divide-y divide-border/50">
        {rows.map((row) => {
          const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[row.driver];
          const fill = row.provider ? USAGE_PROVIDER_COLORS[row.provider] : "var(--foreground)";
          return (
            <div
              key={row.instanceId}
              className="grid grid-cols-1 gap-x-8 gap-y-2 py-2.5 @4xl:grid-cols-[9.5rem_minmax(0,1fr)] @4xl:items-center"
              data-testid="usage-plan-limit-row"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-foreground/90">
                {ProviderIcon ? <ProviderIcon className="size-3.5 shrink-0" /> : null}
                <span className="truncate">{row.label}</span>
              </span>
              <div className="grid grid-cols-1 gap-x-8 gap-y-2.5 @xl:grid-cols-2">
                {row.meters.map((meter) => (
                  <div key={meter.key} className="flex min-w-0 flex-col gap-1.5">
                    <span className="flex min-w-0 items-baseline gap-2 text-xs">
                      <span className="shrink-0 text-foreground/90">{meter.label}</span>
                      {meter.warning && !meter.reachedLimit ? (
                        <span className="shrink-0 text-warning-foreground">Near limit</span>
                      ) : null}
                      <span
                        className={cn(
                          NUMBER_CLASS,
                          "min-w-0 flex-1 truncate text-right text-muted-foreground/60",
                        )}
                      >
                        {meter.detail}
                      </span>
                    </span>
                    <div className="h-[3px] w-full bg-border/40">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.max(0, Math.min(100, meter.usedPercent))}%`,
                          backgroundColor:
                            usageMeterColor(meter.usedPercent, meter.warning) ?? fill,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The headline tokens, what they were, and who used them. Cost trails as one
 * quiet line with its caveat, because a subscription bills on its own terms.
 */
function UsageHero({
  breakdown,
  tokenMix,
}: {
  readonly breakdown: UsageBreakdown;
  readonly tokenMix: readonly UsageTokenMixRow[];
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={SECTION_LABEL_CLASS}>Processed tokens</span>
      <span
        className={cn(NUMBER_CLASS, "mt-1.5 text-[40px] leading-none text-foreground")}
        data-testid="usage-total-tokens"
      >
        {formatTokensCompact(breakdown.totalTokens)}
      </span>
      {/* Cache reads are the agent re-reading its own context each turn; the
          rest tracks the work far better, so it gets its own line. */}
      <p className="mt-2.5 text-xs text-muted-foreground/60" data-testid="usage-new-tokens">
        {formatTokensCompact(breakdown.totalTokens - breakdown.cachedInputTokens)} new tokens, not
        counting cache reads
      </p>

      <h2 className={cn(SECTION_LABEL_CLASS, "mt-6")}>What they were</h2>
      <div className="mt-2 flex flex-col gap-2.5">
        {tokenMix.map((row) => (
          <UsageShareRow
            key={row.kind}
            label={row.label}
            hint={row.hint}
            value={formatTokensCompact(row.tokens)}
            share={row.share}
            color={row.color}
            testId="usage-token-mix-row"
          />
        ))}
      </div>

      <h2 className={cn(SECTION_LABEL_CLASS, "mt-6")}>By provider</h2>
      <div className="mt-2 flex flex-col gap-2.5">
        {USAGE_PROVIDER_READING_ORDER.flatMap((provider) => {
          const totals = breakdown.providers.find((entry) => entry.provider === provider);
          if (!totals) return [];
          const ProviderIcon = USAGE_PROVIDER_ICONS[provider];
          return [
            <UsageShareRow
              key={provider}
              icon={<ProviderIcon className="size-3.5 shrink-0" />}
              label={USAGE_PROVIDER_LABELS[provider]}
              value={formatTokensCompact(totals.totalTokens)}
              share={totals.tokenShare}
              color={USAGE_PROVIDER_COLORS[provider]}
              testId="usage-provider-row"
            />,
          ];
        })}
      </div>

      <p className="mt-6 text-xs text-muted-foreground/60">
        <span className={cn(NUMBER_CLASS, "text-foreground/85")} data-testid="usage-total-cost">
          {formatUsd(breakdown.costUsd)}*
        </span>{" "}
        API-equivalent cost
      </p>
      <p className="mt-1 text-xs text-muted-foreground/45">
        * if billed at full API rates. Subscription plans bill separately.
      </p>
    </div>
  );
}

/** A label, its figure and share, and a hairline bar showing that share. */
function UsageShareRow({
  icon,
  label,
  hint = null,
  value,
  share,
  color,
  testId,
}: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly hint?: string | null;
  readonly value: string;
  readonly share: number;
  readonly color: string;
  readonly testId: string;
}) {
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto_2.75rem] items-baseline gap-x-2.5 gap-y-1"
      data-testid={testId}
    >
      <span className="flex min-w-0 items-center gap-2 text-xs text-foreground/90">
        {icon}
        <span className="min-w-0 truncate">
          {label}
          {hint ? <span className="text-muted-foreground/45"> · {hint}</span> : null}
        </span>
      </span>
      <span className={cn(NUMBER_CLASS, "text-right text-xs text-foreground/90")}>{value}</span>
      <span className={cn(NUMBER_CLASS, "text-right text-xs text-muted-foreground/55")}>
        {formatPercent(share, shareDigits(share))}
      </span>
      <div className="col-span-3 h-[3px] bg-border/40">
        <div
          className="h-full"
          style={{
            width: `${Math.max(0, Math.min(1, share)) * 100}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

function UsageSegmented<Option extends string>({
  options,
  labels,
  value,
  disabled = false,
  unavailable,
  onChange,
  testIdPrefix,
}: {
  readonly options: readonly Option[];
  readonly labels: Record<Option, string>;
  readonly value: Option;
  readonly disabled?: boolean;
  /** Why an option cannot be picked right now, or `null` when it can. */
  readonly unavailable?: (option: Option) => string | null;
  readonly onChange?: (option: Option) => void;
  readonly testIdPrefix: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {options.map((option, index) => {
        const reason = unavailable?.(option) ?? null;
        const optionDisabled = disabled || reason !== null;
        return (
          <span key={option} className="flex items-center gap-1.5">
            {index > 0 ? <span className="text-muted-foreground/25">|</span> : null}
            <button
              type="button"
              aria-pressed={option === value}
              className={cn(
                "font-mono text-[10px] uppercase tracking-wider transition-colors",
                optionDisabled ? "cursor-default" : "cursor-pointer",
                option === value
                  ? "text-foreground"
                  : reason !== null
                    ? "text-muted-foreground/30"
                    : cn("text-muted-foreground/55", !disabled && "hover:text-foreground"),
              )}
              data-testid={`${testIdPrefix}-${option}`}
              disabled={optionDisabled}
              title={reason ?? undefined}
              onClick={() => onChange?.(option)}
            >
              {labels[option]}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function UsageChartHeader({
  unit,
  group,
  metric,
  includeCacheReads,
  disabled = false,
  onGroupChange,
  onMetricChange,
}: {
  readonly unit: UsagePeriodUnit;
  readonly group: UsageChartGroup;
  readonly metric: UsageChartMetric;
  readonly includeCacheReads: boolean;
  readonly disabled?: boolean;
  readonly onGroupChange?: (group: UsageChartGroup) => void;
  readonly onMetricChange?: (metric: UsageChartMetric) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <h2 className="text-sm text-foreground/90">
        {usageChartTitle(unit, metric, includeCacheReads)}
      </h2>
      <div className="flex-1" />
      <UsageSegmented
        options={USAGE_CHART_GROUPS}
        labels={USAGE_CHART_GROUP_LABELS}
        value={group}
        disabled={disabled}
        unavailable={(option) =>
          usageChartGroupSupportsMetric(option, metric)
            ? null
            : "Cost is recorded per response, not per token type"
        }
        {...(onGroupChange ? { onChange: onGroupChange } : {})}
        testIdPrefix="usage-chart-group"
      />
      <UsageSegmented
        options={USAGE_CHART_METRICS}
        labels={USAGE_CHART_METRIC_LABELS}
        value={metric}
        disabled={disabled}
        {...(onMetricChange ? { onChange: onMetricChange } : {})}
        testIdPrefix="usage-chart-mode"
      />
    </div>
  );
}

/**
 * Stacked bars, one per calendar day, split by model, provider or token type.
 *
 * Bars rather than overlapping curves because the point is the split within a
 * day, and stacked lengths read as parts of a whole where overlapping areas do
 * not. The hover card lists the day's series, largest first.
 */
function UsageChart({
  chart,
  unit,
  group,
  metric,
  includeCacheReads,
  onGroupChange,
  onMetricChange,
  onIncludeCacheReadsChange,
}: {
  readonly chart: UsageBarChart;
  readonly unit: UsagePeriodUnit;
  readonly group: UsageChartGroup;
  readonly metric: UsageChartMetric;
  readonly includeCacheReads: boolean;
  readonly onGroupChange: (group: UsageChartGroup) => void;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
  readonly onIncludeCacheReadsChange: (include: boolean) => void;
}) {
  // The hovered period, held as an index so a window switch under the cursor
  // cannot leave the card describing a period the chart no longer shows.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Touch devices scrub instead of hovering: the finger drags across the bars
  // and the card pins to the top of the plot, out from under the hand.
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const scrubToClientX = (clientX: number, plot: HTMLElement) => {
    const rect = plot.getBoundingClientRect();
    if (rect.width <= 0 || chart.columns.length === 0) return;
    const fraction = Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
    setHoveredIndex(Math.floor(fraction * chart.columns.length));
  };
  const hoveredColumn = hoveredIndex === null ? null : (chart.columns[hoveredIndex] ?? null);
  // The hovered bar's center across the bar area, which starts after the
  // gridline labels' gutter.
  const hoveredFraction =
    hoveredIndex === null ? 0 : (hoveredIndex + 0.5) / Math.max(1, chart.columns.length);
  // The card sits on whichever side has room, flipping past the midline.
  const hoveredOnLeftHalf = hoveredFraction <= 0.5;
  return (
    <div className="flex min-w-0 flex-col" data-testid="usage-chart">
      <UsageChartHeader
        unit={unit}
        group={group}
        metric={metric}
        includeCacheReads={includeCacheReads}
        onGroupChange={onGroupChange}
        onMetricChange={onMetricChange}
      />
      <div className="mt-2.5 flex min-h-5 flex-wrap items-center gap-x-3.5 gap-y-1">
        {chart.series.map((series) => (
          <span
            key={series.key}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70"
            data-testid="usage-chart-legend-item"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: series.color }}
            />
            {series.label}
          </span>
        ))}
        {/* Cost cannot be split by token kind, so the cache toggle only
            exists while the chart counts tokens. Pushed right, it stays
            right-aligned even when the legend wraps it onto its own line. */}
        {metric === "tokens" ? (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground">
            <Checkbox
              checked={includeCacheReads}
              className="size-3.5 sm:size-3.5"
              data-testid="usage-include-cache-reads"
              onCheckedChange={(checked) => onIncludeCacheReadsChange(checked)}
            />
            Include cache reads
          </label>
        ) : null}
      </div>

      <div className="relative mt-4 h-[220px] border-b border-border">
        {chart.gridlines.map((gridline) => (
          <div
            key={gridline.value}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 border-t border-border/45"
            style={{ top: `${gridline.topPercent}%` }}
          >
            <span
              className={cn(
                NUMBER_CLASS,
                "absolute left-0 bottom-0.5 text-[10px] text-muted-foreground/45",
              )}
            >
              {gridline.label}
            </span>
          </div>
        ))}
        {/* Per-day columns drive the card for a mouse. A finger scrubs
            instead: press and drag moves the highlight, lifting clears it, so
            the card never needs a dismiss affordance on touch. touch-action
            keeps vertical page scrolling alive; only horizontal movement is
            claimed. */}
        <div
          className={cn(
            "absolute inset-y-0 right-0 left-11 flex touch-pan-y select-none items-end",
            chart.columns.length > 60 ? "gap-px" : "gap-0.5",
          )}
          onMouseLeave={() => setHoveredIndex(null)}
          onPointerDown={(event) => {
            if (event.pointerType !== "touch") return;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // A pointer that lifted mid-gesture cannot be captured; the
              // scrub still tracks whatever move events do arrive.
            }
            scrubToClientX(event.clientX, event.currentTarget);
          }}
          onPointerMove={(event) => {
            if (event.pointerType !== "touch") return;
            scrubToClientX(event.clientX, event.currentTarget);
          }}
          onPointerUp={(event) => {
            if (event.pointerType !== "touch") return;
            setHoveredIndex(null);
          }}
          onPointerCancel={(event) => {
            if (event.pointerType !== "touch") return;
            setHoveredIndex(null);
          }}
        >
          {chart.columns.map((column, index) => (
            <div
              key={column.key}
              className={cn(
                "flex h-full min-w-0 flex-1 flex-col justify-end",
                hoveredIndex !== null && hoveredIndex !== index && "opacity-40",
              )}
              data-testid="usage-chart-day"
              onMouseEnter={() => {
                // Touch taps synthesize mouseenter after the finger lifts;
                // honoring it would resurrect the card the pointerup cleared.
                if (!isCoarsePointer) setHoveredIndex(index);
              }}
            >
              {/* The DOM's first segment sits on the baseline. The surface
                  colored border is the 2px gap between stacked segments. */}
              <div
                className="flex flex-col-reverse overflow-hidden rounded-t-[3px]"
                style={{ height: `${column.heightPercent}%` }}
              >
                {column.segments.map((segment) => (
                  <div
                    key={segment.key}
                    className="shrink-0 border-t-2 border-background last:border-t-0"
                    style={{ height: `${segment.percent}%`, backgroundColor: segment.color }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        {hoveredColumn ? (
          <div
            className={cn(
              "pointer-events-none absolute top-2 z-10 w-60 rounded-md border bg-popover px-3 py-2.5 text-popover-foreground shadow-md/5",
              // A scrubbing finger sits on the plot, so the card pins to the
              // top center instead of chasing the highlight under it.
              isCoarsePointer && "left-1/2 -translate-x-1/2",
            )}
            // Clamped so a narrow plot never pushes the card past its own
            // edge: the card slides over the bar rather than overflowing.
            style={
              isCoarsePointer
                ? undefined
                : hoveredOnLeftHalf
                  ? {
                      left: `min(calc(2.75rem + (100% - 2.75rem) * ${hoveredFraction} + 10px), calc(100% - 15rem))`,
                    }
                  : {
                      right: `min(calc((100% - 2.75rem) * ${1 - hoveredFraction} + 10px), calc(100% - 15rem))`,
                    }
            }
            data-testid="usage-chart-card"
          >
            <p className="text-xs text-muted-foreground/70">{hoveredColumn.label}</p>
            {hoveredColumn.entries.length > 0 ? (
              <div className="mt-1.5 flex flex-col gap-1">
                {hoveredColumn.entries.map((entry) => (
                  <span key={entry.key} className="flex items-center gap-1.5 text-xs">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground/85">
                      {entry.label}
                    </span>
                    <span className={cn(NUMBER_CLASS, "shrink-0 text-foreground")}>
                      {entry.valueLabel}
                    </span>
                    <span
                      className={cn(
                        NUMBER_CLASS,
                        "w-9 shrink-0 text-right text-muted-foreground/55",
                      )}
                    >
                      {entry.shareLabel}
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground/55">No activity</p>
            )}
            <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-xs">
              <span className="flex-1 text-muted-foreground/70">Total</span>
              <span className={cn(NUMBER_CLASS, "text-foreground")}>
                {hoveredColumn.totalLabel}
              </span>
            </div>
            {hoveredColumn.comparisonLabel ? (
              <p className="mt-1 text-[11px] text-muted-foreground/55">
                {hoveredColumn.comparisonLabel}
              </p>
            ) : null}
          </div>
        ) : null}
        {chart.isEmpty ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/50">
            No recorded activity in this window.
          </p>
        ) : null}
      </div>
      <div className="mt-1.5 flex justify-between gap-2 pl-11">
        {chart.axisLabels.map((label) => (
          <span key={label} className={cn(SECTION_LABEL_CLASS, "text-[10px]")}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function UsageStatCell({ stat }: { readonly stat: UsageStat }) {
  return (
    <div className={USAGE_STAT_CELL_CLASS} data-testid="usage-stat">
      <span className={cn(SECTION_LABEL_CLASS, USAGE_STAT_LABEL_CLASS)}>{stat.label}</span>
      <span className={cn(NUMBER_CLASS, USAGE_STAT_VALUE_CLASS)}>{stat.value}</span>
      {stat.context ? <span className={USAGE_STAT_CONTEXT_CLASS}>{stat.context}</span> : null}
    </div>
  );
}

function UsageModelsHeader() {
  return (
    <div className={cn(MODEL_GRID_CLASS, "mt-2 pb-1")}>
      <span className={COLUMN_LABEL_CLASS}>Model</span>
      <span className={cn(COLUMN_LABEL_CLASS, "text-right")}>Tokens</span>
      <span className={cn(COLUMN_LABEL_CLASS, "text-right @xl:text-left")}>Share</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden text-right @4xl:block")}>Output</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden text-right @4xl:block")}>Cache hit</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden text-right @4xl:block")}>Responses</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden @4xl:block")}>Trend</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden text-right @xl:block")}>API cost</span>
    </div>
  );
}

function UsageModelsSection({ rows }: { readonly rows: readonly UsageModelRow[] }) {
  return (
    <section className="mt-8">
      <h2 className={SECTION_LABEL_CLASS}>Models</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground/55">
          No recorded activity in this window.
        </p>
      ) : (
        <>
          <UsageModelsHeader />
          <div className="flex flex-col divide-y divide-border/50">
            {rows.map((row) => {
              const ProviderIcon = USAGE_PROVIDER_ICONS[row.provider];
              return (
                <div
                  key={row.key}
                  className={cn(MODEL_GRID_CLASS, "py-2.5")}
                  data-testid="usage-model-row"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: row.color }}
                    />
                    <ProviderIcon className="size-3 shrink-0" />
                    <span className="min-w-0 truncate text-sm text-foreground/90">{row.model}</span>
                  </span>
                  <span className={cn(NUMBER_CLASS, "text-right text-xs text-foreground/85")}>
                    {formatTokens(row.totalTokens)}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="hidden h-[3px] min-w-0 flex-1 bg-border/40 @xl:block">
                      <span
                        className="block h-full"
                        style={{
                          width: `${Math.max(0, Math.min(1, row.tokenShare)) * 100}%`,
                          backgroundColor: row.color,
                        }}
                      />
                    </span>
                    <span
                      className={cn(
                        NUMBER_CLASS,
                        "ml-auto w-10 shrink-0 text-right text-xs text-muted-foreground/55",
                      )}
                    >
                      {formatPercent(row.tokenShare, shareDigits(row.tokenShare))}
                    </span>
                  </span>
                  <span
                    className={cn(
                      NUMBER_CLASS,
                      "hidden text-right text-xs text-muted-foreground/70 @4xl:block",
                    )}
                  >
                    {formatTokensCompact(row.outputTokens)}
                  </span>
                  <span
                    className={cn(
                      NUMBER_CLASS,
                      "hidden text-right text-xs text-muted-foreground/70 @4xl:block",
                    )}
                  >
                    {formatPercent(row.cacheHitShare, 0)}
                  </span>
                  <span
                    className={cn(
                      NUMBER_CLASS,
                      "hidden text-right text-xs text-muted-foreground/70 @4xl:block",
                    )}
                  >
                    {formatCount(row.records)}
                  </span>
                  <span aria-hidden className="hidden h-4 items-end gap-px @4xl:flex">
                    {row.trend.map((bin) => (
                      <span
                        key={bin.key}
                        className="min-h-px flex-1 rounded-t-[1px]"
                        style={{ height: `${bin.height * 100}%`, backgroundColor: row.color }}
                      />
                    ))}
                  </span>
                  <span
                    className={cn(
                      NUMBER_CLASS,
                      "hidden text-right text-xs text-muted-foreground/60 @xl:block",
                    )}
                  >
                    {formatUsd(row.costUsd)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function UsagePeriodsHeader({ unit }: { readonly unit: UsagePeriodUnit }) {
  return (
    <div className={cn(DAY_GRID_CLASS, "mt-2 pb-1")}>
      <span className={COLUMN_LABEL_CLASS}>{unit === "day" ? "Day" : "Hour"}</span>
      <span className={cn(COLUMN_LABEL_CLASS, "text-right")}>Tokens</span>
      <span className={COLUMN_LABEL_CLASS}>Models</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden @4xl:block")}>Top model</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden text-right @4xl:block")}>Responses</span>
      <span className={cn(COLUMN_LABEL_CLASS, "hidden text-right @xl:block")}>API cost</span>
    </div>
  );
}

/**
 * One row per day or hour with activity, newest first. Each carries a bar
 * split by model, sized against the busiest one, and opens into its model list.
 */
function UsagePeriodsSection({
  rows,
  unit,
}: {
  readonly rows: readonly UsagePeriodRow[];
  readonly unit: UsagePeriodUnit;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, PERIOD_ROW_LIMIT);
  const togglePeriod = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <section className="mt-8">
      <h2 className={SECTION_LABEL_CLASS}>
        {usageListTitle(unit)} · {formatCount(rows.length)} active
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground/55">
          No recorded activity in this window.
        </p>
      ) : (
        <>
          <UsagePeriodsHeader unit={unit} />
          <div className="flex flex-col divide-y divide-border/50">
            {visibleRows.map((row) => {
              const open = expanded.has(row.key);
              const topModel = row.models[0] ?? null;
              return (
                <div key={row.key} data-testid="usage-period-row">
                  <button
                    type="button"
                    aria-expanded={open}
                    className={cn(DAY_GRID_CLASS, "group w-full cursor-pointer py-2.5 text-left")}
                    onClick={() => togglePeriod(row.key)}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground/90 transition-colors group-hover:text-foreground">
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "size-3 shrink-0 text-muted-foreground/50 transition-transform",
                          open && "rotate-90",
                        )}
                      />
                      <span className="truncate">{row.label}</span>
                    </span>
                    <span className={cn(NUMBER_CLASS, "text-right text-xs text-foreground/85")}>
                      {formatTokens(row.totalTokens)}
                    </span>
                    <span className="flex h-2 min-w-0">
                      <span
                        className="flex h-full gap-0.5"
                        style={{ width: `${row.widthPercent}%` }}
                      >
                        {row.segments.map((segment) => (
                          <span
                            key={segment.key}
                            className="h-full basis-0 first:rounded-l-[2px] last:rounded-r-[2px]"
                            style={{ flexGrow: segment.tokens, backgroundColor: segment.color }}
                          />
                        ))}
                      </span>
                    </span>
                    <span className="hidden min-w-0 items-center gap-1.5 text-xs @4xl:flex">
                      {topModel ? (
                        <>
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: topModel.color }}
                          />
                          <span className="min-w-0 truncate text-muted-foreground/80">
                            {topModel.model}
                          </span>
                          <span className={cn(NUMBER_CLASS, "shrink-0 text-muted-foreground/50")}>
                            {formatPercent(topModel.share, 0)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        NUMBER_CLASS,
                        "hidden text-right text-xs text-muted-foreground/70 @4xl:block",
                      )}
                    >
                      {formatCount(row.records)}
                    </span>
                    <span
                      className={cn(
                        NUMBER_CLASS,
                        "hidden text-right text-xs text-muted-foreground/60 @xl:block",
                      )}
                    >
                      {formatUsd(row.costUsd)}
                    </span>
                  </button>
                  {open ? (
                    <div className="pb-2.5" data-testid="usage-period-models">
                      {row.models.map((model) => (
                        <div
                          key={model.key}
                          className={cn(DAY_GRID_CLASS, "py-1 text-xs")}
                          data-testid="usage-period-model"
                        >
                          <span />
                          <span className={cn(NUMBER_CLASS, "text-right text-muted-foreground/70")}>
                            {formatTokens(model.totalTokens)}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              aria-hidden
                              className="size-2 shrink-0 rounded-[2px]"
                              style={{ backgroundColor: model.color }}
                            />
                            <span className="min-w-0 truncate text-muted-foreground/80">
                              {model.model}
                            </span>
                          </span>
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "hidden text-muted-foreground/50 @4xl:block",
                            )}
                          >
                            {formatPercent(model.share, 0)} of the {unit}
                          </span>
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "hidden text-right text-muted-foreground/55 @4xl:block",
                            )}
                          >
                            {formatCount(model.records)}
                          </span>
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "hidden text-right text-muted-foreground/50 @xl:block",
                            )}
                          >
                            {formatUsd(model.costUsd)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {rows.length > PERIOD_ROW_LIMIT ? (
            <button
              type="button"
              className="mt-1.5 cursor-pointer text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
              data-testid="usage-periods-show-all"
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll
                ? "Show fewer"
                : `Show all ${formatCount(rows.length)} ${unit === "day" ? "days" : "hours"}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function UsageMachineRowView({ machine }: { readonly machine: UsageMachineRow }) {
  return (
    <div className="flex flex-col gap-1 py-2.5" data-testid="usage-machine-row">
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">{machine.label}</span>
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] uppercase tracking-wider",
            machine.state === "reporting" ? "text-muted-foreground/45" : "text-warning",
          )}
        >
          {USAGE_MACHINE_STATE_LABELS[machine.state]}
        </span>
      </span>
      {machine.detail ? (
        <span className="text-xs text-muted-foreground/50">{machine.detail}</span>
      ) : null}
      {machine.sources.map((source) => (
        <span
          key={`${source.fingerprint.provider}:${source.fingerprint.resolvedHomePath}`}
          className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground/55"
        >
          <span className="w-12 shrink-0 text-muted-foreground/45">
            {USAGE_PROVIDER_SHORT_LABELS[source.fingerprint.provider]}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {source.fingerprint.resolvedHomePath}
          </span>
          <span className={cn(NUMBER_CLASS, "shrink-0 text-[11px] text-muted-foreground/40")}>
            {source.status === "missing"
              ? "not found"
              : `scanned ${formatRelativeTimeLabel(source.lastScannedAt)}`}
          </span>
        </span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/** Bar heights for the loading silhouette, as percentages of the plot. */
const SKELETON_BAR_HEIGHTS = [
  18, 24, 40, 26, 32, 12, 46, 34, 62, 30, 44, 70, 38, 16, 58, 42, 66, 50,
] as const;

/**
 * One clip path cutting a single skeleton into bars, so the loading chart reads
 * as the chart it will become rather than a panel over the plot.
 */
const SKELETON_BARS_CLIP_PATH = `polygon(${SKELETON_BAR_HEIGHTS.flatMap((height, index) => {
  const step = 100 / SKELETON_BAR_HEIGHTS.length;
  const left = index * step;
  const right = left + step * 0.72;
  const top = 100 - height;
  return [`${left}% 100%`, `${left}% ${top}%`, `${right}% ${top}%`, `${right}% 100%`];
}).join(", ")})`;

function UsageLoadingSkeleton({ selectedWindow }: { readonly selectedWindow: UsagePageWindow }) {
  const unit: UsagePeriodUnit = selectedWindow === "24h" ? "hour" : "day";
  const periodCount = selectedWindow === "24h" ? 24 : selectedWindow;
  return (
    <>
      <div
        className={HERO_GRID_CLASS}
        role="status"
        aria-label="Loading usage"
        data-testid="usage-loading-skeleton"
      >
        <div className="flex min-w-0 flex-col">
          <span className={SECTION_LABEL_CLASS}>Processed tokens</span>
          <Skeleton className="mt-1.5 h-10 w-36 rounded-md" />
          <Skeleton className="mt-2.5 h-3 w-56 max-w-full rounded-full" />
          <span className={cn(SECTION_LABEL_CLASS, "mt-6")}>What they were</span>
          <div className="mt-2 flex flex-col gap-2.5">
            {USAGE_TOKEN_MIX_ORDER.map((kind) => (
              <div key={kind} className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2 text-xs text-foreground/90">
                  <span className="min-w-0 flex-1 truncate">{USAGE_TOKEN_KIND_LABELS[kind]}</span>
                  <Skeleton className="h-3 w-12 rounded-full" />
                </span>
                <Skeleton className="h-[3px] w-full rounded-none" />
              </div>
            ))}
          </div>
          <span className={cn(SECTION_LABEL_CLASS, "mt-6")}>By provider</span>
          <div className="mt-2 flex flex-col gap-2.5">
            {USAGE_PROVIDER_READING_ORDER.map((provider) => {
              const ProviderIcon = USAGE_PROVIDER_ICONS[provider];
              return (
                <div
                  key={provider}
                  className="flex min-w-0 flex-col gap-1"
                  data-testid="usage-provider-row-skeleton"
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs text-foreground/90">
                    <ProviderIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {USAGE_PROVIDER_LABELS[provider]}
                    </span>
                    <Skeleton className="h-3 w-12 rounded-full" />
                  </span>
                  <Skeleton className="h-[3px] w-full rounded-none" />
                </div>
              );
            })}
          </div>
          <div className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <Skeleton className="h-3 w-14 rounded-full" />
            API-equivalent cost
          </div>
        </div>

        <UsageChartSkeleton unit={unit} />
      </div>

      <div className={USAGE_STATS_BAND_CLASS} data-testid="usage-stats-band">
        {usageStatLabels(unit, periodCount).map((label) => (
          <div key={label} className={USAGE_STAT_CELL_CLASS}>
            <span className={cn(SECTION_LABEL_CLASS, USAGE_STAT_LABEL_CLASS)}>{label}</span>
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton
              className={cn(USAGE_STAT_CONTEXT_CLASS, "h-3 w-full max-w-40 rounded-full")}
            />
          </div>
        ))}
      </div>

      <section className="mt-8">
        <h2 className={SECTION_LABEL_CLASS}>Models</h2>
        <UsageModelsHeader />
        <div className="flex flex-col divide-y divide-border/50">
          {USAGE_PROVIDER_READING_ORDER.map((provider, index) => {
            const ProviderIcon = USAGE_PROVIDER_ICONS[provider];
            return (
              <div key={provider} className={cn(MODEL_GRID_CLASS, "py-2.5")}>
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderIcon className="size-3 shrink-0" />
                  <Skeleton className={cn("h-4 rounded-full", index === 0 ? "w-36" : "w-28")} />
                </span>
                <Skeleton className="ml-auto h-3 w-12 rounded-full" />
                <Skeleton className="ml-auto h-3 w-9 rounded-full" />
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <h2 className={SECTION_LABEL_CLASS}>{usageListTitle(unit)}</h2>
        <UsagePeriodsHeader unit={unit} />
        <div className="flex flex-col divide-y divide-border/50">
          {[64, 88, 40].map((width) => (
            <div key={width} className={cn(DAY_GRID_CLASS, "py-2.5")}>
              <Skeleton className="h-4 w-20 rounded-full" />
              <Skeleton className="ml-auto h-3 w-12 rounded-full" />
              <Skeleton className="h-2 rounded-full" style={{ width: `${width}%` }} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className={SECTION_LABEL_CLASS}>Machines</h2>
        <div className="mt-2 flex flex-col divide-y divide-border/50">
          <div className="flex flex-col gap-1 py-2.5">
            <span className="flex items-baseline gap-2">
              <Skeleton className="h-4 w-28 rounded-full" />
              <Skeleton className="ml-auto h-3 w-16 rounded-full" />
            </span>
            {USAGE_PROVIDER_READING_ORDER.map((provider) => (
              <span key={provider} className="flex min-w-0 items-baseline gap-2">
                <span className="w-12 shrink-0 text-xs text-muted-foreground/45">
                  {USAGE_PROVIDER_SHORT_LABELS[provider]}
                </span>
                <Skeleton className="h-3 flex-1 rounded-full" />
                <Skeleton className="h-3 w-20 rounded-full" />
              </span>
            ))}
          </div>
        </div>
      </section>

      <Skeleton className="mt-8 h-3 w-full max-w-xl rounded-full" />
    </>
  );
}

function UsageChartSkeleton({ unit }: { readonly unit: UsagePeriodUnit }) {
  return (
    <div className="flex min-w-0 flex-col" data-testid="usage-chart-skeleton">
      <UsageChartHeader unit={unit} group="models" metric="tokens" includeCacheReads disabled />
      <div className="mt-2.5 flex min-h-5 items-center gap-3.5">
        {[20, 24, 16].map((width) => (
          <Skeleton
            key={width}
            className="h-2.5 rounded-full"
            style={{ width: `${width * 4}px` }}
          />
        ))}
      </div>

      <div
        className="relative mt-4 h-[220px] border-b border-border"
        data-testid="usage-chart-plot-skeleton"
      >
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 border-t border-border/45"
            style={{ top: `${index * 25}%` }}
          />
        ))}
        <Skeleton
          aria-hidden
          className="absolute inset-y-0 right-0 left-11 rounded-none opacity-50"
          data-testid="usage-chart-data-skeleton"
          style={{ clipPath: SKELETON_BARS_CLIP_PATH }}
        />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 pl-11">
        <span className={cn(SECTION_LABEL_CLASS, "text-[10px] text-muted-foreground/35")}>
          window start
        </span>
        <span className={cn(SECTION_LABEL_CLASS, "text-[10px] text-muted-foreground/35")}>
          midpoint
        </span>
        <span className={cn(SECTION_LABEL_CLASS, "text-[10px] text-muted-foreground/35")}>
          today
        </span>
      </div>
    </div>
  );
}
