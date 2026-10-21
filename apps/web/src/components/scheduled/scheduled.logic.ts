/**
 * The Scheduled page's pure parts (docs/design/fleet.md, Part 6): its search
 * params, how runs and times read, and the task form's state, checks and the
 * draft it saves.
 */
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ScheduledRunStatus,
  ScheduledRunTrigger,
  ScheduledTask,
  ScheduledTaskCadence,
  ScheduledTaskCheckout,
  ScheduledTaskClock,
  ScheduledTaskDraft,
  ScheduledTaskId,
  ThreadId,
} from "@threadlines/contracts";
import {
  cadenceSaveRefusal,
  describeCadence,
  upcomingSlots,
} from "@threadlines/shared/scheduledTasks";
import * as Result from "effect/Result";

// ---------------------------------------------------------------------------
// Where the page is
// ---------------------------------------------------------------------------

export type ScheduledView = "new" | "edit";

export interface ScheduledSearch {
  /** The computer whose task is open. */
  readonly environment?: string;
  readonly task?: string;
  /** The form: a new task, or the open task being edited. */
  readonly view?: ScheduledView;
}

export function parseScheduledSearch(search: Record<string, unknown>): ScheduledSearch {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const environment = text(search.environment);
  const task = text(search.task);
  const view = search.view === "new" || search.view === "edit" ? search.view : undefined;
  return {
    ...(environment !== undefined && task !== undefined ? { environment, task } : {}),
    ...(view !== undefined ? { view } : {}),
  };
}

/** A task, with the computer it lives on. */
export interface ScheduledTaskRef {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId;
}

// ---------------------------------------------------------------------------
// How runs and times read
// ---------------------------------------------------------------------------

export const RUN_STATUS_LABELS: Record<ScheduledRunStatus, string> = {
  launching: "Starting",
  queued: "Waiting in its thread",
  started: "Working",
  finished: "Finished",
  nothing_to_report: "Nothing to report",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
};

/** The dot beside a run: blue while it works, red when it failed, amber when cut off. */
export const RUN_STATUS_DOT_CLASSES: Record<ScheduledRunStatus, string> = {
  launching: "bg-primary-graph",
  queued: "bg-primary-graph",
  started: "bg-primary-graph",
  finished: "bg-success",
  nothing_to_report: "bg-muted-foreground/60",
  failed: "bg-destructive",
  interrupted: "bg-warning",
  skipped: "bg-muted-foreground/40",
};

export const RUN_TRIGGER_LABELS: Record<ScheduledRunTrigger, string | null> = {
  schedule: null,
  catch_up: "Catch-up",
  manual: "Run now",
};

export const isWorkingRunStatus = (status: ScheduledRunStatus) =>
  status === "launching" || status === "queued" || status === "started";

/** What a task's row says about its runs: "Working" while one works, else how the last one ended. */
export function taskRunStatus(
  task: Pick<ScheduledTask, "workingRuns" | "lastRun">,
): ScheduledRunStatus | null {
  if (task.workingRuns > 0) return "started";
  return task.lastRun?.status ?? null;
}

/** The viewer's own zone. */
export const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A wall time in the viewer's locale ("9:00", "9:00 AM"). */
export function formatClock(clock: ScheduledTaskClock): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, clock.hour, clock.minute));
}

/**
 * A task's schedule in a few words, naming its zone when it isn't the
 * viewer's ("Weekdays at 9:00 · Europe/Madrid").
 */
export function describeTaskSchedule(
  task: Pick<ScheduledTask, "cadence" | "timeZone">,
  viewerZone: string = viewerTimeZone(),
): string {
  const words = describeCadence(task.cadence, formatClock);
  return task.cadence.kind === "manual" || task.timeZone === viewerZone
    ? words
    : `${words} · ${task.timeZone}`;
}

const dayKey = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

/**
 * When something happens or happened, in the viewer's zone: "Today at
 * 9:00", "Tomorrow at 9:00", "Yesterday at 9:00", "Mon at 9:00" within a
 * week, else "Oct 30 at 9:00".
 */
export function formatWhen(iso: string, nowMs: number, timeZone: string = viewerTimeZone()) {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(at);
  const day = dayKey(at, timeZone);
  const now = new Date(nowMs);
  const dayMs = 24 * 60 * 60_000;
  if (day === dayKey(now, timeZone)) return `Today at ${time}`;
  if (day === dayKey(new Date(nowMs + dayMs), timeZone)) return `Tomorrow at ${time}`;
  if (day === dayKey(new Date(nowMs - dayMs), timeZone)) return `Yesterday at ${time}`;
  if (Math.abs(at.getTime() - nowMs) < 6 * dayMs) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone }).format(at);
    return `${weekday} at ${time}`;
  }
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(at);
  return `${date} at ${time}`;
}

/** The line a task's row shows about when it runs next. */
export function describeNextRun(task: ScheduledTask, nowMs: number, timeZone?: string): string {
  if (task.status === "paused") return "Paused";
  if (task.status === "error") return "Stopped";
  if (task.cadence.kind === "manual") return "Runs when you start it";
  if (task.nextRunAt === null) return "No next run";
  const when = formatWhen(task.nextRunAt, nowMs, timeZone);
  // "Today at 9:00" reads as "Next run today at 9:00"; a weekday or a date keeps its capital.
  return `Next run ${/^(Today|Tomorrow|Yesterday) /u.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : when}`;
}

// ---------------------------------------------------------------------------
// The task form
// ---------------------------------------------------------------------------

export type CadenceKind = ScheduledTaskCadence["kind"];

export const CADENCE_KIND_LABELS: Record<CadenceKind, string> = {
  manual: "Manual",
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  custom: "Custom",
};

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Everything the form edits; the cadence's parts are kept apart so switching kinds keeps them. */
export interface ScheduledTaskForm {
  readonly name: string;
  readonly prompt: string;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly checkout: ScheduledTaskCheckout;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly cadenceKind: CadenceKind;
  readonly time: ScheduledTaskClock;
  readonly minute: number;
  readonly weekday: number;
  readonly cron: string;
  readonly timeZone: string;
  readonly target: "new_thread" | "thread";
  readonly threadId: ThreadId | null;
}

export function emptyTaskForm(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly timeZone: string;
}): ScheduledTaskForm {
  return {
    name: "",
    prompt: "",
    environmentId: input.environmentId,
    projectId: input.projectId,
    checkout: "local",
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    cadenceKind: "weekdays",
    time: { hour: 9, minute: 0 },
    minute: 0,
    weekday: 1,
    cron: "0 9 * * 1-5",
    timeZone: input.timeZone,
    target: "new_thread",
    threadId: null,
  };
}

/** The form opened on an existing task. */
export function taskForm(task: ScheduledTask, environmentId: EnvironmentId): ScheduledTaskForm {
  const cadence = task.cadence;
  const base = emptyTaskForm({
    environmentId,
    projectId: task.projectId,
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    timeZone: task.timeZone,
  });
  return {
    ...base,
    name: task.name,
    prompt: task.prompt,
    checkout: task.checkout,
    cadenceKind: cadence.kind,
    ...(cadence.kind === "daily" || cadence.kind === "weekdays" || cadence.kind === "weekly"
      ? { time: cadence.time }
      : {}),
    ...(cadence.kind === "hourly" ? { minute: cadence.minute } : {}),
    ...(cadence.kind === "weekly" ? { weekday: cadence.weekday } : {}),
    ...(cadence.kind === "custom" ? { cron: cadence.cron } : {}),
    target: task.target.kind,
    threadId: task.target.kind === "thread" ? task.target.threadId : null,
  };
}

export function formCadence(form: ScheduledTaskForm): ScheduledTaskCadence {
  switch (form.cadenceKind) {
    case "manual":
      return { kind: "manual" };
    case "hourly":
      return { kind: "hourly", minute: form.minute };
    case "daily":
      return { kind: "daily", time: form.time };
    case "weekdays":
      return { kind: "weekdays", time: form.time };
    case "weekly":
      return { kind: "weekly", weekday: form.weekday, time: form.time };
    case "custom":
      return { kind: "custom", cron: form.cron.trim() };
  }
}

/** "09:30" for an `<input type="time">`. */
export const clockInputValue = (clock: ScheduledTaskClock) =>
  `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;

export function parseClockInput(value: string): ScheduledTaskClock | null {
  const match = /^(\d{1,2}):(\d{2})/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export type FormProblems = Partial<
  Record<"name" | "prompt" | "computer" | "project" | "agent" | "schedule" | "thread", string>
>;

/** What keeps the form from saving, field by field. */
export function formProblems(form: ScheduledTaskForm, now: Date): FormProblems {
  const problems: Record<string, string> = {};
  if (form.name.trim().length === 0) problems.name = "Give the task a name.";
  if (form.prompt.trim().length === 0) problems.prompt = "Say what each run should do.";
  if (form.environmentId === null) problems.computer = "Choose a computer.";
  if (form.projectId === null) problems.project = "Choose a project.";
  if (form.modelSelection === null) problems.agent = "Choose an agent.";
  if (form.target === "thread" && form.threadId === null) {
    problems.thread = "Choose the thread each run continues.";
  }
  if (form.cadenceKind === "custom" && form.cron.trim().length === 0) {
    problems.schedule = "Write a cron expression.";
  } else {
    const refusal = cadenceSaveRefusal(formCadence(form), form.timeZone, now);
    if (refusal !== null) problems.schedule = refusal;
  }
  return problems;
}

/** The settings the form saves, once it has no problems. */
export function formDraft(form: ScheduledTaskForm): ScheduledTaskDraft | null {
  if (
    form.environmentId === null ||
    form.projectId === null ||
    form.modelSelection === null ||
    (form.target === "thread" && form.threadId === null)
  ) {
    return null;
  }
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    projectId: form.projectId,
    checkout: form.checkout,
    modelSelection: form.modelSelection,
    runtimeMode: form.runtimeMode,
    interactionMode: "default",
    cadence: formCadence(form),
    timeZone: form.timeZone,
    target:
      form.target === "thread" && form.threadId !== null
        ? { kind: "thread", threadId: form.threadId }
        : { kind: "new_thread" },
  };
}

/** The next few runs of the form's schedule, for the preview under a custom one. */
export function previewRuns(form: ScheduledTaskForm, now: Date, count = 3): readonly Date[] {
  const slots = upcomingSlots(formCadence(form), form.timeZone, now, count);
  return Result.isSuccess(slots) ? slots.success : [];
}
