import {
  AppWindowIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { formatDuration } from "../../session-logic";
import {
  activityLineItems,
  partitionActivitySteps,
  summarizeRoutineSteps,
  summarizeStretch,
  type ActivityIcon,
  type ActivityStep,
  type StretchPart,
} from "./activitySteps";
import { DiffStatLabel } from "./DiffStatLabel";

/**
 * The shared shape of an agent's activity between two things it said, used by
 * the conversation and the Agents tab alike:
 *
 *   › Read 5 files and searched 4 times        ← looking around, folded
 *   ✎ Edited Watcher.ts  +31/-8                ← a line of its own
 *   ✗ 1 of 12 tests failed  21s
 *     refreshes status after a merge: …        ← the failure, no click needed
 *
 * Every line opens: the summary into its steps, a step into the exact command
 * and its output. Steps still running are not drawn here; the surface's live
 * line names them.
 */

const STEP_ICONS: Readonly<Record<ActivityIcon | "fail", (className: string) => ReactElement>> = {
  read: (className) => <EyeIcon className={className} aria-hidden="true" />,
  search: (className) => <SearchIcon className={className} aria-hidden="true" />,
  list: (className) => <FolderIcon className={className} aria-hidden="true" />,
  git: (className) => <GitBranchIcon className={className} aria-hidden="true" />,
  web: (className) => <GlobeIcon className={className} aria-hidden="true" />,
  browser: (className) => <AppWindowIcon className={className} aria-hidden="true" />,
  edit: (className) => <SquarePenIcon className={className} aria-hidden="true" />,
  check: (className) => <CheckIcon className={className} aria-hidden="true" />,
  fail: (className) => <XIcon className={className} aria-hidden="true" />,
  command: (className) => <TerminalIcon className={className} aria-hidden="true" />,
  tool: (className) => <WrenchIcon className={className} aria-hidden="true" />,
  image: (className) => <ImageIcon className={className} aria-hidden="true" />,
  agent: (className) => <BotIcon className={className} aria-hidden="true" />,
  question: (className) => <MessageCircleQuestionIcon className={className} aria-hidden="true" />,
  thinking: (className) => <LightbulbIcon className={className} aria-hidden="true" />,
  info: (className) => <InfoIcon className={className} aria-hidden="true" />,
  warning: (className) => <TriangleAlertIcon className={className} aria-hidden="true" />,
  error: (className) => <CircleAlertIcon className={className} aria-hidden="true" />,
};

/** Only long steps say how long they took; a 783ms search is noise. */
const SHOW_DURATION_FROM_MS = 10_000;
const OUTPUT_TAIL_LINES = 20;

/** A check shows its result: a tick when it passed, a cross when it failed. */
function stepIcon(step: ActivityStep, className: string): ReactElement {
  return STEP_ICONS[step.icon === "check" && step.tone === "fail" ? "fail" : step.icon](className);
}

function toneTextClass(step: ActivityStep): string {
  if (step.tone === "fail") return "text-destructive-foreground/85";
  if (step.tone === "warning") return "text-warning-foreground/85";
  return "text-foreground/70";
}

function toneIconClass(step: ActivityStep): string {
  if (step.tone === "fail") return "text-destructive-foreground/85";
  if (step.tone === "warning") return "text-warning-foreground/80";
  if (step.tone === "pass") return "text-success-foreground/75";
  return "text-muted-foreground/55";
}

function outputTail(output: string): string {
  return output.replace(/\r\n/gu, "\n").split("\n").slice(-OUTPUT_TAIL_LINES).join("\n").trimEnd();
}

function CopyTextButton({ label, text }: { label: string; text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1200 });
  return (
    <button
      type="button"
      className="text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/80"
      onClick={() => copyToClipboard(text)}
    >
      {isCopied ? "Copied" : label}
    </button>
  );
}

/** The exact call behind a step: the command or tool call, the files it
 *  touched, the tail of its output, how long it took. */
export const ActivityStepDetail = memo(function ActivityStepDetail({
  step,
}: {
  step: ActivityStep;
}) {
  const { command, call, output, exitCode, files } = step.detail;
  const tail = output ? outputTail(output) : null;
  const meta = [
    step.durationMs !== null ? formatDuration(step.durationMs) : null,
    exitCode !== undefined ? `exit ${exitCode}` : null,
  ].filter((part): part is string => part !== null);
  const hasBody = Boolean(command || call || tail || (files && files.length > 0));

  return (
    <div
      className="mt-0.5 mb-1.5 ml-[18px] min-w-0 border-l border-border pl-2.5 font-mono text-[11px] leading-4 text-muted-foreground/70"
      data-activity-detail="true"
    >
      {command ? (
        <p className="whitespace-pre-wrap break-all text-foreground/70">
          <span className="text-muted-foreground/40 select-none">$ </span>
          {command}
        </p>
      ) : null}
      {call ? <p className="whitespace-pre-wrap break-all">{call}</p> : null}
      {files && files.length > 0 ? (
        <ul className="space-y-px">
          {files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate" title={file.path}>
                {file.path}
              </span>
              {file.additions !== null && file.deletions !== null ? (
                <span className="shrink-0 text-[10px]">
                  <DiffStatLabel additions={file.additions} deletions={file.deletions} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {tail ? (
        <pre className="mt-1 max-h-40 overflow-y-auto font-[inherit] whitespace-pre-wrap wrap-break-word text-muted-foreground/55">
          {tail}
        </pre>
      ) : null}
      {!hasBody && meta.length === 0 ? (
        <p className="font-sans text-muted-foreground/50">No details recorded for this step.</p>
      ) : null}
      {meta.length > 0 || command || tail ? (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 font-sans text-[10px] text-muted-foreground/45">
          {meta.length > 0 ? <span>{meta.join(" · ")}</span> : null}
          {command ? <CopyTextButton label="Copy command" text={command} /> : null}
          {tail ? <CopyTextButton label="Copy output" text={tail} /> : null}
        </p>
      ) : null}
    </div>
  );
});

/** A step inside an opened summary: quieter than a line of its own. */
function ListedStep({
  step,
  open,
  onToggle,
}: {
  step: ActivityStep;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div data-activity-listed-step="true">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-[7px] text-left text-xs leading-5 text-muted-foreground/55 transition-colors duration-150 hover:text-muted-foreground/85"
        aria-expanded={open}
        onClick={() => onToggle(step.id)}
      >
        {stepIcon(step, "size-[11px] shrink-0 text-muted-foreground/40")}
        <span className="min-w-0 truncate">{step.label}</span>
        {step.diff ? (
          <span className="shrink-0 font-mono text-[10px]">
            <DiffStatLabel additions={step.diff.additions} deletions={step.diff.deletions} />
          </span>
        ) : null}
      </button>
      {open ? <ActivityStepDetail step={step} /> : null}
    </div>
  );
}

/** A step worth noticing, on a line of its own. */
function NotableLine({
  step,
  open,
  onToggle,
  extras,
}: {
  step: ActivityStep;
  open: boolean;
  onToggle: (id: string) => void;
  extras: ReactNode;
}) {
  const duration =
    step.durationMs !== null && step.durationMs >= SHOW_DURATION_FROM_MS
      ? formatDuration(step.durationMs)
      : null;
  return (
    <div data-activity-line="true" data-activity-tone={step.tone}>
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-center gap-[7px] text-left text-xs leading-5 transition-colors duration-150 hover:text-foreground/90",
          toneTextClass(step),
        )}
        aria-expanded={open}
        onClick={() => onToggle(step.id)}
      >
        {stepIcon(step, cn("size-3 shrink-0", toneIconClass(step)))}
        <span className="min-w-0 truncate">{step.label}</span>
        {step.diff ? (
          <span className="shrink-0 font-mono text-[11px]">
            <DiffStatLabel additions={step.diff.additions} deletions={step.diff.deletions} />
          </span>
        ) : null}
        {duration ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40 tabular-nums">
            {duration}
          </span>
        ) : null}
      </button>
      {step.note && !open ? (
        <p
          className={cn(
            "ml-[19px] truncate text-[11px] leading-4",
            step.tone === "fail"
              ? "font-mono text-destructive-foreground/70"
              : step.tone === "warning"
                ? "text-warning-foreground/70"
                : "text-muted-foreground/60",
          )}
          title={step.note}
          data-activity-note="true"
        >
          {step.note}
        </p>
      ) : null}
      {open ? <ActivityStepDetail step={step} /> : null}
      {extras ? <div className="mt-1 ml-[19px]">{extras}</div> : null}
    </div>
  );
}

function EditRunLine({
  label,
  diff,
  steps,
  open,
  onToggle,
  openStepIds,
  onToggleStep,
}: {
  label: string;
  diff: ActivityStep["diff"];
  steps: ReadonlyArray<ActivityStep>;
  open: boolean;
  onToggle: () => void;
  openStepIds: ReadonlySet<string>;
  onToggleStep: (id: string) => void;
}) {
  return (
    <div data-activity-line="true" data-activity-edit-run="true">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-[7px] text-left text-xs leading-5 text-foreground/70 transition-colors duration-150 hover:text-foreground/90"
        aria-expanded={open}
        onClick={onToggle}
      >
        <SquarePenIcon className="size-3 shrink-0 text-muted-foreground/55" aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
        {diff ? (
          <span className="shrink-0 font-mono text-[11px]">
            <DiffStatLabel additions={diff.additions} deletions={diff.deletions} />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-[19px]">
          {steps.map((step) => (
            <ListedStep
              key={step.id}
              step={step}
              open={openStepIds.has(step.id)}
              onToggle={onToggleStep}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function partToneClass(part: StretchPart): string | undefined {
  if (part.tone === "fail") return "text-destructive-foreground/85";
  if (part.tone === "warning") return "text-warning-foreground/85";
  return undefined;
}

/** A stretch the agent has moved on from, as one line: what it looked at,
 *  changed, and ran, with failures still red. */
function FoldedLine({
  parts,
  durationMs,
  open,
  onToggle,
}: {
  parts: ReadonlyArray<StretchPart>;
  durationMs: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const duration =
    durationMs !== null && durationMs >= SHOW_DURATION_FROM_MS ? formatDuration(durationMs) : null;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-[7px] text-left text-xs leading-5 text-foreground/70 transition-colors duration-150 hover:text-foreground/90"
      aria-expanded={open}
      onClick={onToggle}
      data-activity-fold-line="true"
    >
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150",
          open && "rotate-90",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        {parts.map((part, index) => (
          <Fragment key={part.id}>
            {index > 0 ? <span className="text-muted-foreground/40"> · </span> : null}
            <span className={partToneClass(part)}>{part.text}</span>
            {part.diff ? (
              <span className="ml-1.5 font-mono text-[11px]">
                <DiffStatLabel additions={part.diff.additions} deletions={part.diff.deletions} />
              </span>
            ) : null}
          </Fragment>
        ))}
      </span>
      {duration ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40 tabular-nums">
          {duration}
        </span>
      ) : null}
    </button>
  );
}

export interface ActivityGroupProps {
  /** Every step between two things the agent said, in order. Running steps
   *  are skipped: the live line names them. */
  steps: ReadonlyArray<ActivityStep>;
  /** Anything a surface hangs under a step of its own: a sign-in card, the
   *  images a step produced. */
  renderExtras?: ((step: ActivityStep) => ReactNode) | undefined;
  /** The agent has moved on from this stretch: it reads as one line that
   *  opens into the group. A group that is one line anyway stays as it is. */
  folded?: boolean | undefined;
  /** How long the stretch took, shown on its folded line. */
  durationMs?: number | null | undefined;
  className?: string | undefined;
}

export const ActivityGroup = memo(function ActivityGroup({
  steps,
  renderExtras,
  folded = false,
  durationMs = null,
  className,
}: ActivityGroupProps) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [foldOpen, setFoldOpen] = useState(false);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const { routine, notable } = useMemo(() => partitionActivitySteps(steps), [steps]);
  const summary = useMemo(
    () => (routine.length > 0 ? summarizeRoutineSteps(routine) : null),
    [routine],
  );
  const lineItems = useMemo(() => activityLineItems(notable), [notable]);
  const lineCount = (summary !== null ? 1 : 0) + lineItems.length;
  const stretch = useMemo(
    () => (folded && lineCount > 1 ? summarizeStretch(steps) : null),
    [folded, lineCount, steps],
  );

  const toggle = useCallback((id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (summary === null && lineItems.length === 0) {
    return null;
  }

  // A summary standing for a single step opens straight into that step.
  const lone = routine.length === 1 ? routine[0]! : null;
  const summaryExpanded = lone ? openIds.has(lone.id) : summaryOpen;

  const lines = (
    <>
      {summary !== null ? (
        <div data-activity-summary="true">
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-[7px] text-left text-xs leading-5 text-muted-foreground/60 transition-colors duration-150 hover:text-muted-foreground/85"
            aria-expanded={summaryExpanded}
            onClick={() => (lone ? toggle(lone.id) : setSummaryOpen((value) => !value))}
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150",
                summaryExpanded && "rotate-90",
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{summary}</span>
          </button>
          {lone && summaryExpanded ? <ActivityStepDetail step={lone} /> : null}
          {!lone && summaryOpen ? (
            <div className="ml-[19px]" data-activity-steps="true">
              {routine.map((step) => (
                <ListedStep
                  key={step.id}
                  step={step}
                  open={openIds.has(step.id)}
                  onToggle={toggle}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {lineItems.map((item) =>
        item.kind === "step" ? (
          <NotableLine
            key={item.step.id}
            step={item.step}
            open={openIds.has(item.step.id)}
            onToggle={toggle}
            extras={renderExtras?.(item.step) ?? null}
          />
        ) : (
          <EditRunLine
            key={item.id}
            label={item.label}
            diff={item.diff}
            steps={item.steps}
            open={openIds.has(item.id)}
            onToggle={() => toggle(item.id)}
            openStepIds={openIds}
            onToggleStep={toggle}
          />
        ),
      )}
    </>
  );

  if (stretch !== null) {
    return (
      <div
        className={cn("min-w-0", className)}
        data-activity-group="true"
        data-activity-folded="true"
      >
        <FoldedLine
          parts={stretch}
          durationMs={durationMs}
          open={foldOpen}
          onToggle={() => setFoldOpen((value) => !value)}
        />
        {foldOpen ? <div className="ml-[19px]">{lines}</div> : null}
      </div>
    );
  }
  return (
    <div className={cn("min-w-0", className)} data-activity-group="true">
      {lines}
    </div>
  );
});
