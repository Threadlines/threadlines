import { memo, useMemo, useState, type ReactNode } from "react";
import { BotIcon, CheckIcon, CircleAlertIcon, LoaderIcon } from "lucide-react";

import type { SubagentProgressItem, SubagentProgressState } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface SubagentProgressPopoverProps {
  state: SubagentProgressState;
}

const COLLAPSED_SUBAGENT_LIMIT = 3;

function badgeClassName(tone: SubagentProgressState["badge"]["tone"], pulse: boolean) {
  return cn(
    "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--app-radius-badge)] px-1 font-semibold text-[10px] leading-none tabular-nums",
    tone === "active" && "bg-primary/15 text-primary-readable",
    tone === "complete" && "bg-success/15 text-success",
    tone === "warning" && "bg-destructive/15 text-destructive",
    tone === "idle" && "bg-muted text-muted-foreground",
    pulse && "animate-pulse",
  );
}

function subagentStatusIcon(status: SubagentProgressItem["status"]): ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckIcon className="size-3" aria-hidden="true" />
      </span>
    );
  }

  if (status === "failed" || status === "interrupted") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <CircleAlertIcon className="size-3" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary-readable">
      <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
    </span>
  );
}

function subagentMeta(item: SubagentProgressItem): string | null {
  const parts = [item.model, item.reasoningEffort].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" / ") : null;
}

export const SubagentProgressPopover = memo(function SubagentProgressPopover({
  state,
}: SubagentProgressPopoverProps) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = state.items.length > COLLAPSED_SUBAGENT_LIMIT;
  const visibleItems = useMemo(
    () =>
      shouldCollapse && !expanded ? state.items.slice(0, COLLAPSED_SUBAGENT_LIMIT) : state.items,
    [expanded, shouldCollapse, state.items],
  );
  const tooltipText = `${state.summary}. Click to view subagent progress.`;

  return (
    <Tooltip>
      <Popover>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className={cn(
                    "h-6 min-w-6 px-1.5 text-[11px] [-webkit-app-region:no-drag]",
                    "pr-1",
                  )}
                  aria-label={state.badge.ariaLabel}
                />
              }
            />
          }
        >
          <BotIcon className="size-3" aria-hidden="true" />
          <span className={badgeClassName(state.badge.tone, state.badge.pulse)}>
            {state.badge.label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom" sideOffset={8} className="max-w-72">
          {tooltipText}
        </TooltipPopup>
        <PopoverPopup
          align="end"
          side="bottom"
          sideOffset={8}
          className="w-80 max-w-[calc(100vw-1rem)]"
        >
          <div className="min-w-0 space-y-3">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">Subagents</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                  {state.summary}
                </div>
              </div>
              <span className={badgeClassName(state.badge.tone, state.badge.pulse)}>
                {state.badge.label}
              </span>
            </div>

            <div className={cn("space-y-1 pr-1", expanded && "max-h-72 overflow-y-auto")}>
              {visibleItems.map((item) => {
                const meta = subagentMeta(item);
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-2 transition-colors",
                      (item.status === "starting" ||
                        item.status === "running" ||
                        item.status === "waiting") &&
                        "bg-primary/5",
                      item.status === "completed" && "bg-success/5",
                      (item.status === "failed" || item.status === "interrupted") &&
                        "bg-destructive/5",
                    )}
                  >
                    <div className="mt-0.5">{subagentStatusIcon(item.status)}</div>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] leading-snug text-foreground/90">
                        {item.label}
                      </div>
                      {item.objective ? (
                        <div
                          className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground/70"
                          title={item.objective}
                        >
                          {item.objective}
                        </div>
                      ) : null}
                      {meta ? (
                        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/45">
                          {meta}
                        </div>
                      ) : null}
                    </div>
                    <div className="pt-0.5 text-[10px] text-muted-foreground/50">
                      {item.statusLabel}
                    </div>
                  </div>
                );
              })}
            </div>

            {shouldCollapse ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 w-full justify-center text-[11px] text-muted-foreground/75 hover:text-foreground"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : `Show all ${state.items.length} subagents`}
              </Button>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </Tooltip>
  );
});
