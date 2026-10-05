import type { ScopedThreadRef } from "@threadlines/contracts";
import { memo, useMemo, useState, type ReactElement } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CpuIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  RadioIcon,
  SquareIcon,
  TerminalIcon,
  TerminalSquareIcon,
} from "lucide-react";

import type { PlanTaskBadgeState } from "../../planPanelState";
import { proposedPlanTitle } from "../../proposedPlan";
import {
  formatRelativeTimeLabel,
  formatSpanDurationLabel,
  formatWorkingDurationLabel,
} from "../../timestampFormat";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import {
  type ActivePlanState,
  type ActivePlanStep,
  type ActivePlanStepStatus,
  type LatestProposedPlanState,
} from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LiveNode } from "../ui/threadline";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "../ui/tooltip";
import { presentTense } from "./activityWording";
import type { CurrentWorkLine } from "./activitySteps";
import { activityStepIcon } from "./activityStepIcon";
import { useBackgroundRunOutputLine } from "./backgroundRunOutput";
import {
  backgroundRunAge,
  backgroundRunDetailLine,
  backgroundRunKind,
  backgroundRunLink,
  backgroundRunTooltip,
  type BackgroundRunKind,
  type ThreadBackgroundRunItem,
} from "./threadActivity";

export interface ThreadTaskProgressState {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  badge: PlanTaskBadgeState | null;
  label: string;
  /** True while the turn that wrote the plan is still running: its clocks
   *  tick and its current step carries the live node. */
  live: boolean;
  /** What the agent is on right now, shown under the current step while the
   *  plan is live. */
  currentWork: CurrentWorkLine | null;
}

interface ThreadActivityPopoverProps {
  taskProgress: ThreadTaskProgressState | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** The thread the runs belong to; where their output is read from. */
  threadRef: ScopedThreadRef | null;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onViewProposedPlan?: (() => void) | undefined;
  onImplementProposedPlan?: (() => void) | undefined;
  onDismissProposedPlan?: (() => void) | undefined;
}

type ActivityTone = PlanTaskBadgeState["tone"];
type PlanStepLike = Pick<ActivePlanStep, "step" | "status">;

/** The task half of the top-bar button: the plan's progress, or a plan
 *  waiting to be built. */
interface TaskTriggerPart {
  /** Present when there are steps to draw as progress blocks. */
  steps: ReadonlyArray<PlanStepLike> | null;
  label: string;
  ariaLabel: string;
  tone: ActivityTone;
}

interface ActivityTriggerState {
  tasks: TaskTriggerPart | null;
  runCount: number;
  ariaLabel: string;
  tooltipText: string;
  summary: string;
}

/** The closest the panel comes to a screen edge: the header's own side
 *  padding on phones, so the panel lines up with what sits above it. */
const ACTIVITY_POPOVER_EDGE_GUTTER_PX = 12;
/** Slide along the button to stay on screen rather than flip to its other
 *  edge, which on a phone left a narrow panel hanging off one side. */
const ACTIVITY_POPOVER_COLLISION_AVOIDANCE = { align: "shift" } as const;
/**
 * The panel's width is CSS, not measured: on a phone it spans the screen
 * between the gutters, otherwise about a third of the window (20rem to
 * 30rem). The width then changes in the same layout the positioner reads, so
 * the open panel stays put against its button while the window resizes,
 * with no remount (which would replay its entrance and close any steps the
 * reader unfolded).
 */
const ACTIVITY_POPOVER_WIDTH_CLASS_NAME =
  "w-[clamp(20rem,36vw,30rem)] max-w-[calc(100vw-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]";

/** Plans up to this long draw one block per step on the top-bar button;
 *  longer ones draw a single bar. */
const TRIGGER_BLOCK_LIMIT = 10;
/** The same limit for the bar across the top of the panel. */
const PANEL_BLOCK_LIMIT = 16;
/** Plans at least this long fold their finished opening steps into one line. */
const FOLD_DONE_FROM_STEPS = 7;

function toneTextClassName(tone: ActivityTone): string {
  if (tone === "active") return "text-primary-readable";
  if (tone === "complete") return "text-success-foreground";
  if (tone === "ready") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Progress blocks
// ---------------------------------------------------------------------------

function progressBlockClassName(status: ActivePlanStepStatus, allDone: boolean): string {
  if (allDone) return "bg-success";
  if (status === "completed") return "bg-foreground/55";
  if (status === "inProgress") return "bg-primary-graph";
  return "bg-foreground/15";
}

/**
 * The plan's progress at a glance: one block per step, filled in as steps
 * finish, the step in hand in the accent colour, all green once everything
 * is done. A plan too long for blocks draws one bar split the same way.
 */
function PlanProgressBlocks({
  steps,
  variant,
}: {
  steps: ReadonlyArray<PlanStepLike>;
  variant: "trigger" | "panel";
}) {
  const allDone = steps.every((step) => step.status === "completed");
  const blockLimit = variant === "trigger" ? TRIGGER_BLOCK_LIMIT : PANEL_BLOCK_LIMIT;
  if (steps.length <= blockLimit) {
    return (
      <span
        aria-hidden="true"
        data-plan-progress={variant}
        className={cn("flex", variant === "trigger" ? "items-center gap-[1.5px]" : "gap-0.5")}
      >
        {keyedPlanSteps(steps).map(({ key, step }) => (
          <span
            key={key}
            className={cn(
              variant === "trigger" ? "h-1 w-[5px] rounded-[1px]" : "h-[3px] flex-1 rounded-full",
              progressBlockClassName(step.status, allDone),
            )}
          />
        ))}
      </span>
    );
  }

  const doneCount = steps.filter((step) => step.status === "completed").length;
  const currentCount = steps.filter((step) => step.status === "inProgress").length;
  return (
    <span
      aria-hidden="true"
      data-plan-progress={variant}
      className={cn(
        "flex overflow-hidden rounded-full bg-foreground/15",
        variant === "trigger" ? "h-1 w-[34px]" : "h-[3px] w-full",
      )}
    >
      <span
        className={allDone ? "bg-success" : "bg-foreground/55"}
        style={{ flex: `${doneCount} 1 0` }}
      />
      <span className="bg-primary-graph" style={{ flex: `${currentCount} 1 0` }} />
      <span style={{ flex: `${steps.length - doneCount - currentCount} 1 0` }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

function taskSummary(activePlan: ActivePlanState | null, activeProposedPlan: boolean): string {
  if (!activePlan) {
    return activeProposedPlan ? "Plan ready to implement" : "No current tasks";
  }

  const total = activePlan.steps.length;
  const completedCount = activePlan.steps.filter((step) => step.status === "completed").length;
  const activeStep = activePlan.steps.find((step) => step.status === "inProgress");

  if (activeStep) {
    return presentTense(activeStep.step);
  }

  if (completedCount === total) {
    return "All steps complete";
  }

  return `${completedCount} of ${total} complete`;
}

export function deriveThreadActivityTriggerState(input: {
  taskProgress: ThreadTaskProgressState | null;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
}): ActivityTriggerState | null {
  const { taskProgress, backgroundRuns } = input;
  const runCount = backgroundRuns.length;
  const taskSummaryText = taskProgress
    ? taskSummary(taskProgress.activePlan, taskProgress.activeProposedPlan !== null)
    : null;
  const runSummaryText =
    runCount > 0 ? formatCount(runCount, "background run", "background runs") : null;
  const summaryParts = [taskSummaryText, runSummaryText].filter((part): part is string =>
    Boolean(part),
  );

  if (summaryParts.length === 0) {
    return null;
  }

  const badge = taskProgress?.badge ?? null;
  const tasks: TaskTriggerPart | null = badge
    ? {
        steps: taskProgress?.activePlan?.steps ?? null,
        label: badge.label,
        ariaLabel: badge.ariaLabel,
        tone: badge.tone,
      }
    : null;
  const summary = summaryParts.join(" / ");
  const ariaLabel =
    taskProgress !== null && runCount > 0
      ? "Thread activity"
      : (tasks?.ariaLabel ?? runSummaryText ?? "Thread activity");

  return {
    tasks,
    runCount,
    ariaLabel,
    tooltipText: `Activity: ${summary}. Click to view details.`,
    summary,
  };
}

/**
 * The counts on the button ("3/6", "2"). The text box is trimmed to the
 * digits' own height (cap height to baseline), so centering it against an
 * icon centers the glyphs rather than the font's line box, which sat bare
 * digits like "1" a hair above the icon beside them.
 */
const TRIGGER_COUNT_CLASS_NAME =
  "font-mono text-[10.5px] font-semibold leading-none tabular-nums [text-box:trim-both_cap_alphabetic]";

function TriggerContent({ state }: { state: ActivityTriggerState }) {
  const { tasks, runCount } = state;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {tasks ? (
        <span className="flex items-center gap-1" data-activity-trigger-part="tasks">
          {tasks.steps && tasks.steps.length > 0 ? (
            <PlanProgressBlocks steps={tasks.steps} variant="trigger" />
          ) : tasks.tone === "ready" ? (
            <FileTextIcon className={cn("size-3", toneTextClassName("ready"))} aria-hidden="true" />
          ) : (
            <ListTodoIcon className="size-3" aria-hidden="true" />
          )}
          <span className={cn(TRIGGER_COUNT_CLASS_NAME, toneTextClassName(tasks.tone))}>
            {tasks.label}
          </span>
        </span>
      ) : null}
      {tasks && runCount > 0 ? <span aria-hidden="true" className="h-3 w-px bg-border" /> : null}
      {runCount > 0 ? (
        <span className="flex items-center gap-1" data-activity-trigger-part="runs">
          <RadioIcon className="size-3" aria-hidden="true" />
          <span className={TRIGGER_COUNT_CLASS_NAME}>{runCount}</span>
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Spoken status for each step; the glyph carries it visually. */
function taskStatusLabel(status: ActivePlanStepStatus): string {
  if (status === "completed") return "Done";
  if (status === "inProgress") return "Now";
  return "Next";
}

function keyedPlanSteps<Step extends PlanStepLike>(steps: ReadonlyArray<Step>) {
  const seenKeys = new Map<string, number>();
  return steps.map((step) => {
    const count = seenKeys.get(step.step) ?? 0;
    seenKeys.set(step.step, count + 1);
    return { key: count === 0 ? step.step : `${step.step}:${count}`, step };
  });
}

function spanMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) && span >= 1_000 ? span : null;
}

function latestCompletion(steps: ReadonlyArray<ActivePlanStep>): string | null {
  let latest: string | null = null;
  for (const step of steps) {
    if (step.completedAt && (!latest || Date.parse(step.completedAt) > Date.parse(latest))) {
      latest = step.completedAt;
    }
  }
  return latest;
}

/**
 * How many finished steps at the head of the plan fold into one line. Long
 * plans fold them so what's left stays in view; a finished plan folds whole
 * once it is more than a few steps.
 */
export function foldedDoneStepCount(steps: ReadonlyArray<Pick<ActivePlanStep, "status">>): number {
  const firstOpen = steps.findIndex((step) => step.status !== "completed");
  const doneHead = firstOpen < 0 ? steps.length : firstOpen;
  if (doneHead < 2) return 0;
  const allDone = firstOpen < 0;
  return steps.length >= FOLD_DONE_FROM_STEPS || (allDone && steps.length > 3) ? doneHead : 0;
}

/** A clock for a span still running. Its own component, so the per-second
 *  tick re-renders only the label. */
function LiveDuration({ since, format }: { since: string; format: "working" | "span" }) {
  const nowMs = useRelativeTimeTick(1_000);
  return (
    <>
      {format === "working"
        ? formatWorkingDurationLabel(since, nowMs)
        : formatSpanDurationLabel(nowMs - Date.parse(since))}
    </>
  );
}

function PlanMeta({ plan, live }: { plan: ActivePlanState; live: boolean }) {
  const total = plan.steps.length;
  const doneCount = plan.steps.filter((step) => step.status === "completed").length;
  const started = doneCount > 0 || plan.steps.some((step) => step.status === "inProgress");
  const allDone = doneCount === total;
  const finishedSpan = spanMs(plan.startedAt, allDone ? latestCompletion(plan.steps) : null);
  // A plan still open whose turn ended (stopped, interrupted) has no honest
  // total: its last update says nothing about when the work stopped.
  const elapsed =
    live && !allDone ? (
      <LiveDuration since={plan.startedAt} format="span" />
    ) : finishedSpan !== null ? (
      formatSpanDurationLabel(finishedSpan)
    ) : null;
  const count = allDone
    ? `All ${total} done`
    : started
      ? `${doneCount} of ${total} done`
      : formatCount(total, "step", "steps");

  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10.5px] text-muted-foreground",
        allDone && "text-success-foreground",
      )}
      data-plan-meta="true"
    >
      {count}
      {elapsed !== null ? <> · {elapsed}</> : null}
    </span>
  );
}

function StepGlyph({ status, live }: { status: ActivePlanStepStatus; live: boolean }) {
  if (status === "completed") {
    return (
      <CheckIcon className="size-[11px] stroke-[2.5] text-muted-foreground" aria-hidden="true" />
    );
  }
  if (status === "inProgress") {
    return live ? (
      <LiveNode className="size-[7px]" />
    ) : (
      <span aria-hidden="true" className="size-[7px] rounded-full bg-primary-graph/70" />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="size-[7px] rounded-full border border-muted-foreground/40"
    />
  );
}

/** One step of the plan: a glyph for where it stands, its words, and how long
 *  it took (or, for the one in hand, how long it has been going). */
function PlanStepRow({
  step,
  live,
  currentWork,
}: {
  step: ActivePlanStep;
  live: boolean;
  currentWork: CurrentWorkLine | null;
}) {
  const isNow = step.status === "inProgress";
  const doneSpan = step.status === "completed" ? spanMs(step.startedAt, step.completedAt) : null;
  return (
    <div
      className={cn(
        "grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md p-1",
        isNow && "bg-accent/50",
      )}
      data-plan-step-status={step.status}
    >
      <span className="flex h-4 items-center justify-center">
        <StepGlyph status={step.status} live={live} />
      </span>
      <span
        className={cn(
          "min-w-0 text-[12px] leading-4 break-words",
          step.status === "completed" && "text-muted-foreground/80",
          isNow && "font-medium text-foreground",
          step.status === "pending" && "text-foreground/80",
        )}
      >
        <span className="sr-only">{taskStatusLabel(step.status)}: </span>
        {/* The task in hand reads as happening now. */}
        {isNow ? presentTense(step.step) : step.step}
        {isNow && live && currentWork ? (
          <span
            className={cn(
              "mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-muted-foreground",
              !currentWork.running && "text-muted-foreground/70",
            )}
            data-plan-current-work="true"
          >
            {activityStepIcon(currentWork, "size-2.5 shrink-0")}
            <span className="truncate">{currentWork.label}</span>
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "font-mono text-[10.5px] leading-4 text-muted-foreground/55",
          isNow && "text-primary-readable",
        )}
      >
        {isNow && live && step.startedAt ? (
          <LiveDuration since={step.startedAt} format="working" />
        ) : doneSpan !== null ? (
          formatSpanDurationLabel(doneSpan)
        ) : null}
      </span>
    </div>
  );
}

function PlanSteps({
  plan,
  live,
  currentWork,
}: {
  plan: ActivePlanState;
  live: boolean;
  currentWork: CurrentWorkLine | null;
}) {
  const [foldOpen, setFoldOpen] = useState(false);
  const rows = useMemo(() => keyedPlanSteps(plan.steps), [plan.steps]);
  const foldCount = foldedDoneStepCount(plan.steps);
  const allDone = plan.steps.every((step) => step.status === "completed");
  // A finished plan's header already carries its total.
  const foldSpan =
    foldCount > 0 && !allDone
      ? spanMs(plan.startedAt, latestCompletion(plan.steps.slice(0, foldCount)))
      : null;
  const renderRow = ({ key, step }: (typeof rows)[number]) => (
    <PlanStepRow key={key} step={step} live={live} currentWork={currentWork} />
  );

  return (
    <div className="min-w-0">
      {foldCount > 0 ? (
        <button
          type="button"
          className="grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md p-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-ring"
          aria-expanded={foldOpen}
          onClick={() => setFoldOpen((value) => !value)}
          data-plan-fold="true"
        >
          <span className="flex h-4 items-center justify-center">
            <CheckIcon
              className={cn(
                "size-[11px] stroke-[2.5]",
                allDone ? "text-success-foreground" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[12px] leading-4">
            {formatCount(foldCount, "step done", "steps done")}
            <ChevronDownIcon
              className={cn("size-3 opacity-70 transition-transform", foldOpen && "rotate-180")}
              aria-hidden="true"
            />
          </span>
          <span className="font-mono text-[10.5px] leading-4 text-muted-foreground/55">
            {foldSpan !== null ? formatSpanDurationLabel(foldSpan) : null}
          </span>
        </button>
      ) : null}
      {(foldOpen ? rows : rows.slice(foldCount)).map(renderRow)}
    </div>
  );
}

function ProposedPlanSummary({
  plan,
  onView,
  onImplement,
  onDismiss,
}: {
  plan: LatestProposedPlanState;
  onView?: (() => void) | undefined;
  onImplement?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const title = proposedPlanTitle(plan.planMarkdown) ?? "Plan ready";
  return (
    <div className="min-w-0">
      <button
        type="button"
        className={cn(
          "grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 rounded-md p-1 text-left",
          onView && "cursor-pointer transition-colors hover:bg-accent/50 focus-ring",
        )}
        disabled={!onView}
        aria-label="View plan in conversation"
        onClick={onView}
      >
        <span className="flex h-4 items-center justify-center">
          <FileTextIcon className={cn("size-3", toneTextClassName("ready"))} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12px] leading-4 text-foreground/90" title={title}>
            {title}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
            Ready to implement
          </span>
        </span>
      </button>
      {onImplement || onDismiss ? (
        <div className="mt-1.5 flex justify-end gap-1.5 px-1">
          {onDismiss ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-muted-foreground/80 hover:text-destructive"
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          ) : null}
          {onImplement ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={onImplement}
            >
              Implement
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SectionHeader({ title, meta }: { title: string; meta: ReactElement | null }) {
  return (
    <div className="mb-1.5 flex min-w-0 items-baseline justify-between gap-3 px-1">
      <span className="truncate text-xs font-semibold text-foreground">{title}</span>
      {meta}
    </div>
  );
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
  const { activePlan, activeProposedPlan, live, currentWork } = taskProgress;

  if (activePlan && activePlan.steps.length > 0) {
    return (
      <section className="min-w-0" aria-label={taskProgress.label}>
        <SectionHeader
          title={taskProgress.label}
          meta={<PlanMeta plan={activePlan} live={live} />}
        />
        <div className="mb-1.5 px-1">
          <PlanProgressBlocks steps={activePlan.steps} variant="panel" />
        </div>
        <PlanSteps plan={activePlan} live={live} currentWork={currentWork} />
      </section>
    );
  }

  if (activeProposedPlan) {
    return (
      <section className="min-w-0" aria-label="Plan ready">
        <SectionHeader
          title="Plan ready"
          meta={
            <span className={cn("shrink-0 font-mono text-[10.5px]", toneTextClassName("ready"))}>
              {formatRelativeTimeLabel(activeProposedPlan.createdAt)}
            </span>
          }
        />
        <ProposedPlanSummary
          plan={activeProposedPlan}
          onView={onViewProposedPlan}
          onImplement={onImplementProposedPlan}
          onDismiss={onDismissProposedPlan}
        />
      </section>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Background runs
// ---------------------------------------------------------------------------

const RUN_KIND_ICONS: Readonly<Record<BackgroundRunKind, (className: string) => ReactElement>> = {
  preview: (className) => <GlobeIcon className={className} aria-hidden="true" />,
  terminal: (className) => <TerminalIcon className={className} aria-hidden="true" />,
  command: (className) => <TerminalIcon className={className} aria-hidden="true" />,
  task: (className) => <BotIcon className={className} aria-hidden="true" />,
  process: (className) => <CpuIcon className={className} aria-hidden="true" />,
};

/** The open-terminal action shows while its run is hovered or focused, and
 *  always on touch screens, where there is no hover. Stop always shows: it is
 *  the action a reader comes to the list for, and should never need finding. */
const RUN_ACTION_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity group-hover/run:opacity-100 group-focus-within/run:opacity-100 pointer-coarse:opacity-100";

function BackgroundRunRow({
  run,
  threadRef,
  onToggleTerminal,
  onStop,
}: {
  run: ThreadBackgroundRunItem;
  threadRef: ScopedThreadRef | null;
  onToggleTerminal: (terminalId: string) => void;
  onStop: (run: ThreadBackgroundRunItem) => void;
}) {
  const outputLine = useBackgroundRunOutputLine(run, threadRef);
  const kind = backgroundRunKind(run);
  const link = backgroundRunLink(run);
  const detailLine = backgroundRunDetailLine({ ...run, outputLine });
  const age = backgroundRunAge(run);
  const terminalId = run.terminalId;
  const terminalActionLabel = `${run.terminalVisible ? "Close" : "Open"} ${run.label}`;

  return (
    <div
      className="group/run grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 px-1 py-1.5 transition-colors hover:bg-accent/40"
      data-background-run-kind={kind}
    >
      <span className="flex h-4 items-center justify-center text-muted-foreground">
        {RUN_KIND_ICONS[kind]("size-3")}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2 leading-4">
          <TooltipWrapper tooltip={backgroundRunTooltip(run)}>
            <span
              className={cn(
                "min-w-0 truncate text-[12px]",
                run.described === false ? "text-foreground/80" : "font-medium text-foreground",
              )}
            >
              {run.label}
            </span>
          </TooltipWrapper>
          {link ? (
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-primary-readable hover:underline focus-ring"
              title={link.href}
            >
              {link.label}
              <ExternalLinkIcon className="size-2.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        {detailLine ? (
          <div
            className={cn(
              "mt-0.5 truncate text-[10.5px] leading-[15px] text-muted-foreground/75",
              detailLine.kind === "prose" ? "text-[11px]" : "font-mono",
            )}
            title={detailLine.text}
            data-background-run-detail={detailLine.kind}
          >
            {detailLine.text}
          </div>
        ) : null}
      </div>
      <div className="-my-0.5 flex h-5 items-center gap-0.5">
        {age ? (
          <span className="mr-0.5 font-mono text-[10.5px] text-muted-foreground/55">
            {age.live ? <LiveDuration since={age.since} format="span" /> : age.label}
          </span>
        ) : null}
        {terminalId ? (
          <TooltipWrapper tooltip={terminalActionLabel}>
            <button
              type="button"
              className={cn(
                "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring",
                run.terminalVisible ? "bg-muted text-foreground" : RUN_ACTION_REVEAL_CLASS_NAME,
              )}
              aria-label={terminalActionLabel}
              aria-pressed={run.terminalVisible}
              onClick={() => onToggleTerminal(terminalId)}
            >
              <TerminalSquareIcon className="size-3" aria-hidden="true" />
            </button>
          </TooltipWrapper>
        ) : null}
        {run.canStop ? (
          <TooltipWrapper tooltip={`Stop ${run.label}`}>
            <button
              type="button"
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 focus-ring"
              aria-label={`Stop ${run.label}`}
              onClick={() => onStop(run)}
            >
              <SquareIcon className="size-2 fill-current" aria-hidden="true" />
            </button>
          </TooltipWrapper>
        ) : null}
      </div>
    </div>
  );
}

function BackgroundRunsSection({
  backgroundRuns,
  threadRef,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
}: {
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  threadRef: ScopedThreadRef | null;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
}) {
  if (backgroundRuns.length === 0) {
    return null;
  }

  return (
    <section className="min-w-0" aria-label="Running in the background">
      <SectionHeader
        title="Running in the background"
        meta={
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {backgroundRuns.length}
          </span>
        }
      />
      <div className="divide-y divide-border/60">
        {backgroundRuns.map((run) => (
          <BackgroundRunRow
            key={run.id}
            run={run}
            threadRef={threadRef}
            onToggleTerminal={onToggleBackgroundRunTerminal}
            onStop={onStopBackgroundRun}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

function keyboardOpensIntoPopup(openType: string): boolean {
  return openType === "keyboard";
}

export const ThreadActivityPopover = memo(function ThreadActivityPopover({
  taskProgress,
  backgroundRuns,
  threadRef,
  onToggleBackgroundRunTerminal,
  onStopBackgroundRun,
  onViewProposedPlan,
  onImplementProposedPlan,
  onDismissProposedPlan,
}: ThreadActivityPopoverProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const triggerState = deriveThreadActivityTriggerState({
    taskProgress,
    backgroundRuns,
  });

  if (!triggerState) {
    return null;
  }

  const closeThen = (action: (() => void) | undefined) =>
    action
      ? () => {
          setPopoverOpen(false);
          action();
        }
      : undefined;
  const showsTasks =
    taskProgress !== null &&
    ((taskProgress.activePlan?.steps.length ?? 0) > 0 || taskProgress.activeProposedPlan !== null);

  return (
    <Tooltip>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="min-w-6 px-1.5 text-[11px] [-webkit-app-region:no-drag]"
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
          collisionAvoidance={ACTIVITY_POPOVER_COLLISION_AVOIDANCE}
          collisionPadding={ACTIVITY_POPOVER_EDGE_GUTTER_PX}
          // The positioner sizes to the panel. Its default size is the panel's
          // as measured once on open, which a later width change outgrew, and
          // the panel then slid off its button.
          positionerClassName="h-auto w-auto transition-none"
          side="bottom"
          sideOffset={8}
          // Keyboard users land on the first control; a click leaves focus on
          // the button, so no row opens already showing its actions.
          initialFocus={keyboardOpensIntoPopup}
          className={cn(
            "max-h-[min(34rem,var(--available-height))] overflow-y-auto [&_[data-slot=popover-viewport]]:py-3 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:--spacing(2)]",
            ACTIVITY_POPOVER_WIDTH_CLASS_NAME,
          )}
        >
          <div className="min-w-0">
            {taskProgress && showsTasks ? (
              <TaskSection
                taskProgress={taskProgress}
                onViewProposedPlan={closeThen(onViewProposedPlan)}
                onImplementProposedPlan={closeThen(onImplementProposedPlan)}
                onDismissProposedPlan={closeThen(onDismissProposedPlan)}
              />
            ) : null}
            {showsTasks && backgroundRuns.length > 0 ? (
              <div aria-hidden="true" className="mx-1 my-2.5 h-px bg-border/60" />
            ) : null}
            <BackgroundRunsSection
              backgroundRuns={backgroundRuns}
              threadRef={threadRef}
              onToggleBackgroundRunTerminal={onToggleBackgroundRunTerminal}
              onStopBackgroundRun={onStopBackgroundRun}
            />
          </div>
        </PopoverPopup>
      </Popover>
    </Tooltip>
  );
});
