import { USAGE_WINDOW_DAY_OPTIONS, type UsageWindowDays } from "@threadlines/contracts";
import {
  formatCount,
  formatDayShort,
  formatTokens,
  formatUsd,
  formatPercent,
} from "@threadlines/shared/usageFormat";
import { useQuery } from "@tanstack/react-query";
import { RotateCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { usageSummaryQueryOptions, useUsageEnvironmentTargets } from "../../lib/usageReactQuery";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  buildUsageChartBars,
  buildUsageMachineRows,
  formatCostQualityFootnote,
  shouldLabelUsageTick,
  USAGE_MACHINE_STATE_LABELS,
  USAGE_PROVIDER_BAR_CLASSES,
  USAGE_PROVIDER_LABELS,
  USAGE_PROVIDER_ORDER,
  type UsageMachineRow,
} from "./usageView.logic";

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none";
const NUMBER_CLASS = "font-mono tabular-nums";
/** Scan freshness is a relative label, so it needs a slow clock of its own. */
const FRESHNESS_TICK_MS = 30_000;

/**
 * What the provider CLIs' own transcripts say this account has spent, merged
 * across every computer Threadlines knows about.
 *
 * The figures are API list prices for the tokens, never billed spend, and the
 * page says so under the title: a subscription bills on its own terms and the
 * transcripts carry no invoice.
 */
export function UsageView() {
  const [windowDays, setWindowDays] = useState<UsageWindowDays>(7);
  // One slow clock for the whole page: scan freshness is the only honest signal
  // about a warm scan, and it must not go stale on screen.
  useRelativeTimeTick(FRESHNESS_TICK_MS);
  const targets = useUsageEnvironmentTargets();
  const usageQuery = useQuery(usageSummaryQueryOptions({ targets, windowDays }));
  const data = usageQuery.data ?? null;
  const merged = data?.merged ?? null;

  const bars = useMemo(
    () =>
      data
        ? buildUsageChartBars({
            daily: data.merged.daily,
            sinceDay: data.window.sinceDay,
            untilDay: data.window.untilDay,
          })
        : [],
    [data],
  );
  const machines = useMemo(
    () =>
      data
        ? buildUsageMachineRows({
            environments: data.environments,
            staleEnvironments: data.merged.staleEnvironments,
          })
        : [],
    [data],
  );

  return (
    <div
      className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto px-6 py-8"
      data-testid="usage-view"
    >
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-lg font-medium tracking-tight">Usage</h1>
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
          <RotateCwIcon className={cn("size-3.5", usageQuery.isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>
      <p className="text-sm text-muted-foreground/70">
        API list-price equivalent. Subscription plans bill separately.
      </p>

      {targets.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground/60">
          No computers are connected, so there is nothing to report yet.
        </p>
      ) : !merged || !data ? (
        <p className="mt-10 text-sm text-muted-foreground/60">
          {usageQuery.isError ? "Usage could not be read." : "Reading provider transcripts…"}
        </p>
      ) : (
        <>
          <div className="mt-7 flex flex-wrap divide-x divide-border/60 border-y border-border/60 py-3">
            <UsageStat label="API-equivalent" value={formatUsd(merged.costUsd)} />
            <UsageStat label="Tokens" value={formatTokens(merged.totalTokens)} />
            <UsageStat
              label="Cache savings"
              value={formatUsd(merged.costQuality.cacheSavingsUsd)}
            />
            <UsageStat label="Sessions" value={formatCount(merged.sessions)} />
          </div>

          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className={SECTION_LABEL_CLASS}>Daily</h2>
              <div className="flex items-center gap-3">
                {USAGE_PROVIDER_ORDER.map((provider) => (
                  <span
                    key={provider}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60"
                  >
                    <span
                      aria-hidden
                      className={cn("size-2 rounded-xs", USAGE_PROVIDER_BAR_CLASSES[provider])}
                    />
                    {USAGE_PROVIDER_LABELS[provider]}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-3 flex h-[120px] items-stretch gap-px border-b border-border">
              {bars.map((bar) => (
                <div
                  key={bar.day}
                  className="flex min-w-0 flex-1 flex-col-reverse transition-colors hover:bg-muted/50"
                  title={bar.title}
                >
                  {bar.segments.map((segment) => (
                    <div
                      key={segment.provider}
                      className={USAGE_PROVIDER_BAR_CLASSES[segment.provider]}
                      style={{ height: `${segment.heightPercent}%` }}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div className="mt-1 flex gap-px">
              {bars.map((bar, index) => (
                <span
                  key={bar.day}
                  className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/45"
                >
                  {shouldLabelUsageTick(index, bars.length) ? formatDayShort(bar.day) : ""}
                </span>
              ))}
            </div>
          </section>

          <section className="mt-8">
            <h2 className={SECTION_LABEL_CLASS}>Models</h2>
            {merged.models.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground/55">
                No recorded activity in this window.
              </p>
            ) : (
              <div className="mt-2 flex flex-col divide-y divide-border/50">
                {merged.models.map((model) => (
                  <div
                    key={`${model.provider}:${model.model}`}
                    className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem_3.5rem] items-baseline gap-3 py-2.5"
                    data-testid="usage-model-row"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground/90">
                      {model.model}
                    </span>
                    <span
                      className={cn(NUMBER_CLASS, "text-right text-xs text-muted-foreground/70")}
                    >
                      {formatTokens(model.totalTokens)}
                    </span>
                    <span className={cn(NUMBER_CLASS, "text-right text-xs text-foreground/85")}>
                      {formatUsd(model.costUsd)}
                    </span>
                    <span
                      className={cn(NUMBER_CLASS, "text-right text-xs text-muted-foreground/50")}
                    >
                      {formatPercent(model.costShare, 0)}
                    </span>
                  </div>
                ))}
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
  );
}

function UsageStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 first:pl-0">
      <span className={SECTION_LABEL_CLASS}>{label}</span>
      <span className={cn(NUMBER_CLASS, "text-base text-foreground")}>{value}</span>
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
            {USAGE_PROVIDER_LABELS[source.fingerprint.provider]}
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
