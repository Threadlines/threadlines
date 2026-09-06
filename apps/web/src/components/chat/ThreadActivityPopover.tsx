import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from "react";
import {
  ChevronDownIcon,
  ClockIcon,
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
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { type ActivePlanState, type LatestProposedPlanState } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SpineNode, SpineRow, spineAccentRowStyle, type SpineNodeKind } from "../ui/threadline";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "../ui/tooltip";
import {
  backgroundRunCommandText,
  backgroundRunMetaItems,
  backgroundRunSourceLabel,
  type ThreadBackgroundRunItem,
} from "./threadActivity";

export interface ThreadTaskProgressState {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  badge: PlanTaskBadgeState | null;
  label: string;
}

interface ThreadActivityPopoverProps {
  taskProgress: ThreadTaskProgressState | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onViewProposedPlan?: (() => void) | undefined;
  onImplementProposedPlan?: (() => void) | undefined;
  onDismissProposedPlan?: (() => void) | undefined;
}

type ActivityBadgeTone = PlanTaskBadgeState["tone"];

interface ActivityBadgeState {
  kind: "tasks" | "background";
  label: string;
  ariaLabel: string;
  tone: ActivityBadgeTone;
  pulse: boolean;
}

interface ActivityTriggerState {
  mode: "tasks" | "background" | "mixed";
  badge: ActivityBadgeState | null;
  chips: ReadonlyArray<ActivityBadgeState>;
  ariaLabel: string;
  tooltipText: string;
  summary: string;
}

const COLLAPSED_TASK_LIMIT = 3;
const ACTIVITY_POPOVER_MIN_WIDTH_PX = 256;
const ACTIVITY_POPOVER_PREFERRED_MIN_WIDTH_PX = 320;
const ACTIVITY_POPOVER_MAX_WIDTH_PX = 480;
const ACTIVITY_POPOVER_VIEWPORT_WIDTH_RATIO = 0.36;
const ACTIVITY_POPOVER_BOUNDARY_GUTTER_PX = 12;
const OVERFLOW_MEASUREMENT_EPSILON_PX = 1;

type ActivityPopoverWidthStyle = CSSProperties & {
  "--thread-activity-popover-width": string;
};

function badgeClassName(tone: ActivityBadgeTone, pulse: boolean) {
  return cn(
    "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--app-radius-badge)] px-1 pt-px font-semibold text-[10px] leading-none tabular-nums",
    tone === "active" && "bg-primary/15 text-primary-readable",
    tone === "complete" && "bg-success/15 text-success",
    tone === "ready" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    tone === "idle" && "bg-muted text-muted-foreground",
    pulse && "animate-status-pulse",
  );
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function quantizeLayoutValue(value: number): number {
  return Math.round(value / 4) * 4;
}

function preferredActivityPopoverWidth(viewportWidth: number): number {
  return clampNumber(
    viewportWidth * ACTIVITY_POPOVER_VIEWPORT_WIDTH_RATIO,
    ACTIVITY_POPOVER_PREFERRED_MIN_WIDTH_PX,
    ACTIVITY_POPOVER_MAX_WIDTH_PX,
  );
}

function resolveActivityPopoverWidth(input: {
  triggerRight: number;
  boundaryLeft: number;
  viewportWidth: number;
}): number {
  const preferredWidth = preferredActivityPopoverWidth(input.viewportWidth);
  const availableBeforeBoundary =
    input.triggerRight - input.boundaryLeft - ACTIVITY_POPOVER_BOUNDARY_GUTTER_PX;
  const usableWidth = Math.max(ACTIVITY_POPOVER_MIN_WIDTH_PX, availableBeforeBoundary);
  return Math.round(Math.min(preferredWidth, usableWidth));
}

function hasHorizontalOverflow(element: HTMLElement): boolean {
  return element.scrollWidth - element.clientWidth > OVERFLOW_MEASUREMENT_EPSILON_PX;
}

function useHorizontalOverflow(
  contentKey: string,
  enabled: boolean,
): {
  elementRef: RefCallback<HTMLSpanElement>;
  overflows: boolean;
} {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const elementRef = useCallback<RefCallback<HTMLSpanElement>>((node) => {
    setElement(node);
  }, []);

  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    if (!element) {
      setOverflows(false);
      return;
    }

    let frameId: number | null = null;

    const measure = () => {
      frameId = null;
      const nextOverflows = hasHorizontalOverflow(element);
      setOverflows((current) => (current === nextOverflows ? current : nextOverflows));
    };

    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(measure);
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [contentKey, element, enabled]);

  return { elementRef, overflows };
}

function useActivityPopoverAnchorLayout(open: boolean): {
  triggerRef: RefObject<HTMLButtonElement | null>;
  layoutKey: string;
  widthStyle: ActivityPopoverWidthStyle;
} {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [layout, setLayout] = useState(() => ({
    key: "initial",
    widthPx: ACTIVITY_POPOVER_MAX_WIDTH_PX,
  }));

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") {
      return;
    }

    let frameId: number | null = null;

    const measure = () => {
      frameId = null;
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const triggerRect = trigger.getBoundingClientRect();
      const boundaryRect = trigger.closest("main")?.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const boundaryLeft = boundaryRect?.left ?? ACTIVITY_POPOVER_BOUNDARY_GUTTER_PX;
      const widthPx = resolveActivityPopoverWidth({
        triggerRight: triggerRect.right,
        boundaryLeft,
        viewportWidth,
      });
      const key = [
        quantizeLayoutValue(triggerRect.right),
        quantizeLayoutValue(boundaryLeft),
        quantizeLayoutValue(widthPx),
      ].join(":");

      setLayout((current) =>
        current.key === key && current.widthPx === widthPx ? current : { key, widthPx },
      );
    };

    const scheduleMeasure = () => {
      if (frameId === null) {
        frameId = window.requestAnimationFrame(measure);
      }
    };

    measure();

    const trigger = triggerRef.current;
    const boundary = trigger?.closest("main") ?? null;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    if (trigger) {
      resizeObserver?.observe(trigger);
    }
    if (boundary) {
      resizeObserver?.observe(boundary);
    }
    window.addEventListener("resize", scheduleMeasure);
    window.visualViewport?.addEventListener("resize", scheduleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
    };
  }, [open]);

  const widthStyle = useMemo<ActivityPopoverWidthStyle>(
    () => ({
      "--thread-activity-popover-width": `${layout.widthPx}px`,
    }),
    [layout.widthPx],
  );

  return {
    triggerRef,
    layoutKey: layout.key,
    widthStyle,
  };
}

function chipClassName(tone: ActivityBadgeTone, pulse: boolean) {
  return cn(
    "inline-flex h-4 min-w-4 items-center justify-center gap-1 rounded-[var(--app-radius-badge)] px-1 pt-px font-semibold text-[10px] leading-none tabular-nums",
    tone === "active" && "bg-primary/15 text-primary-readable",
    tone === "complete" && "bg-success/15 text-success",
    tone === "ready" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    tone === "idle" && "bg-muted text-muted-foreground",
    pulse && "animate-status-pulse",
  );
}

function ActivityKindIcon({
  kind,
  className,
}: {
  kind: ActivityBadgeState["kind"];
  className: string;
}) {
  if (kind === "tasks") {
    return (
      <ListTodoIcon className={className} data-activity-trigger-icon="tasks" aria-hidden="true" />
    );
  }
  return (
    <RadarIcon className={className} data-activity-trigger-icon="background" aria-hidden="true" />
  );
}

function TriggerChip({ chip }: { chip: ActivityBadgeState }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <ActivityKindIcon kind={chip.kind} className="size-3 text-foreground/80" />
      <span className={chipClassName(chip.tone, chip.pulse)}>{chip.label}</span>
    </span>
  );
}

function TriggerContent({ state }: { state: ActivityTriggerState }) {
  if (state.mode === "mixed") {
    return (
      <span className="flex min-w-0 items-center gap-0.5">
        {state.chips.map((chip) => (
          <TriggerChip key={chip.kind} chip={chip} />
        ))}
      </span>
    );
  }

  return (
    <>
      <ActivityKindIcon kind={state.mode} className="size-3" />
      {state.badge ? (
        <span className={badgeClassName(state.badge.tone, state.badge.pulse)}>
          {state.badge.label}
        </span>
      ) : null}
    </>
  );
}

type PlanStepStatus = ActivePlanState["steps"][number]["status"];

function taskStepNodeKind(status: PlanStepStatus): SpineNodeKind {
  if (status === "completed") return "done";
  if (status === "inProgress") return "running";
  return "pending";
}

/** Spoken status for each step; the spine node carries it visually. */
function taskStatusLabel(status: PlanStepStatus): string {
  if (status === "completed") return "Done";
  if (status === "inProgress") return "Now";
  return "Next";
}

// Step rows are 12px text on a 16px line over 4px of top padding, so the node
// lands on the first line's centre.
const TASK_STEP_NODE_OFFSET_PX = 12;
const TASK_SPINE_STYLE = { ["--spine"]: "var(--border)" } as CSSProperties;

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
  const stoppableCount = backgroundRuns.filter((run) => run.canStop).length;
  const trackedCount = backgroundRuns.length - stoppableCount;
  const parts = [
    stoppableCount > 0 ? formatCount(stoppableCount, "active run", "active runs") : null,
    trackedCount > 0 ? formatCount(trackedCount, "tracked run", "tracked runs") : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" / ");
}

export function deriveThreadActivityTriggerState(input: {
  taskProgress: ThreadTaskProgressState | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
}): ActivityTriggerState | null {
  const taskSummaryText = input.taskProgress
    ? taskSummary(input.taskProgress.activePlan, input.taskProgress.activeProposedPlan !== null)
    : null;
  const backgroundSummaryText = backgroundSummary(input.backgroundRuns);
  const summaryParts = [taskSummaryText, backgroundSummaryText].filter((part): part is string =>
    Boolean(part),
  );

  if (summaryParts.length === 0) {
    return null;
  }

  const hasTasks = input.taskProgress !== null;
  const hasBackgroundRuns = input.backgroundRuns.length > 0;
  const activeKindCount = [hasTasks, hasBackgroundRuns].filter(Boolean).length;
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
  const backgroundChip = hasBackgroundRuns
    ? {
        kind: "background" as const,
        label: String(input.backgroundRuns.length),
        ariaLabel: formatCount(input.backgroundRuns.length, "background run", "background runs"),
        tone: "active" as const,
        pulse: true,
      }
    : null;
  const chipCandidates: Array<ActivityBadgeState | null> = [taskChip, backgroundChip];
  const chips = chipCandidates.filter((chip): chip is ActivityBadgeState => chip !== null);
  const badge = activeKindCount > 1 ? null : (chips[0] ?? null);
  const mode = activeKindCount > 1 ? "mixed" : hasTasks ? "tasks" : "background";
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

function TaskSection({
  taskProgress,
  onViewProposedPlan,
  onImplementProposedPlan,
  onDismissProposedPlan,
}: {
  taskProgress: ThreadTaskProgressState;
  onViewProposedPlan?: (() => void) | undefined;
  onImplementProposedPlan?: (() => void) | undefined;
  onDismissProposedPlan?: (() => void) | undefined;
}) {
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
  const summaryOverflow = useHorizontalOverflow(summary, !summaryExpanded);
  const summaryCanExpand = summaryExpanded || summaryOverflow.overflows;
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
  const liveStepIndex = visiblePlanStepRows.findIndex(({ step }) => step.status === "inProgress");

  return (
    <section className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <ListTodoIcon className="size-3 text-muted-foreground/85" aria-hidden="true" />
            <span>{headerLabel}</span>
          </div>
          {summaryCanExpand ? (
            <button
              type="button"
              className={cn(
                "mt-0.5 flex max-w-full items-start gap-1 text-left text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground/85",
                summaryExpanded && "pr-1",
              )}
              aria-expanded={summaryExpanded}
              title={summary}
              onClick={() => setSummaryExpanded((value) => !value)}
              data-task-summary-toggle="true"
            >
              <span
                ref={summaryOverflow.elementRef}
                className={cn(
                  "min-w-0",
                  summaryExpanded
                    ? "max-h-20 overflow-y-auto whitespace-normal break-words"
                    : "truncate",
                )}
                data-task-summary-text="true"
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
            <div className="mt-0.5 text-[11px] text-muted-foreground/80">
              <span
                ref={summaryOverflow.elementRef}
                className="block min-w-0 truncate"
                data-task-summary-text="true"
              >
                {summary}
              </span>
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
        <div className="space-y-1.5">
          <div
            className={cn("pr-1", expanded && "max-h-56 overflow-y-auto")}
            style={TASK_SPINE_STYLE}
          >
            {visiblePlanStepRows.map(({ key, step }, index) => (
              <SpineRow
                key={key}
                node={<SpineNode kind={taskStepNodeKind(step.status)} />}
                nodeOffset={TASK_STEP_NODE_OFFSET_PX}
                connectTop={index > 0}
                connectBottom={index < visiblePlanStepRows.length - 1}
                style={
                  liveStepIndex >= 0
                    ? spineAccentRowStyle(Math.abs(index - liveStepIndex))
                    : undefined
                }
              >
                <div
                  className={cn(
                    "min-w-0 py-1 text-[12px] leading-4 break-words",
                    step.status === "completed"
                      ? "text-muted-foreground/70"
                      : step.status === "inProgress"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground/85",
                  )}
                >
                  <span className="sr-only">{taskStatusLabel(step.status)}: </span>
                  {step.step}
                </div>
              </SpineRow>
            ))}
          </div>
          {shouldCollapsePlanSteps ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-5 w-full justify-center text-[11px] text-muted-foreground/80 hover:text-foreground"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : `Show all ${activePlan.steps.length} steps`}
            </Button>
          ) : null}
        </div>
      ) : activeProposedPlan ? (
        <div className="rounded-md border border-border/60 bg-muted/25 px-2 py-2">
          <button
            type="button"
            className={cn(
              "grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2 text-left",
              onViewProposedPlan &&
                "cursor-pointer rounded-sm transition-colors hover:text-foreground focus-ring",
            )}
            disabled={!onViewProposedPlan}
            aria-label="View plan in conversation"
            onClick={onViewProposedPlan}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <FileTextIcon className="size-3" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span
                className="block truncate text-[12px] text-foreground/90"
                title={planTitle ?? ""}
              >
                {planTitle}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground/65">
                Proposed {formatRelativeTimeLabel(activeProposedPlan.createdAt)} · ready to
                implement
              </span>
            </span>
          </button>
          {onImplementProposedPlan || onDismissProposedPlan ? (
            <div className="mt-1.5 flex justify-end gap-1.5">
              {onDismissProposedPlan ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] text-muted-foreground/80 hover:text-destructive"
                  onClick={onDismissProposedPlan}
                >
                  Dismiss
                </Button>
              ) : null}
              {onImplementProposedPlan ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={onImplementProposedPlan}
                >
                  Implement
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function isInformativeBackgroundRunCommand(commandText: string): boolean {
  return (
    commandText.includes(" ") ||
    commandText.length > 18 ||
    commandText.includes("/") ||
    commandText.includes("\\")
  );
}

function BackgroundRunsSection({
  backgroundRuns,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
}: {
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
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

      <div className="space-y-1.5 pr-1">
        {backgroundRuns.map((run) => {
          const metaItems = backgroundRunMetaItems(run);
          const commandText = backgroundRunCommandText(run);
          const showCommandText = isInformativeBackgroundRunCommand(commandText);
          const primaryUrl = run.urls[0] ?? null;
          const extraUrlCount = Math.max(0, run.urls.length - 1);

          return (
            <div
              key={run.id}
              className={cn(
                "rounded-md bg-primary/5 px-2.5 py-2",
                run.source === "terminal" && run.terminalVisible && "ring-1 ring-primary/25",
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-readable ring-1 ring-primary/15">
                  <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="min-w-0 flex-1 truncate text-[12px] font-medium leading-snug text-foreground/90">
                      {run.label}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded-[var(--app-radius-badge)] bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-readable">
                        {run.statusLabel}
                      </span>
                      {run.terminalId ? (
                        <TooltipWrapper
                          tooltip={`${run.terminalVisible ? "Close" : "Open"} ${run.label}`}
                        >
                          <button
                            type="button"
                            className={cn(
                              "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-background/70 hover:text-foreground focus-ring",
                              run.terminalVisible && "bg-background/70 text-foreground",
                            )}
                            aria-label={`${run.terminalVisible ? "Close" : "Open"} ${run.label}`}
                            aria-pressed={run.terminalVisible}
                            onClick={() => {
                              if (run.terminalId) {
                                onToggleBackgroundRunTerminal(run.terminalId);
                              }
                            }}
                          >
                            <TerminalSquareIcon className="size-3" aria-hidden="true" />
                          </button>
                        </TooltipWrapper>
                      ) : null}
                      {run.canStop ? (
                        <TooltipWrapper tooltip={`Stop ${run.label}`}>
                          <button
                            type="button"
                            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-destructive/10 px-1.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/15 focus-ring"
                            aria-label={`Stop ${run.label}`}
                            onClick={() => {
                              onStopBackgroundRun(run);
                            }}
                          >
                            <SquareIcon className="size-2.5 fill-current" aria-hidden="true" />
                            <span>Stop</span>
                          </button>
                        </TooltipWrapper>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                    <span className="text-[10px] leading-none text-muted-foreground/55">
                      {backgroundRunSourceLabel(run)}
                    </span>
                    {metaItems.map((item) => (
                      <span
                        key={item}
                        className="inline-flex h-4 items-center gap-1 rounded-[var(--app-radius-badge)] bg-background/55 px-1.5 font-mono text-[10px] leading-none text-muted-foreground ring-1 ring-border/40"
                      >
                        {item.startsWith("Up ") ? (
                          <ClockIcon className="size-2.5" aria-hidden="true" />
                        ) : null}
                        {item}
                      </span>
                    ))}
                  </div>

                  {primaryUrl || showCommandText ? (
                    <div className="mt-1 flex min-w-0 items-center gap-1">
                      {primaryUrl ? (
                        <Button
                          render={<a href={primaryUrl} target="_blank" rel="noreferrer" />}
                          variant="ghost"
                          size="xs"
                          className="h-5 min-w-0 flex-1 justify-start gap-1 rounded-md bg-background/40 px-1.5 text-[10px] text-muted-foreground hover:bg-background/75 hover:text-foreground"
                          tooltip={primaryUrl}
                        >
                          <ExternalLinkIcon className="size-2.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{primaryUrl}</span>
                          {extraUrlCount > 0 ? (
                            <span className="shrink-0 text-muted-foreground/50">
                              +{extraUrlCount}
                            </span>
                          ) : null}
                        </Button>
                      ) : null}
                      {showCommandText ? (
                        <TooltipWrapper tooltip={commandText}>
                          <div className="min-w-0 flex-1 truncate rounded-md bg-background/30 px-1.5 py-1 font-mono text-[10px] leading-3 text-muted-foreground/60">
                            {commandText}
                          </div>
                        </TooltipWrapper>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export const ThreadActivityPopover = memo(function ThreadActivityPopover({
  taskProgress,
  backgroundRuns,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
  onViewProposedPlan,
  onImplementProposedPlan,
  onDismissProposedPlan,
}: ThreadActivityPopoverProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverLayout = useActivityPopoverAnchorLayout(popoverOpen);
  const triggerState = deriveThreadActivityTriggerState({
    taskProgress,
    backgroundRuns,
  });

  if (!triggerState) {
    return null;
  }

  return (
    <Tooltip>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  ref={popoverLayout.triggerRef}
                  className={cn(
                    "min-w-6 px-1.5 text-[11px] [-webkit-app-region:no-drag]",
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
          key={popoverLayout.layoutKey}
          align="end"
          positionerClassName="transition-none"
          side="bottom"
          sideOffset={8}
          className="max-h-[min(34rem,calc(100vh-5rem))] w-(--thread-activity-popover-width) max-w-[calc(100vw-1rem)] overflow-y-auto [&_[data-slot=popover-viewport]]:py-3 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:--spacing(3)]"
          style={popoverLayout.widthStyle}
        >
          <div className="min-w-0 space-y-2.5">
            {taskProgress ? (
              <TaskSection
                taskProgress={taskProgress}
                onViewProposedPlan={
                  onViewProposedPlan
                    ? () => {
                        setPopoverOpen(false);
                        onViewProposedPlan();
                      }
                    : undefined
                }
                onImplementProposedPlan={
                  onImplementProposedPlan
                    ? () => {
                        setPopoverOpen(false);
                        onImplementProposedPlan();
                      }
                    : undefined
                }
                onDismissProposedPlan={
                  onDismissProposedPlan
                    ? () => {
                        setPopoverOpen(false);
                        onDismissProposedPlan();
                      }
                    : undefined
                }
              />
            ) : null}
            <BackgroundRunsSection
              backgroundRuns={backgroundRuns}
              onToggleBackgroundRunTerminal={onToggleBackgroundRunTerminal}
              onStopBackgroundRun={onStopBackgroundRun}
            />
          </div>
        </PopoverPopup>
      </Popover>
    </Tooltip>
  );
});
