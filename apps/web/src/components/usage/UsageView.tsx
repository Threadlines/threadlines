import {
  USAGE_WINDOW_DAY_OPTIONS,
  type UsageProviderKind,
  type UsageWindowDays,
} from "@threadlines/contracts";
import {
  formatCount,
  formatTokens,
  formatTokensCompact,
  formatUsd,
  formatPercent,
} from "@threadlines/shared/usageFormat";
import { useQuery } from "@tanstack/react-query";
import { RotateCwIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import {
  deriveUsageWindow,
  usageSummaryQueryOptions,
  useUsageEnvironmentTargets,
} from "../../lib/usageReactQuery";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { DesktopPageTitlebar } from "../DesktopPageTitlebar";
import { ClaudeAI, OpenAI, type Icon } from "../Icons";
import {
  buildUsageAreaChart,
  buildUsageDayRows,
  buildUsageMachineRows,
  buildUsageStats,
  formatCostQualityFootnote,
  formatUsageDateRange,
  USAGE_BREAKDOWN_LABELS,
  USAGE_BREAKDOWNS,
  USAGE_CHART_MODE_LABELS,
  USAGE_CHART_MODES,
  USAGE_CHART_TITLES,
  USAGE_HERO_LABELS,
  USAGE_MACHINE_STATE_LABELS,
  USAGE_PROVIDER_COLORS,
  USAGE_PROVIDER_LABELS,
  USAGE_PROVIDER_READING_ORDER,
  USAGE_PROVIDER_SHORT_LABELS,
  visibleUsageModels,
  type UsageAreaChart,
  type UsageBreakdown,
  type UsageChartMode,
  type UsageMachineRow,
  type UsageStat,
} from "./usageView.logic";

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none";
const NUMBER_CLASS = "font-mono tabular-nums";
/** Scan freshness is a relative label, so it needs a slow clock of its own. */
const FRESHNESS_TICK_MS = 30_000;
/** The window a first-time reader gets: a week is too short to see a pattern. */
const DEFAULT_WINDOW_DAYS: UsageWindowDays = 30;

/** The same glyphs the model picker draws, keyed by the usage contract's names. */
const USAGE_PROVIDER_ICONS: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
};

/**
 * What the provider CLIs' own transcripts say this account has spent, merged
 * across every computer Threadlines knows about.
 *
 * The figures are API list prices for the tokens, never billed spend, and the
 * page says so under the headline: a subscription bills on its own terms and the
 * transcripts carry no invoice.
 *
 * One scan covers the longest window on offer and the selector narrows it here,
 * so switching between 7, 30 and 90 days is a recompute rather than a wait.
 */
export function UsageView() {
  const [windowDays, setWindowDays] = useState<UsageWindowDays>(DEFAULT_WINDOW_DAYS);
  const [chartMode, setChartMode] = useState<UsageChartMode>("cost");
  const [breakdown, setBreakdown] = useState<UsageBreakdown>("models");
  // One slow clock for the whole page: scan freshness is the only honest signal
  // about a warm scan, and it must not go stale on screen.
  useRelativeTimeTick(FRESHNESS_TICK_MS);
  const targets = useUsageEnvironmentTargets();
  const usageQuery = useQuery(usageSummaryQueryOptions({ targets }));
  const scan = usageQuery.data ?? null;

  const view = useMemo(
    () => (scan ? deriveUsageWindow(scan, windowDays) : null),
    [scan, windowDays],
  );
  const merged = view?.merged ?? null;

  const chart = useMemo(
    () =>
      view
        ? buildUsageAreaChart({
            daily: view.merged.daily,
            sinceDay: view.window.sinceDay,
            untilDay: view.window.untilDay,
            mode: chartMode,
          })
        : null,
    [chartMode, view],
  );
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
  const models = useMemo(() => (merged ? visibleUsageModels(merged) : []), [merged]);
  const dayRows = useMemo(() => (merged ? buildUsageDayRows(merged) : []), [merged]);
  const stats = useMemo(() => (merged ? buildUsageStats(merged) : []), [merged]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="usage-view">
      <DesktopPageTitlebar label="Usage" />
      {/* The pane-wide element scrolls so the scrollbar hugs the pane's edge
          (like Settings); the reading column centers inside it. */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="usage-scroll">
        <div className="mx-auto flex min-h-full w-full max-w-[1200px] flex-col px-6 py-8">
          {/* Wraps as a whole row on narrow screens; the range never breaks internally. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-lg font-medium tracking-tight">Usage</h1>
            {view ? (
              <span
                className={cn(NUMBER_CLASS, "whitespace-nowrap text-xs text-muted-foreground/55")}
                data-testid="usage-date-range"
              >
                {formatUsageDateRange(view.window.sinceDay, view.window.untilDay)}
              </span>
            ) : null}
          </div>

          {targets.length === 0 ? (
            <p className="mt-10 text-sm text-muted-foreground/60">
              No computers are connected, so there is nothing to report yet.
            </p>
          ) : !merged || !view || !chart ? (
            <p className="mt-10 text-sm text-muted-foreground/60">
              {usageQuery.isError ? "Usage could not be read." : "Reading provider transcripts…"}
            </p>
          ) : (
            <>
              <div className="mt-7 grid grid-cols-1 gap-8 min-[900px]:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col">
                  <span className={SECTION_LABEL_CLASS}>{USAGE_HERO_LABELS[chartMode]}</span>
                  <span
                    className={cn(NUMBER_CLASS, "mt-1.5 text-[40px] leading-none text-foreground")}
                    data-testid="usage-total-cost"
                  >
                    {chartMode === "cost" ? (
                      <>
                        {formatUsd(merged.costUsd)}
                        <span className="ml-1.5 align-super text-[0.6em] text-muted-foreground/45">
                          *
                        </span>
                      </>
                    ) : (
                      formatTokensCompact(merged.totalTokens)
                    )}
                  </span>
                  {/* The asterisk and its footnote are the cost figure's caveat; a
                  token count needs no disclaimer. */}
                  {chartMode === "cost" ? (
                    <p className="mt-2.5 text-xs text-muted-foreground/60">
                      * if billed at full API rates. Subscription plans bill separately.
                    </p>
                  ) : null}
                  <div className="mt-6 flex flex-col gap-4">
                    {USAGE_PROVIDER_READING_ORDER.flatMap((provider) => {
                      const totals = merged.providers.find((entry) => entry.provider === provider);
                      return totals
                        ? [<UsageProviderRow key={provider} totals={totals} mode={chartMode} />]
                        : [];
                    })}
                  </div>
                </div>

                <UsageChart
                  chart={chart}
                  mode={chartMode}
                  onModeChange={setChartMode}
                  windowControls={
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        {USAGE_WINDOW_DAY_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={option === windowDays}
                            className={cn(
                              "cursor-pointer rounded px-1.5 py-1 font-mono text-xs tabular-nums transition-colors",
                              option === windowDays
                                ? "text-foreground"
                                : "text-muted-foreground/55 hover:text-foreground",
                            )}
                            data-testid={`usage-window-${option}`}
                            onClick={() => setWindowDays(option)}
                          >
                            {option}d
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        aria-label="Refresh usage"
                        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-ring"
                        data-testid="usage-refresh"
                        disabled={usageQuery.isFetching}
                        onClick={() => void usageQuery.refetch()}
                      >
                        <RotateCwIcon
                          className={cn("size-3.5", usageQuery.isFetching && "animate-spin")}
                        />
                        Refresh
                      </button>
                    </div>
                  }
                />
              </div>

              {/* A gapped grid until all five cells truly fit on one line, then
                  the single divided row. Wrapping divide-x cells collide, and
                  the sidebar eats ~260px of any viewport breakpoint, so the
                  one-row layout waits for a comfortably wide window. */}
              <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-4 border-y border-border/60 py-3.5 sm:grid-cols-3 min-[1140px]:grid-cols-5 min-[1140px]:gap-0 min-[1140px]:divide-x min-[1140px]:divide-border/60">
                {stats.map((stat) => (
                  <UsageStatCell key={stat.label} stat={stat} />
                ))}
              </div>

              <section className="mt-8">
                <div className="flex items-baseline gap-4">
                  <h2 className={SECTION_LABEL_CLASS}>
                    {breakdown === "models" ? "Models" : "Days"} · {formatCount(merged.sessions)}{" "}
                    sessions
                  </h2>
                  <div className="flex-1" />
                  <div className="flex items-center gap-1.5">
                    {USAGE_BREAKDOWNS.map((option, index) => (
                      <span key={option} className="flex items-center gap-1.5">
                        {index > 0 ? <span className="text-muted-foreground/25">|</span> : null}
                        <button
                          type="button"
                          aria-pressed={option === breakdown}
                          className={cn(
                            "cursor-pointer font-mono text-[10px] uppercase tracking-wider transition-colors",
                            option === breakdown
                              ? "text-foreground"
                              : "text-muted-foreground/55 hover:text-foreground",
                          )}
                          data-testid={`usage-breakdown-${option}`}
                          onClick={() => setBreakdown(option)}
                        >
                          {USAGE_BREAKDOWN_LABELS[option]}
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
                {breakdown === "days" ? (
                  dayRows.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground/55">
                      No recorded activity in this window.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-col divide-y divide-border/50">
                      {dayRows.map((row) => (
                        <div
                          key={row.day}
                          className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-baseline gap-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_4.5rem_5rem_3.5rem]"
                          data-testid="usage-day-row"
                        >
                          <span className="min-w-0 truncate text-sm text-foreground/90">
                            {row.label}
                          </span>
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "text-right text-xs text-muted-foreground/70",
                            )}
                          >
                            {formatTokens(row.totalTokens)}
                          </span>
                          <span
                            className={cn(NUMBER_CLASS, "text-right text-xs text-foreground/85")}
                          >
                            {formatUsd(row.costUsd)}
                          </span>
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "hidden text-right text-xs text-muted-foreground/50 sm:block",
                            )}
                          >
                            {formatPercent(row.costShare, 0)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                ) : models.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground/55">
                    No recorded activity in this window.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-col divide-y divide-border/50">
                    {models.map((model) => {
                      const ProviderIcon = USAGE_PROVIDER_ICONS[model.provider];
                      return (
                        <div
                          key={`${model.provider}:${model.model}`}
                          className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-baseline gap-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_4.5rem_5rem_3.5rem]"
                          data-testid="usage-model-row"
                        >
                          <span className="flex min-w-0 items-baseline gap-2">
                            <ProviderIcon className="size-3 shrink-0 translate-y-px" />
                            <span className="min-w-0 truncate text-sm text-foreground/90">
                              {model.model}
                            </span>
                          </span>
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "text-right text-xs text-muted-foreground/70",
                            )}
                          >
                            {formatTokens(model.totalTokens)}
                          </span>
                          <span
                            className={cn(NUMBER_CLASS, "text-right text-xs text-foreground/85")}
                          >
                            {formatUsd(model.costUsd)}
                          </span>
                          {/* Share is the first column to go on a phone: the model
                          name is the row's point, and share is derivable from
                          cost at a glance. */}
                          <span
                            className={cn(
                              NUMBER_CLASS,
                              "hidden text-right text-xs text-muted-foreground/50 sm:block",
                            )}
                          >
                            {formatPercent(model.costShare, 0)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="mt-8">
                <h2 className={SECTION_LABEL_CLASS}>Machines</h2>
                <div className="mt-2 flex flex-col divide-y divide-border/50">
                  {machines.map((machine) => (
                    <UsageMachineRowView key={machine.environmentId} machine={machine} />
                  ))}
                </div>
                {merged.duplicateSources.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground/50">
                    Counted once: {merged.duplicateSources.join(", ")} is the same folder another
                    computer already reported.
                  </p>
                ) : null}
              </section>

              <p className="mt-8 border-t border-border/50 pt-3 text-xs text-muted-foreground/55">
                {formatCostQualityFootnote(merged.costQuality)}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Provider name, its slice of the selected measure, and how wide that slice is.
 * The row follows the page's cost|tokens mode: the leading figure and the bar
 * show the selected measure, and the sub-line carries the other one.
 */
function UsageProviderRow({
  totals,
  mode,
}: {
  readonly totals: {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly costShare: number;
    readonly totalTokens: number;
    readonly tokenShare: number;
  };
  readonly mode: UsageChartMode;
}) {
  const ProviderIcon = USAGE_PROVIDER_ICONS[totals.provider];
  const share = mode === "cost" ? totals.costShare : totals.tokenShare;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="usage-provider-row">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
          {USAGE_PROVIDER_LABELS[totals.provider]}
        </span>
        <span className={cn(NUMBER_CLASS, "shrink-0 text-sm text-foreground")}>
          {mode === "cost" ? formatUsd(totals.costUsd) : formatTokensCompact(totals.totalTokens)}
        </span>
      </div>
      <div className="h-[3px] w-full bg-border/40">
        <div
          className="h-full"
          style={{
            width: `${Math.max(0, Math.min(1, share)) * 100}%`,
            backgroundColor: USAGE_PROVIDER_COLORS[totals.provider],
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground/55">
        {mode === "cost"
          ? `${formatPercent(totals.costShare)} of cost · ${formatTokensCompact(totals.totalTokens)} tokens`
          : `${formatPercent(totals.tokenShare)} of tokens · ${formatUsd(totals.costUsd)}`}
      </span>
    </div>
  );
}

/**
 * Overlapping areas, one per provider, drawn from the zero baseline.
 *
 * The SVG carries only the curves: gridlines, labels and the hover targets are
 * HTML, so nothing has to survive the horizontal stretch that lets the plot fill
 * whatever width the hero gives it.
 */
function UsageChart({
  chart,
  mode,
  onModeChange,
  windowControls,
}: {
  readonly chart: UsageAreaChart;
  readonly mode: UsageChartMode;
  readonly onModeChange: (mode: UsageChartMode) => void;
  /** The 7d/30d/90d picker and Refresh, docked above the chart's own header. */
  readonly windowControls?: ReactNode;
}) {
  // The hovered day, held as an index so a window switch under the cursor
  // cannot leave the card describing a day the chart no longer shows.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Touch devices scrub instead of hovering: the finger drags the tracking
  // line and the card pins to the top of the plot, out from under the hand.
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  const scrubToClientX = (clientX: number, plot: HTMLElement) => {
    const rect = plot.getBoundingClientRect();
    if (rect.width <= 0 || chart.columns.length === 0) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHoveredIndex(Math.round(fraction * (chart.columns.length - 1)));
  };
  const hoveredColumn = hoveredIndex === null ? null : (chart.columns[hoveredIndex] ?? null);
  // The day's true point position, so the tracking line sits on the curve's
  // peak even for the edge-anchored first and last days.
  const hoveredCenterPercent = hoveredIndex === null ? 0 : (chart.dayXPercents[hoveredIndex] ?? 0);
  // The card sits on whichever side has room, flipping past the midline.
  const hoveredOnLeftHalf = hoveredCenterPercent <= 50;
  return (
    <div className="flex min-w-0 flex-col" data-testid="usage-chart">
      {/* The window picker lives with the graph it narrows, right above the
          cost|tokens toggle rather than stranded in the page header. */}
      {windowControls ? <div className="mb-2.5 flex justify-end">{windowControls}</div> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-sm text-foreground/90">{USAGE_CHART_TITLES[mode]}</h2>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {USAGE_CHART_MODES.map((option, index) => (
            <span key={option} className="flex items-center gap-1.5">
              {index > 0 ? <span className="text-muted-foreground/25">|</span> : null}
              <button
                type="button"
                aria-pressed={option === mode}
                className={cn(
                  "cursor-pointer font-mono text-[10px] uppercase tracking-wider transition-colors",
                  option === mode
                    ? "text-foreground"
                    : "text-muted-foreground/55 hover:text-foreground",
                )}
                data-testid={`usage-chart-mode-${option}`}
                onClick={() => onModeChange(option)}
              >
                {USAGE_CHART_MODE_LABELS[option]}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {USAGE_PROVIDER_READING_ORDER.map((provider) => {
            const ProviderIcon = USAGE_PROVIDER_ICONS[provider];
            return (
              <span
                key={provider}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60"
              >
                {/* The glyphs' built-in brand fills already match the series
                    hues, so they replace the swatch dots without a legend key
                    being lost. */}
                <ProviderIcon aria-hidden className="size-3 shrink-0" />
                {USAGE_PROVIDER_LABELS[provider]}
              </span>
            );
          })}
        </div>
      </div>

      <div className="relative mt-6 h-[200px] border-b border-border">
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
        <svg
          aria-hidden
          className="absolute inset-0 size-full"
          preserveAspectRatio="none"
          viewBox={`0 0 ${chart.viewBoxWidth} ${chart.viewBoxHeight}`}
        >
          {chart.series.map((series) => (
            <g key={series.provider}>
              <path d={series.areaPath} fill={series.color} fillOpacity={0.18} />
              <path
                d={series.linePath}
                fill="none"
                stroke={series.color}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>
        {/* "You are here": a dot on each line's tip marks today's running
            figure. HTML rather than SVG so the plot's horizontal stretch
            cannot squash it into an oval. */}
        {chart.series.map((series) => (
          <span
            key={`${series.provider}-now`}
            aria-hidden
            className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${series.endPoint.leftPercent}%`,
              top: `${series.endPoint.topPercent}%`,
              backgroundColor: series.color,
            }}
          />
        ))}
        {/* Transparent per-day columns drive the tracking line and the card
            for a mouse. A finger scrubs instead: press and drag moves the
            line, lifting clears it -- so the card never needs a dismiss
            affordance on touch. touch-action keeps vertical page scrolling
            alive; only horizontal movement is claimed. */}
        <div
          className="absolute inset-0 flex touch-pan-y select-none"
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
              key={column.day}
              className="min-w-0 flex-1"
              data-testid="usage-chart-day"
              onMouseEnter={() => {
                // Touch taps synthesize mouseenter after the finger lifts;
                // honoring it would resurrect the card the pointerup cleared.
                if (!isCoarsePointer) setHoveredIndex(index);
              }}
            />
          ))}
        </div>
        {hoveredColumn ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25"
              style={{ left: `${hoveredCenterPercent}%` }}
            />
            <div
              className={cn(
                "pointer-events-none absolute top-2 z-10 w-44 rounded-md border bg-popover px-3 py-2.5 text-popover-foreground shadow-md/5",
                // A scrubbing finger sits on the plot, so the card pins to the
                // top center instead of chasing the tracking line under it.
                isCoarsePointer && "left-1/2 -translate-x-1/2",
              )}
              style={
                isCoarsePointer
                  ? undefined
                  : hoveredOnLeftHalf
                    ? { left: `calc(${hoveredCenterPercent}% + 10px)` }
                    : { right: `calc(${100 - hoveredCenterPercent}% + 10px)` }
              }
              data-testid="usage-chart-card"
            >
              <p className="text-xs text-muted-foreground/70">{hoveredColumn.label}</p>
              <div className="mt-1.5 flex flex-col gap-1">
                {hoveredColumn.entries.map((entry) => {
                  const ProviderIcon = USAGE_PROVIDER_ICONS[entry.provider];
                  return (
                    <span key={entry.provider} className="flex items-center gap-1.5 text-xs">
                      <ProviderIcon className="size-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-foreground/85">
                        {USAGE_PROVIDER_LABELS[entry.provider]}
                      </span>
                      <span className={cn(NUMBER_CLASS, "shrink-0 text-foreground")}>
                        {entry.valueLabel}
                      </span>
                    </span>
                  );
                })}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-xs">
                <span className="flex-1 text-muted-foreground/70">Total</span>
                <span className={cn(NUMBER_CLASS, "text-foreground")}>
                  {hoveredColumn.totalLabel}
                </span>
              </div>
            </div>
          </>
        ) : null}
        {chart.isEmpty ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/50">
            No recorded activity in this window.
          </p>
        ) : null}
      </div>
      <div className="mt-1.5 flex justify-between gap-2">
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
    <div
      className="flex min-w-0 flex-col gap-1 min-[1140px]:px-4 min-[1140px]:first:pl-0"
      data-testid="usage-stat"
    >
      <span className={SECTION_LABEL_CLASS}>{stat.label}</span>
      <span className={cn(NUMBER_CLASS, "text-[20px] leading-tight text-foreground")}>
        {stat.value}
      </span>
      {stat.context ? (
        // Wraps on a phone, truncates on desktop where the band is one row and
        // a two-line cell would stagger its neighbours.
        <span className="text-xs text-muted-foreground/55 sm:truncate">{stat.context}</span>
      ) : null}
    </div>
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
