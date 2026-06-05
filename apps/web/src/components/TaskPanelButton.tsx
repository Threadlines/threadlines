import { ListTodoIcon } from "lucide-react";

import type { PlanTaskBadgeState } from "../planPanelState";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface TaskPanelButtonProps {
  active: boolean;
  badge: PlanTaskBadgeState | null;
  disabled?: boolean;
  onClick: () => void;
}

function badgeClassName(tone: PlanTaskBadgeState["tone"], pulse: boolean) {
  return cn(
    "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] px-1 font-semibold text-[10px] leading-none tabular-nums",
    tone === "active" && "bg-primary/15 text-primary-readable",
    tone === "complete" && "bg-success/15 text-success",
    tone === "ready" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    tone === "idle" && "bg-muted text-muted-foreground",
    pulse && "animate-pulse",
  );
}

export function TaskPanelButton({
  active,
  badge,
  disabled = false,
  onClick,
}: TaskPanelButtonProps) {
  const label = badge?.ariaLabel ?? (disabled ? "No tasks yet" : "Tasks");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(
              "h-6 min-w-6 rounded-[5px] px-1.5 text-[11px] [-webkit-app-region:no-drag]",
              active
                ? "bg-control-active text-foreground shadow-none hover:bg-control-active"
                : "text-muted-foreground/75 hover:text-foreground",
              badge ? "pr-1" : undefined,
            )}
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <ListTodoIcon className="size-3" />
        {badge ? (
          <span className={badgeClassName(badge.tone, badge.pulse)}>{badge.label}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup
        align="end"
        side="bottom"
        sideOffset={8}
        className="border-border/80 bg-[color-mix(in_srgb,var(--popover)_86%,var(--foreground))] text-popover-foreground shadow-xl shadow-black/20"
      >
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}
