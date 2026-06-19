import { memo, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, FileTextIcon, ListTodoIcon, LoaderIcon } from "lucide-react";

import type { PlanTaskBadgeState } from "../../planPanelState";
import { proposedPlanTitle } from "../../proposedPlan";
import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface TaskProgressPopoverProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  badge: PlanTaskBadgeState | null;
  label: string;
}

const COLLAPSED_TASK_LIMIT = 3;
const SUMMARY_DISCLOSURE_MIN_LENGTH = 44;

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

function taskStatusIcon(status: ActivePlanState["steps"][number]["status"]): ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
        <CheckIcon className="size-3" aria-hidden="true" />
      </span>
    );
  }

  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary-readable">
        <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

function taskStatusLabel(status: ActivePlanState["steps"][number]["status"]): string {
  if (status === "completed") return "Done";
  if (status === "inProgress") return "Now";
  return "Next";
}

function taskSummary(activePlan: ActivePlanState | null, activeProposedPlan: boolean): string {
  if (!activePlan) {
    return activeProposedPlan ? "Plan ready to implement" : "No current tasks";
  }

  const total = activePlan.steps.length;
  const completedCount = activePlan.steps.filter((step) => step.status === "completed").length;
  const activeStep = activePlan.steps.find((step) => step.status === "inProgress");

  if (activeStep) {
    return activeStep.step;
  }

  if (completedCount === total) {
    return "All steps complete";
  }

  return `${completedCount} of ${total} complete`;
}

function keyedPlanSteps(steps: ActivePlanState["steps"]) {
  const seenKeys = new Map<string, number>();
  return steps.map((step) => {
    const baseKey = `${step.status}:${step.step}`;
    const count = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, count + 1);
    return {
      key: count === 0 ? baseKey : `${baseKey}:${count}`,
      step,
    };
  });
}

function collapsedPlanStepWindow(steps: ActivePlanState["steps"]): {
  start: number;
  end: number;
} {
  if (steps.length <= COLLAPSED_TASK_LIMIT) {
    return { start: 0, end: steps.length };
  }

  const activeIndex = steps.findIndex((step) => step.status === "inProgress");
  const anchorIndex =
    activeIndex >= 0 ? activeIndex : steps.findIndex((step) => step.status !== "completed");

  if (anchorIndex < 0) {
    return { start: Math.max(0, steps.length - COLLAPSED_TASK_LIMIT), end: steps.length };
  }

  const preferredStart = Math.max(0, anchorIndex - 1);
  const start = Math.min(preferredStart, steps.length - COLLAPSED_TASK_LIMIT);

  return { start, end: start + COLLAPSED_TASK_LIMIT };
}

function triggerTooltipText(input: {
  headerLabel: string;
  summary: string;
  badge: PlanTaskBadgeState | null;
}): string {
  const prefix = input.badge ? `${input.headerLabel} ${input.badge.label}` : input.headerLabel;
  return `${prefix}: ${input.summary}. Click to view progress.`;
}

export const TaskProgressPopover = memo(function TaskProgressPopover({
  activePlan,
  activeProposedPlan,
  badge,
  label,
}: TaskProgressPopoverProps) {
  const [expanded, setExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const planStepRows = useMemo(
    () => (activePlan ? keyedPlanSteps(activePlan.steps) : []),
    [activePlan],
  );

  if (!activePlan && !activeProposedPlan && !badge) {
    return null;
  }

  const headerLabel = activePlan ? "Current tasks" : label;
  const summary = taskSummary(activePlan, activeProposedPlan !== null);
  const summaryCanExpand = summary.length > SUMMARY_DISCLOSURE_MIN_LENGTH;
  const planTitle = activeProposedPlan
    ? (proposedPlanTitle(activeProposedPlan.planMarkdown) ?? "Plan ready")
    : null;
  const triggerLabel = badge?.ariaLabel ?? `${headerLabel} progress`;
  const tooltipText = triggerTooltipText({ headerLabel, summary, badge });
  const collapsedWindow = activePlan ? collapsedPlanStepWindow(activePlan.steps) : null;
  const shouldCollapsePlanSteps = activePlan
    ? activePlan.steps.length > COLLAPSED_TASK_LIMIT
    : false;
  const visiblePlanStepRows =
    shouldCollapsePlanSteps && !expanded && collapsedWindow
      ? planStepRows.slice(collapsedWindow.start, collapsedWindow.end)
      : planStepRows;

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
                    "h-6 min-w-6 rounded-[5px] px-1.5 text-[11px] [-webkit-app-region:no-drag]",
                    badge ? "pr-1" : undefined,
                  )}
                  aria-label={triggerLabel}
                />
              }
            />
          }
        >
          <ListTodoIcon className="size-3" aria-hidden="true" />
          {badge ? (
            <span className={badgeClassName(badge.tone, badge.pulse)}>{badge.label}</span>
          ) : null}
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
                <div className="text-xs font-medium text-foreground">{headerLabel}</div>
                {summaryCanExpand ? (
                  <button
                    type="button"
                    className={cn(
                      "mt-0.5 flex max-w-full items-start gap-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground",
                      summaryExpanded && "pr-1",
                    )}
                    aria-expanded={summaryExpanded}
                    title={summary}
                    onClick={() => setSummaryExpanded((value) => !value)}
                  >
                    <span
                      className={cn(
                        "min-w-0",
                        summaryExpanded
                          ? "max-h-20 overflow-y-auto whitespace-normal break-words"
                          : "truncate",
                      )}
                    >
                      {summary}
                    </span>
                    <ChevronDownIcon
                      className={cn(
                        "mt-0.5 size-3 shrink-0 opacity-55 transition-transform",
                        summaryExpanded && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                ) : (
                  <div
                    className="mt-0.5 truncate text-[11px] text-muted-foreground/70"
                    title={summary}
                  >
                    {summary}
                  </div>
                )}
              </div>
              {badge ? (
                <span className={badgeClassName(badge.tone, badge.pulse)}>{badge.label}</span>
              ) : null}
            </div>

            {activePlan && activePlan.steps.length > 0 ? (
              <div className="space-y-2">
                <div className={cn("space-y-1 pr-1", expanded && "max-h-72 overflow-y-auto")}>
                  {visiblePlanStepRows.map(({ key, step }) => (
                    <div
                      key={key}
                      className={cn(
                        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-2 transition-colors",
                        step.status === "inProgress" && "bg-primary/5",
                        step.status === "completed" && "bg-emerald-500/5",
                      )}
                    >
                      <div className="mt-0.5">{taskStatusIcon(step.status)}</div>
                      <div
                        className={cn(
                          "min-w-0 text-[12px] leading-snug",
                          step.status === "completed"
                            ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                            : step.status === "inProgress"
                              ? "text-foreground/90"
                              : "text-muted-foreground/75",
                        )}
                      >
                        {step.step}
                      </div>
                      <div className="pt-0.5 text-[10px] text-muted-foreground/50">
                        {taskStatusLabel(step.status)}
                      </div>
                    </div>
                  ))}
                </div>
                {shouldCollapsePlanSteps ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 w-full justify-center text-[11px] text-muted-foreground/75 hover:text-foreground"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? "Show less" : `Show all ${activePlan.steps.length} steps`}
                  </Button>
                ) : null}
              </div>
            ) : activeProposedPlan ? (
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md border border-border/60 bg-muted/25 px-2 py-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <FileTextIcon className="size-3" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-foreground/90" title={planTitle ?? ""}>
                    {planTitle}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground/65">
                    Ready for the next implementation turn.
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </Tooltip>
  );
});
