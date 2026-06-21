import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  isProviderUsageNearLimit,
  type ProviderAccountUsagePresentation,
} from "~/lib/providerUsage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function formatComposerResetCreditAvailability(availableCount: number): string {
  if (availableCount <= 0) return "None available";
  return availableCount === 1 ? "1 available" : `${availableCount} available`;
}

function formatComposerResetCreditDetail(detail: string): string {
  return detail === "usable for 30 days after grant" ? "30-day grant window" : detail;
}

const contextWindowActionButtonClassName =
  "h-5 shrink-0 cursor-pointer rounded-sm border border-border/70 px-1.5 font-medium text-[10px] text-foreground leading-none transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:cursor-default disabled:opacity-55";

function AccountUsageBar(props: {
  usageLabel: string;
  rowLabel: string;
  detail: string;
  usedPercent: number;
  reachedLimit: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
        <span className="shrink-0 font-medium text-foreground">{props.rowLabel}</span>
        <span className="min-w-0 text-right text-muted-foreground">{props.detail}</span>
      </div>
      <div
        role="meter"
        aria-label={`${props.usageLabel} ${props.rowLabel} ${props.usedPercent}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.usedPercent}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            props.reachedLimit || props.usedPercent >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${props.usedPercent}%` }}
        />
      </div>
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  accountUsage?: ProviderAccountUsagePresentation | null;
  contextWindowLabel?: string | null;
  onResetAccountUsage?: (() => void) | undefined;
  accountUsageResetInFlight?: boolean | undefined;
  onCompactContext?: (() => void) | undefined;
  contextCompactDisabled?: boolean | undefined;
  contextCompactInFlight?: boolean | undefined;
  contextCompactDisabledReason?: string | null | undefined;
}) {
  const { usage, contextWindowLabel } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinnedOpen, setIsPinnedOpen] = useState(false);
  const accountUsage = props.accountUsage ?? null;
  const usageNearLimit = isProviderUsageNearLimit(accountUsage);
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const showCompactButton =
    props.onCompactContext !== undefined || props.contextCompactDisabledReason !== undefined;
  const compactButtonDisabled =
    props.contextCompactDisabled === true ||
    props.contextCompactInFlight === true ||
    props.onCompactContext === undefined;
  const compactButtonTooltip =
    props.contextCompactDisabledReason ??
    (props.contextCompactInFlight === true
      ? "Context compaction is running."
      : "Best used near the context limit.");

  const contextAriaLabel = !usage
    ? "Context window — no tokens used yet"
    : usage.maxTokens !== null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;
  const onOpenChange = useCallback((nextOpen: boolean) => {
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setIsPinnedOpen(false);
    }
  }, []);
  const onTogglePinnedOpen = useCallback(() => {
    setIsPinnedOpen((currentPinnedOpen) => {
      const nextPinnedOpen = !currentPinnedOpen;
      setIsOpen(nextPinnedOpen);
      return nextPinnedOpen;
    });
  }, []);
  useEffect(() => {
    if (!isPinnedOpen) return;

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      onOpenChange(false);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    };
  }, [isPinnedOpen, onOpenChange]);
  const isMeterActive = isOpen || isPinnedOpen;

  return (
    <Popover onOpenChange={onOpenChange} open={isOpen}>
      <PopoverTrigger
        openOnHover={!isPinnedOpen}
        delay={150}
        closeDelay={0}
        render={
          <button
            ref={triggerRef}
            type="button"
            className={cn(
              "group/context-meter inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none ring-1 ring-transparent transition-[background-color,box-shadow,color] duration-200",
              "hover:bg-muted/45 hover:text-foreground hover:ring-border/70 focus-visible:bg-muted/45 focus-visible:text-foreground focus-visible:ring-ring/55",
              isMeterActive && "bg-muted/45 text-foreground ring-border/70",
            )}
            aria-expanded={isOpen}
            aria-label={
              usageNearLimit && accountUsage
                ? `${contextAriaLabel}, ${accountUsage.label} near limit`
                : contextAriaLabel
            }
            onClickCapture={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTogglePinnedOpen();
            }}
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                  className="transition-[stroke] duration-200 group-hover/context-meter:stroke-muted-foreground/35 group-focus-visible/context-meter:stroke-muted-foreground/35 motion-reduce:transition-none"
                />
                {usage ? (
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    stroke="var(--color-primary)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                  />
                ) : null}
              </svg>
              {usage ? (
                <span
                  className={cn(
                    "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                    "text-muted-foreground",
                  )}
                >
                  {usage.usedPercentage !== null
                    ? Math.round(usage.usedPercentage)
                    : formatContextWindowTokens(usage.usedTokens)}
                </span>
              ) : null}
              {usageNearLimit ? (
                <span
                  className="absolute -right-px -top-px h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-background"
                  aria-hidden="true"
                />
              ) : null}
            </span>
          </button>
        }
      />
      <PopoverPopup
        ref={popupRef}
        tooltipStyle
        side="top"
        align="end"
        className="w-96 max-w-[calc(100vw-2rem)] px-3 py-2"
      >
        <div className="space-y-2 leading-tight">
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Context window
            </div>
            {!usage ? (
              <div className="whitespace-nowrap text-xs font-medium text-foreground">
                <span>No tokens used yet</span>
                {contextWindowLabel ? (
                  <>
                    <span className="mx-1">⋅</span>
                    <span>{contextWindowLabel} window</span>
                  </>
                ) : null}
              </div>
            ) : usage.maxTokens !== null && usedPercentage ? (
              <div className="whitespace-nowrap text-xs font-medium text-foreground">
                <span>{usedPercentage}</span>
                <span className="mx-1">⋅</span>
                <span>{formatContextWindowTokens(usage.usedTokens)}</span>
                <span>/</span>
                <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
              </div>
            ) : (
              <div className="text-sm text-foreground">
                {formatContextWindowTokens(usage.usedTokens)} tokens used so far
              </div>
            )}
            {usage &&
            (usage.totalProcessedTokens ?? null) !== null &&
            (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
              <div className="text-xs text-muted-foreground">
                Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
                tokens
              </div>
            ) : null}
            {usage?.compactsAutomatically || showCompactButton ? (
              <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="min-w-0">
                  {usage?.compactsAutomatically
                    ? "Automatically compacts its context when needed."
                    : "Manual context compaction is available."}
                </span>
                {showCompactButton ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "inline-flex shrink-0",
                            compactButtonDisabled ? "cursor-default" : "cursor-pointer",
                          )}
                        >
                          <button
                            type="button"
                            disabled={compactButtonDisabled}
                            onClick={props.onCompactContext}
                            className={contextWindowActionButtonClassName}
                          >
                            {props.contextCompactInFlight ? "Compacting" : "Compact now"}
                          </button>
                        </span>
                      }
                    />
                    <TooltipPopup side="top" align="end" className="max-w-64">
                      {compactButtonTooltip}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            ) : null}
          </div>
          {accountUsage ? (
            <div className="space-y-1.5 border-border/60 border-t pt-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {accountUsage.label}
              </div>
              {accountUsage.resetCredits ? (
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="shrink-0 font-medium text-foreground">Resets</span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {formatComposerResetCreditAvailability(
                      accountUsage.resetCredits.availableCount,
                    )}
                    {accountUsage.resetCredits.detail ? (
                      <>
                        <span className="mx-1" aria-hidden>
                          -
                        </span>
                        {formatComposerResetCreditDetail(accountUsage.resetCredits.detail)}
                      </>
                    ) : null}
                  </span>
                  {props.onResetAccountUsage && accountUsage.resetCredits.availableCount > 0 ? (
                    <button
                      type="button"
                      disabled={props.accountUsageResetInFlight === true}
                      onClick={props.onResetAccountUsage}
                      className={contextWindowActionButtonClassName}
                    >
                      {props.accountUsageResetInFlight ? "Resetting" : "Reset"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {accountUsage.spendControl ? (
                <AccountUsageBar
                  usageLabel={accountUsage.label}
                  rowLabel={accountUsage.spendControl.label}
                  detail={accountUsage.spendControl.detail}
                  usedPercent={accountUsage.spendControl.usedPercent}
                  reachedLimit={accountUsage.spendControl.reachedLimit}
                />
              ) : null}
              {accountUsage.windows.map((window) => (
                <AccountUsageBar
                  key={window.key}
                  usageLabel={accountUsage.label}
                  rowLabel={window.label}
                  detail={window.detail}
                  usedPercent={window.usedPercent}
                  reachedLimit={window.reachedLimit}
                />
              ))}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
