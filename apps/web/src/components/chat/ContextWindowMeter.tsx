import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  isProviderUsageNearLimit,
  type ProviderAccountUsagePresentation,
} from "~/lib/providerUsage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function AccountUsageBar(props: {
  usageLabel: string;
  rowLabel: string;
  detail: string;
  usedPercent: number;
  reachedLimit: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-4 whitespace-nowrap text-xs">
        <span className="font-medium text-foreground">{props.rowLabel}</span>
        <span className="text-muted-foreground">{props.detail}</span>
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
}) {
  const { usage, contextWindowLabel } = props;
  const accountUsage = props.accountUsage ?? null;
  const usageNearLimit = isProviderUsageNearLimit(accountUsage);
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  const contextAriaLabel = !usage
    ? "Context window — no tokens used yet"
    : usage.maxTokens !== null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={
              usageNearLimit && accountUsage
                ? `${contextAriaLabel}, ${accountUsage.label} near limit`
                : contextAriaLabel
            }
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
                />
                {usage ? (
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    stroke="var(--color-muted-foreground)"
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
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
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
            {usage?.compactsAutomatically ? (
              <div className="text-xs text-muted-foreground">
                Automatically compacts its context when needed.
              </div>
            ) : null}
          </div>
          {accountUsage ? (
            <div className="space-y-1.5 border-border/60 border-t pt-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {accountUsage.label}
              </div>
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
