"use client";

import type { ProviderAccountTokenUsagePresentation } from "../lib/providerUsage";
import { cn } from "../lib/utils";

export function ProviderUsageHistory(props: {
  readonly history: ProviderAccountTokenUsagePresentation;
  readonly compact?: boolean;
}) {
  const displayBuckets = props.history.buckets.slice(-14);
  const hasBuckets = displayBuckets.length > 0;
  const hasSummary = props.history.summary.length > 0;
  if (!hasBuckets && !hasSummary) return null;

  return (
    <div className={cn("space-y-1.5", props.compact ? "pt-0.5" : "pt-1")}>
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{props.history.label}</span>
        {hasSummary ? (
          <span className="truncate text-muted-foreground">
            {props.history.summary.map((entry) => `${entry.label} ${entry.value}`).join(" · ")}
          </span>
        ) : null}
      </div>
      {hasBuckets ? (
        <div
          className={cn(
            "flex items-end gap-0.5 overflow-hidden rounded-sm bg-muted/25 px-1.5 py-1",
            props.compact ? "h-9" : "h-10",
          )}
          aria-label={`${props.history.label} daily token usage`}
        >
          {displayBuckets.map((bucket) => (
            <div
              key={bucket.startDate}
              className="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5"
              title={`${bucket.label}: ${bucket.tokenLabel} tokens`}
            >
              <div
                className="w-full min-w-1 rounded-t-sm bg-primary/75"
                style={{ height: `${bucket.intensityPercent}%` }}
              />
              {!props.compact ? (
                <span className="max-w-full truncate text-[9px] leading-none text-muted-foreground/75">
                  {bucket.tokenLabel}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
