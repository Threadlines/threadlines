import { memo, useMemo, useState, type ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ListTodoIcon,
  LoaderIcon,
  RadarIcon,
  SquareIcon,
  TerminalSquareIcon,
} from "lucide-react";

import type { PlanTaskBadgeState } from "../../planPanelState";
import { proposedPlanTitle } from "../../proposedPlan";
import type {
  ActivePlanState,
  LatestProposedPlanState,
  SubagentProgressItem,
  SubagentProgressState,
} from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ThreadTaskProgressState {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  badge: PlanTaskBadgeState | null;
  label: string;
}

export interface ThreadBackgroundRunItem {
  id: string;
  source: "terminal" | "provider" | "detected" | "mentioned-preview";
  label: string;
  detail: string | null;
  cwd: string | null;
  statusLabel: string;
  urls: ReadonlyArray<string>;
  terminalId: string | null;
  pid: number | null;
  port: number | null;
  canStop: boolean;
}

interface ThreadActivityPopoverProps {
  taskProgress: ThreadTaskProgressState | null;
  subagentProgress: SubagentProgressState | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  onOpenBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
}

type ActivityBadgeTone = PlanTaskBadgeState["tone"] | SubagentProgressState["badge"]["tone"];

interface ActivityBadgeState {
  kind: "tasks" | "subagents" | "background";
  label: string;
  ariaLabel: string;
  tone: ActivityBadgeTone;
  pulse: boolean;
}

interface ActivityTriggerState {
  mode: "tasks" | "subagents" | "background" | "mixed";
  badge: ActivityBadgeState | null;
  chips: ReadonlyArray<ActivityBadgeState>;
  ariaLabel: string;
  tooltipText: string;
  summary: string;
}

const COLLAPSED_TASK_LIMIT = 3;
const COLLAPSED_SUBAGENT_LIMIT = 3;
const SUMMARY_DISCLOSURE_MIN_LENGTH = 44;

function badgeClassName(tone: ActivityBadgeTone, pulse: boolean) {
  return cn(
    "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--app-radius-badge)] px-1 pt-px font-semibold text-[10px] leading-none tabular-nums",
    tone === "active" && "bg-primary/15 text-primary-readable",
    tone === "complete" && "bg-success/15 text-success",
    tone === "ready" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    tone === "warning" && "bg-destructive/15 text-destructive",
    tone === "idle" && "bg-muted text-muted-foreground",
    pulse && "animate-pulse",
  );
}

function chipClassName(tone: ActivityBadgeTone, pulse: boolean) {
  return cn(
    "inline-flex h-4 min-w-4 items-center justify-center gap-1 rounded-[var(--app-radius-badge)] px-1 pt-px font-semibold text-[10px] leading-none tabular-nums",
    tone === "active" && "bg-primary/15 text-primary-readable",
    tone === "complete" && "bg-success/15 text-success",
    tone === "ready" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    tone === "warning" && "bg-destructive/15 text-destructive",
    tone === "idle" && "bg-muted text-muted-foreground",
    pulse && "animate-pulse",
  );
}

function TriggerIcon({ mode }: { mode: ActivityTriggerState["mode"] }) {
  if (mode === "tasks") {
    return <ListTodoIcon className="size-3" aria-hidden="true" />;
  }
  if (mode === "subagents") {
    return <BotIcon className="size-3" aria-hidden="true" />;
  }
  if (mode === "background") {
    return <RadarIcon className="size-3" aria-hidden="true" />;
  }
  return <ListTodoIcon className="size-3" aria-hidden="true" />;
}

function TriggerChip({ chip }: { chip: ActivityBadgeState }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5" title={chip.ariaLabel}>
      {chip.kind === "subagents" ? (
        <BotIcon className="size-3 text-foreground/80" aria-hidden="true" />
      ) : null}
      {chip.kind === "background" ? (
        <RadarIcon className="size-3 text-foreground/80" aria-hidden="true" />
      ) : null}
      <span className={chipClassName(chip.tone, chip.pulse)}>{chip.label}</span>
    </span>
  );
}

function TriggerContent({ state }: { state: ActivityTriggerState }) {
  if (state.mode === "mixed") {
    return (
      <>
        <TriggerIcon mode={state.mode} />
        <span className="flex min-w-0 items-center gap-0.5">
          {state.chips.map((chip) => (
            <TriggerChip key={chip.kind} chip={chip} />
          ))}
        </span>
      </>
    );
  }

  return (
    <>
      <TriggerIcon mode={state.mode} />
      {state.badge ? (
        <span className={badgeClassName(state.badge.tone, state.badge.pulse)}>
          {state.badge.label}
        </span>
      ) : null}
    </>
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

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function backgroundSummary(backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>): string | null {
  const total = backgroundRuns.length;
  return total > 0 ? formatCount(total, "background run", "background runs") : null;
}

function backgroundRunSectionSummary(
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>,
): string {
  const mentionedCount = backgroundRuns.filter((run) => run.source === "mentioned-preview").length;
  const trackedCount = backgroundRuns.length - mentionedCount;
  const parts = [
    trackedCount > 0 ? formatCount(trackedCount, "tracked run", "tracked runs") : null,
    mentionedCount > 0
      ? formatCount(mentionedCount, "mentioned preview", "mentioned previews")
      : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" / ");
}

export function deriveThreadActivityTriggerState(input: {
  taskProgress: ThreadTaskProgressState | null;
  subagentProgress: SubagentProgressState | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
}): ActivityTriggerState | null {
  const taskSummaryText = input.taskProgress
    ? taskSummary(input.taskProgress.activePlan, input.taskProgress.activeProposedPlan !== null)
    : null;
  const backgroundSummaryText = backgroundSummary(input.backgroundRuns);
  const summaryParts = [
    taskSummaryText,
    input.subagentProgress?.summary ?? null,
    backgroundSummaryText,
  ].filter((part): part is string => Boolean(part));

  if (summaryParts.length === 0) {
    return null;
  }

  const hasTasks = input.taskProgress !== null;
  const hasSubagents = input.subagentProgress !== null;
  const hasBackgroundRuns = input.backgroundRuns.length > 0;
  const activeKindCount = [hasTasks, hasSubagents, hasBackgroundRuns].filter(Boolean).length;
  const taskChip =
    input.taskProgress?.badge !== null && input.taskProgress?.badge !== undefined
      ? {
          kind: "tasks" as const,
          label: input.taskProgress.badge.label,
          ariaLabel: input.taskProgress.badge.ariaLabel,
          tone: input.taskProgress.badge.tone,
          pulse: input.taskProgress.badge.pulse,
        }
      : null;
  const subagentChip = input.subagentProgress
    ? {
        kind: "subagents" as const,
        label: input.subagentProgress.badge.label,
        ariaLabel: input.subagentProgress.badge.ariaLabel,
        tone: input.subagentProgress.badge.tone,
        pulse: input.subagentProgress.badge.pulse,
      }
    : null;
  const backgroundChip = hasBackgroundRuns
    ? {
        kind: "background" as const,
        label: String(input.backgroundRuns.length),
        ariaLabel: formatCount(input.backgroundRuns.length, "background run", "background runs"),
        tone: "active" as const,
        pulse: true,
      }
    : null;
  const chipCandidates: Array<ActivityBadgeState | null> = [taskChip, subagentChip, backgroundChip];
  const chips = chipCandidates.filter((chip): chip is ActivityBadgeState => chip !== null);
  const failedCount = input.subagentProgress?.failedCount ?? 0;
  const badge =
    activeKindCount > 1
      ? null
      : (chips[0] ??
        (failedCount > 0
          ? {
              kind: "subagents" as const,
              label: "!",
              ariaLabel: `Activity, ${formatCount(failedCount, "failed item", "failed items")}`,
              tone: "warning" as const,
              pulse: false,
            }
          : null));
  const mode =
    activeKindCount > 1 ? "mixed" : hasTasks ? "tasks" : hasSubagents ? "subagents" : "background";
  const summary = summaryParts.join(" / ");

  return {
    mode,
    badge,
    chips,
    ariaLabel: badge?.ariaLabel ?? "Thread activity",
    tooltipText: `Activity: ${summary}. Click to view details.`,
    summary,
  };
}

function TaskSection({ taskProgress }: { taskProgress: ThreadTaskProgressState }) {
  const [expanded, setExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const activePlan = taskProgress.activePlan;
  const activeProposedPlan = taskProgress.activeProposedPlan;
  const planStepRows = useMemo(
    () => (activePlan ? keyedPlanSteps(activePlan.steps) : []),
    [activePlan],
  );
  const headerLabel = activePlan ? "Current tasks" : taskProgress.label;
  const summary = taskSummary(activePlan, activeProposedPlan !== null);
  const summaryCanExpand = summary.length > SUMMARY_DISCLOSURE_MIN_LENGTH;
  const planTitle = activeProposedPlan
    ? (proposedPlanTitle(activeProposedPlan.planMarkdown) ?? "Plan ready")
    : null;
  const collapsedWindow = activePlan ? collapsedPlanStepWindow(activePlan.steps) : null;
  const shouldCollapsePlanSteps = activePlan
    ? activePlan.steps.length > COLLAPSED_TASK_LIMIT
    : false;
  const visiblePlanStepRows =
    shouldCollapsePlanSteps && !expanded && collapsedWindow
      ? planStepRows.slice(collapsedWindow.start, collapsedWindow.end)
      : planStepRows;

  return (
    <section className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <ListTodoIcon className="size-3 text-muted-foreground/70" aria-hidden="true" />
            <span>{headerLabel}</span>
          </div>
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
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={summary}>
              {summary}
            </div>
          )}
        </div>
        {taskProgress.badge ? (
          <span className={badgeClassName(taskProgress.badge.tone, taskProgress.badge.pulse)}>
            {taskProgress.badge.label}
          </span>
        ) : null}
      </div>

      {activePlan && activePlan.steps.length > 0 ? (
        <div className="space-y-2">
          <div className={cn("space-y-1 pr-1", expanded && "max-h-56 overflow-y-auto")}>
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
    </section>
  );
}

function SubagentSection({ state }: { state: SubagentProgressState }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = state.items.length > COLLAPSED_SUBAGENT_LIMIT;
  const visibleItems = useMemo(
    () =>
      shouldCollapse && !expanded ? state.items.slice(0, COLLAPSED_SUBAGENT_LIMIT) : state.items,
    [expanded, shouldCollapse, state.items],
  );

  return (
    <section className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <BotIcon className="size-3 text-muted-foreground/70" aria-hidden="true" />
            <span>Subagents</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
            {state.summary}
          </div>
        </div>
        <span className={badgeClassName(state.badge.tone, state.badge.pulse)}>
          {state.badge.label}
        </span>
      </div>

      <div className={cn("space-y-1 pr-1", expanded && "max-h-56 overflow-y-auto")}>
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
                (item.status === "failed" || item.status === "interrupted") && "bg-destructive/5",
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
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground/45">{meta}</div>
                ) : null}
              </div>
              <div className="pt-0.5 text-[10px] text-muted-foreground/50">{item.statusLabel}</div>
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
    </section>
  );
}

function BackgroundRunsSection({
  backgroundRuns,
  onOpenBackgroundRunTerminal,
  onStopBackgroundRun,
}: {
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  onOpenBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
}) {
  if (backgroundRuns.length === 0) {
    return null;
  }

  return (
    <section className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <RadarIcon className="size-3 text-muted-foreground/70" aria-hidden="true" />
            <span>Background runs</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
            {backgroundRunSectionSummary(backgroundRuns)}
          </div>
        </div>
        <span className={badgeClassName("active", true)}>{backgroundRuns.length}</span>
      </div>

      <div className="space-y-1 pr-1">
        {backgroundRuns.map((run) => (
          <div
            key={run.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md bg-primary/5 px-2 py-2"
          >
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary-readable">
              <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12px] leading-snug text-foreground/90">
                {run.label}
              </div>
              {run.detail ? (
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
                  {run.detail}
                </div>
              ) : run.cwd ? (
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/50">
                  {run.cwd}
                </div>
              ) : (
                <div className="mt-0.5 text-[10px] text-muted-foreground/50">
                  {run.source === "terminal"
                    ? "Managed terminal"
                    : run.source === "detected"
                      ? "Detected local process"
                      : run.source === "mentioned-preview"
                        ? "Mentioned only; no process handle."
                        : "Provider-managed"}
                </div>
              )}
              {run.urls.length > 0 ? (
                <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                  {run.urls.map((url) => (
                    <Button
                      key={url}
                      render={<a href={url} target="_blank" rel="noreferrer" />}
                      variant="ghost"
                      size="xs"
                      className="h-5 max-w-full gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                      title={url}
                    >
                      <ExternalLinkIcon className="size-2.5" aria-hidden="true" />
                      <span className="truncate">{url}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="pt-0.5 text-[10px] text-muted-foreground/50">{run.statusLabel}</div>
              {run.terminalId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Open ${run.label}`}
                  title={`Open ${run.label}`}
                  onClick={() => {
                    if (run.terminalId) {
                      onOpenBackgroundRunTerminal(run.terminalId);
                    }
                  }}
                >
                  <TerminalSquareIcon className="size-3" aria-hidden="true" />
                </Button>
              ) : null}
              {run.canStop ? (
                <Button
                  type="button"
                  variant="destructive-outline"
                  size="icon-xs"
                  aria-label={`Stop ${run.label}`}
                  title={`Stop ${run.label}`}
                  onClick={() => {
                    onStopBackgroundRun(run);
                  }}
                >
                  <SquareIcon className="size-3" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export const ThreadActivityPopover = memo(function ThreadActivityPopover({
  taskProgress,
  subagentProgress,
  backgroundRuns,
  onOpenBackgroundRunTerminal,
  onStopBackgroundRun,
}: ThreadActivityPopoverProps) {
  const triggerState = deriveThreadActivityTriggerState({
    taskProgress,
    subagentProgress,
    backgroundRuns,
  });

  if (!triggerState) {
    return null;
  }

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
                    triggerState.mode !== "background" && triggerState.badge ? "pr-1" : undefined,
                    triggerState.mode === "mixed" && "max-w-44",
                  )}
                  aria-label={triggerState.ariaLabel}
                />
              }
            />
          }
        >
          <TriggerContent state={triggerState} />
        </TooltipTrigger>
        <TooltipPopup side="bottom" sideOffset={8} className="max-w-72">
          {triggerState.tooltipText}
        </TooltipPopup>
        <PopoverPopup
          align="end"
          side="bottom"
          sideOffset={8}
          className="w-96 max-w-[calc(100vw-1rem)]"
        >
          <div className="min-w-0 space-y-3">
            {taskProgress ? <TaskSection taskProgress={taskProgress} /> : null}
            {subagentProgress ? <SubagentSection state={subagentProgress} /> : null}
            <BackgroundRunsSection
              backgroundRuns={backgroundRuns}
              onOpenBackgroundRunTerminal={onOpenBackgroundRunTerminal}
              onStopBackgroundRun={onStopBackgroundRun}
            />
          </div>
        </PopoverPopup>
      </Popover>
    </Tooltip>
  );
});
