"use client";

import { useMemo, useState } from "react";
import { GaugeIcon, RotateCcwIcon } from "lucide-react";
import type { ProviderInstanceId } from "@threadlines/contracts";

import {
  formatProviderTokenCount,
  type ProviderAccountTokenUsageBucketPresentation,
  type ProviderAccountUsagePresentation,
  type ProviderAccountUsageWindowPresentation,
} from "../lib/providerUsage";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import type { ProviderRateLimitResetCreditRequest } from "./ProviderRateLimitResetCredit";

type TokenActivityMode = "daily" | "weekly" | "cumulative";

const DAY_MS = 86_400_000;
const ACTIVITY_MODE_LABELS: Record<TokenActivityMode, string> = {
  daily: "Daily",
  weekly: "Weekly",
  cumulative: "Cumulative",
};

interface TokenActivityCell {
  readonly dateKey: string;
  readonly value: number;
  readonly intensityPercent: number;
  readonly tooltip: string;
}

interface TokenActivityWeek {
  readonly weekKey: string;
  readonly monthLabel: string | null;
  readonly tooltip: string;
  readonly cells: ReadonlyArray<TokenActivityCell>;
}

interface TokenActivityDay {
  readonly dateKey: string;
  readonly ms: number;
  readonly dailyTokens: number;
  readonly weeklyTokens: number;
  readonly cumulativeTokens: number;
}

function parseDateKey(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateKey);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function formatDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfWeekUtc(ms: number): number {
  const date = new Date(ms);
  const day = date.getUTCDay();
  return ms - day * DAY_MS;
}

function endOfWeekUtc(ms: number): number {
  return startOfWeekUtc(ms) + 6 * DAY_MS;
}

function formatLongDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

function formatMonthLabel(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(ms));
}

function formatTokenActivityTooltip(mode: TokenActivityMode, ms: number, value: number): string {
  const tokenLabel = formatProviderTokenCount(value) ?? "0";
  if (mode === "weekly") {
    return `${tokenLabel} tokens on week of ${formatLongDate(startOfWeekUtc(ms))}`;
  }
  if (mode === "cumulative") {
    return `${tokenLabel} tokens through ${formatLongDate(ms)}`;
  }
  return `${tokenLabel} tokens on ${formatLongDate(ms)}`;
}

function formatTokenActivityWeekTooltip(
  mode: TokenActivityMode,
  weekStartMs: number,
  weekEndMs: number,
  value: number,
): string {
  const tokenLabel = formatProviderTokenCount(value) ?? "0";
  if (mode === "weekly") {
    return `${tokenLabel} tokens on week of ${formatLongDate(weekStartMs)}`;
  }
  if (mode === "cumulative") {
    return `${tokenLabel} tokens through week of ${formatLongDate(weekStartMs)}`;
  }
  return formatTokenActivityTooltip(mode, weekEndMs, value);
}

function tokenActivityColorClass(intensityPercent: number): string {
  if (intensityPercent <= 0) return "bg-muted/35";
  if (intensityPercent < 15) return "bg-primary/10";
  if (intensityPercent < 30) return "bg-primary/25";
  if (intensityPercent < 45) return "bg-primary/45";
  if (intensityPercent < 65) return "bg-primary/65";
  if (intensityPercent < 85) return "bg-primary/85";
  return "bg-primary";
}

function scaleTokenActivityIntensity(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, value / maxValue));
  return Math.max(8, Math.round(Math.pow(ratio, 1.45) * 100));
}

function buildTokenActivityWeeks(
  buckets: ReadonlyArray<ProviderAccountTokenUsageBucketPresentation>,
  mode: TokenActivityMode,
): ReadonlyArray<TokenActivityWeek> {
  const datedBuckets = buckets
    .map((bucket) => {
      const ms = parseDateKey(bucket.startDate);
      return ms === null ? null : { ms, bucket };
    })
    .filter(
      (
        entry,
      ): entry is {
        readonly ms: number;
        readonly bucket: ProviderAccountTokenUsageBucketPresentation;
      } => Boolean(entry),
    );
  if (datedBuckets.length === 0) return [];

  const latestMs = Math.max(...datedBuckets.map((entry) => entry.ms));
  const endMs = endOfWeekUtc(latestMs);
  const startMs = startOfWeekUtc(endMs) - 51 * 7 * DAY_MS;
  const tokenByDate = new Map(
    datedBuckets.map((entry) => [entry.bucket.startDate, entry.bucket.tokens]),
  );
  const weeklyTotals = new Map<string, number>();
  let carriedCumulativeTokens = 0;

  for (const entry of datedBuckets) {
    if (entry.ms < startMs) {
      carriedCumulativeTokens += entry.bucket.tokens;
    }
    const weekKey = formatDateKey(startOfWeekUtc(entry.ms));
    weeklyTotals.set(weekKey, (weeklyTotals.get(weekKey) ?? 0) + entry.bucket.tokens);
  }

  const days: TokenActivityDay[] = [];
  let cumulativeTokens = carriedCumulativeTokens;
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const dateKey = formatDateKey(ms);
    const dailyTokens = tokenByDate.get(dateKey) ?? 0;
    cumulativeTokens += dailyTokens;
    days.push({
      dateKey,
      ms,
      dailyTokens,
      weeklyTokens: weeklyTotals.get(formatDateKey(startOfWeekUtc(ms))) ?? 0,
      cumulativeTokens,
    });
  }

  const maxValue = Math.max(
    0,
    ...days.map((day) =>
      mode === "daily"
        ? day.dailyTokens
        : mode === "weekly"
          ? day.weeklyTokens
          : day.cumulativeTokens,
    ),
  );
  const weeks: TokenActivityWeek[] = [];
  let previousMonth = -1;
  for (let weekStartMs = startMs; weekStartMs <= endMs; weekStartMs += 7 * DAY_MS) {
    const cells: TokenActivityCell[] = [];
    const weekDays = days.slice(weeks.length * 7, weeks.length * 7 + 7);
    const weekValue =
      mode === "weekly"
        ? (weekDays[0]?.weeklyTokens ?? 0)
        : mode === "cumulative"
          ? (weekDays[weekDays.length - 1]?.cumulativeTokens ?? 0)
          : weekDays.reduce((sum, day) => sum + day.dailyTokens, 0);
    const weekTooltip = formatTokenActivityWeekTooltip(
      mode,
      weekDays[0]?.ms ?? weekStartMs,
      weekDays[weekDays.length - 1]?.ms ?? weekStartMs,
      weekValue,
    );
    let monthLabel: string | null = null;
    for (const [offset, day] of weekDays.entries()) {
      const month = new Date(day.ms).getUTCMonth();
      const dayOfMonth = new Date(day.ms).getUTCDate();
      if ((weeks.length === 0 && offset === 0) || (dayOfMonth <= 7 && month !== previousMonth)) {
        monthLabel = formatMonthLabel(day.ms);
        previousMonth = month;
      }
      const value =
        mode === "daily"
          ? day.dailyTokens
          : mode === "weekly"
            ? day.dailyTokens > 0
              ? day.weeklyTokens
              : 0
            : day.cumulativeTokens > 0
              ? weekValue
              : 0;
      cells.push({
        dateKey: day.dateKey,
        value,
        intensityPercent: scaleTokenActivityIntensity(value, maxValue),
        tooltip: formatTokenActivityTooltip(mode, day.ms, value),
      });
    }
    weeks.push({
      weekKey: formatDateKey(weekStartMs),
      monthLabel,
      tooltip: weekTooltip,
      cells,
    });
  }

  const latestMonthLabel = formatMonthLabel(latestMs);
  const firstWeek = weeks[0];
  if (firstWeek?.monthLabel === latestMonthLabel) {
    weeks[0] = {
      weekKey: firstWeek.weekKey,
      monthLabel: null,
      tooltip: firstWeek.tooltip,
      cells: firstWeek.cells,
    };
  }
  return weeks;
}

function TokenActivitySquare(props: { readonly cell: TokenActivityCell }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        closeDelay={0}
        render={
          <span
            role="img"
            aria-label={props.cell.tooltip}
            className={cn(
              "block aspect-square w-full min-w-0 cursor-default rounded-[var(--app-radius-tiny)] transition-[transform,filter,box-shadow] duration-150 ease-out",
              "hover:z-10 hover:-translate-y-px hover:scale-110 hover:brightness-125 hover:ring-1 hover:ring-primary/45",
              tokenActivityColorClass(props.cell.intensityPercent),
            )}
          />
        }
      />
      <TooltipPopup
        side="top"
        className="pointer-events-none"
        positionerClassName="pointer-events-none"
      >
        {props.cell.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

function TokenActivityWeekColumn(props: {
  readonly week: TokenActivityWeek;
  readonly mode: TokenActivityMode;
}) {
  if (props.mode === "daily") {
    return (
      <div className="grid min-w-0 grid-rows-7 gap-1">
        {props.week.cells.map((cell) => (
          <TokenActivitySquare key={cell.dateKey} cell={cell} />
        ))}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        closeDelay={0}
        render={
          <div
            role="img"
            aria-label={props.week.tooltip}
            className="group grid min-w-0 cursor-default grid-rows-7 gap-1"
          >
            {props.week.cells.map((cell) => (
              <span
                key={cell.dateKey}
                aria-hidden="true"
                className={cn(
                  "block aspect-square w-full min-w-0 rounded-[var(--app-radius-tiny)] transition-[transform,filter,box-shadow] duration-150 ease-out",
                  "group-hover:z-10 group-hover:scale-105 group-hover:brightness-125 group-hover:ring-1 group-hover:ring-primary/40",
                  tokenActivityColorClass(cell.intensityPercent),
                )}
              />
            ))}
          </div>
        }
      />
      <TooltipPopup
        side="top"
        className="pointer-events-none"
        positionerClassName="pointer-events-none"
      >
        {props.week.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

function UsageLimitBar(props: {
  readonly usageLabel: string;
  readonly window: ProviderAccountUsageWindowPresentation;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <span className="font-medium text-foreground">{props.window.label}</span>
        <span className="text-muted-foreground">{props.window.detail}</span>
      </div>
      <div
        role="meter"
        aria-label={`${props.usageLabel} ${props.window.label} ${props.window.usedPercent}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.window.usedPercent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            props.window.warning ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${props.window.usedPercent}%` }}
        />
      </div>
    </div>
  );
}

export function ProviderUsageDashboard(props: {
  readonly usage: ProviderAccountUsagePresentation;
  readonly displayName: string;
  readonly instanceId: ProviderInstanceId;
  readonly showLimits?: boolean | undefined;
  readonly onResetAccountUsage?:
    | ((request: ProviderRateLimitResetCreditRequest) => void)
    | undefined;
  readonly accountUsageResetInFlight?: boolean | undefined;
}) {
  const [activityMode, setActivityMode] = useState<TokenActivityMode>("daily");
  const tokenUsage = props.usage.tokenUsage ?? null;
  const activityWeeks = useMemo(
    () => buildTokenActivityWeeks(tokenUsage?.buckets ?? [], activityMode),
    [activityMode, tokenUsage?.buckets],
  );
  const showLimits = props.showLimits ?? true;
  const hasLimits =
    showLimits &&
    (props.usage.windows.length > 0 ||
      props.usage.spendControl !== undefined ||
      props.usage.resetCredits !== undefined);
  const canReset =
    showLimits &&
    props.onResetAccountUsage !== undefined &&
    (props.usage.resetCredits?.availableCount ?? 0) > 0;

  return (
    <div className="grid gap-5">
      {hasLimits ? (
        <section className="grid gap-3" aria-label={`${props.usage.label} limits`}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-medium text-foreground">{props.usage.label}</span>
            </div>
            {props.usage.resetCredits ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{props.usage.resetCredits.label}</span>
                <span aria-hidden>-</span>
                <span>{props.usage.resetCredits.detail}</span>
                {canReset ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="h-6 gap-1.5 px-2 text-[11px]"
                    disabled={props.accountUsageResetInFlight === true}
                    onClick={() =>
                      props.onResetAccountUsage?.({
                        instanceId: props.instanceId,
                        availableCount: props.usage.resetCredits?.availableCount ?? 0,
                      })
                    }
                    aria-label={`Reset ${props.displayName} usage`}
                  >
                    <RotateCcwIcon className="size-3" />
                    {props.accountUsageResetInFlight ? "Resetting" : "Reset"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {props.usage.spendControl ? (
              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
                  <span className="font-medium text-foreground">
                    {props.usage.spendControl.label}
                  </span>
                  <span className="text-muted-foreground">{props.usage.spendControl.detail}</span>
                </div>
                <div
                  role="meter"
                  aria-label={`${props.usage.label} ${props.usage.spendControl.label} ${props.usage.spendControl.usedPercent}% used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={props.usage.spendControl.usedPercent}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width]",
                      props.usage.spendControl.warning ? "bg-warning" : "bg-primary",
                    )}
                    style={{ width: `${props.usage.spendControl.usedPercent}%` }}
                  />
                </div>
              </div>
            ) : null}
            {props.usage.windows.map((window) => (
              <UsageLimitBar key={window.key} usageLabel={props.usage.label} window={window} />
            ))}
          </div>
        </section>
      ) : null}

      {tokenUsage ? (
        <section className="grid gap-4" aria-label={`${tokenUsage.label} activity`}>
          {tokenUsage.summary.length > 0 ? (
            <div className="grid overflow-hidden rounded-lg border border-border/70 sm:grid-cols-5">
              {tokenUsage.summary.map((entry) => (
                <div
                  key={entry.key}
                  className="min-w-0 border-border/60 border-t px-4 py-3 first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0"
                >
                  <div className="truncate text-sm font-medium text-foreground">{entry.value}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{entry.label}</div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">Token activity</h4>
              <div className="inline-flex rounded-md border border-border/70 bg-muted/20 p-0.5">
                {(["daily", "weekly", "cumulative"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cn(
                      "h-7 cursor-pointer rounded px-2.5 text-xs transition-colors",
                      activityMode === mode
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setActivityMode(mode)}
                    aria-pressed={activityMode === mode}
                  >
                    {ACTIVITY_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>
            {activityWeeks.length > 0 ? (
              <div className="min-w-0 pb-1">
                <div
                  className="grid min-w-0 gap-1 overflow-visible"
                  style={{
                    gridTemplateColumns: `repeat(${activityWeeks.length}, minmax(0, 1fr))`,
                  }}
                  aria-label={`${tokenUsage.label} ${ACTIVITY_MODE_LABELS[activityMode].toLowerCase()} token activity`}
                >
                  {activityWeeks.map((week) => (
                    <TokenActivityWeekColumn key={week.weekKey} week={week} mode={activityMode} />
                  ))}
                </div>
                <div
                  className="mt-2 grid min-w-0 gap-1"
                  style={{
                    gridTemplateColumns: `repeat(${activityWeeks.length}, minmax(0, 1fr))`,
                  }}
                  aria-hidden
                >
                  {activityWeeks.map((week) => (
                    <span
                      key={week.weekKey}
                      className="h-3 overflow-visible text-[10px] leading-none text-muted-foreground/75"
                    >
                      {week.monthLabel}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No token activity has been reported.</p>
            )}
          </div>
        </section>
      ) : null}

      {!hasLimits && !tokenUsage ? (
        <p className="text-xs text-muted-foreground">
          Usage data is not available for this provider instance yet.
        </p>
      ) : null}
    </div>
  );
}
