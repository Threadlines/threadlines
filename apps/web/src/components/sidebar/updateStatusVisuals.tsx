import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Shared visual language for the sidebar updater surfaces (app update chip,
 * provider update card, arm64 build warning). Every updater maps its
 * domain-specific state onto one of these tones so the footer reads as a
 * single system: progress = primary, success = ready/done, warning = needs
 * attention, error = failed, neutral = queued/idle accents.
 */
export type UpdateStatusTone = "neutral" | "progress" | "success" | "warning" | "error";

/**
 * Container treatment for active updater chips/cards: a neutral surface with
 * a subtle tone border. State color lives in the accents (text, dot, badge,
 * rail) so a finished update doesn't flood the footer with green.
 */
export const UPDATE_STATUS_SURFACE_STYLES: Record<Exclude<UpdateStatusTone, "neutral">, string> = {
  progress: "border-primary/25 bg-sidebar-accent/55 shadow-[0_1px_0_rgb(255_255_255_/_0.04)_inset]",
  success: "border-success/25 bg-sidebar-accent/50 shadow-[0_1px_0_rgb(255_255_255_/_0.04)_inset]",
  warning: "border-warning/28 bg-sidebar-accent/50 shadow-[0_1px_0_rgb(255_255_255_/_0.04)_inset]",
  error:
    "border-destructive/28 bg-sidebar-accent/50 shadow-[0_1px_0_rgb(255_255_255_/_0.04)_inset]",
};

export const UPDATE_STATUS_TEXT_STYLES: Record<UpdateStatusTone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-primary-readable",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

// Dots stay static — the aggregate rail's shimmer is the single motion
// source on an updater card, so a busy corner never strobes.
export const UPDATE_STATUS_DOT_STYLES: Record<UpdateStatusTone, string> = {
  neutral: "bg-muted-foreground/45",
  progress: "bg-primary-readable ring-2 ring-primary/15",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

const UPDATE_STATUS_BADGE_STYLES: Record<UpdateStatusTone, string> = {
  neutral: "border-muted-foreground/20 bg-muted-foreground/8 text-muted-foreground",
  progress: "border-primary/18 bg-primary/8 text-primary-readable",
  success: "border-success/20 bg-success/8 text-success",
  warning: "border-warning/24 bg-warning/8 text-warning",
  error: "border-destructive/24 bg-destructive/8 text-destructive",
};

export const UPDATE_STATUS_RAIL_FILL_STYLES: Record<UpdateStatusTone, string> = {
  neutral: "bg-muted-foreground/45",
  progress: "bg-primary-readable",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

/** Bordered mini status badge ("42%", "Updating", "Failed", …). */
export function UpdateStatusBadge({
  tone,
  className,
  children,
}: {
  tone: UpdateStatusTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm border px-1.5 py-px text-[9.5px] leading-3 font-medium",
        UPDATE_STATUS_BADGE_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Determinate progress rail with an indeterminate shimmer over the remainder
 * while work is still in flight. Size/position via className (h-0.5 default).
 */
export function UpdateProgressRail({
  tone,
  percent,
  indeterminate = false,
  className,
}: {
  tone: UpdateStatusTone;
  percent: number;
  indeterminate?: boolean;
  className?: string;
}) {
  const progressPercent = Math.max(0, Math.min(100, percent));
  const showIndeterminate = indeterminate && progressPercent < 100;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block h-0.5 w-full overflow-hidden rounded-full bg-foreground/8",
        className,
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out",
          UPDATE_STATUS_RAIL_FILL_STYLES[tone],
        )}
        style={{ width: `${progressPercent}%` }}
      />
      {showIndeterminate ? (
        <span
          className="absolute inset-y-0 right-0 overflow-hidden rounded-full"
          style={{ left: `${progressPercent}%` }}
        >
          <span
            className={cn(
              "update-indeterminate-rail absolute inset-y-0 left-0 w-[45%] rounded-full",
              UPDATE_STATUS_RAIL_FILL_STYLES[tone],
            )}
          />
        </span>
      ) : null}
    </span>
  );
}
