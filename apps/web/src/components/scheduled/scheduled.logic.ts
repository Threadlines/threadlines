/**
 * The Scheduled page's pure parts (docs/design/fleet.md, Part 6): which
 * computers it lists, its search params, how runs and times read, and the
 * task form's state, checks and the draft it saves.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
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
  ThreadParticipantId,
} from "@threadlines/contracts";
import {
  cadenceSaveRefusal,
  describeCadence,
  sameCadence,
  upcomingSlots,
} from "@threadlines/shared/scheduledTasks";
import * as Result from "effect/Result";

import type { SavedEnvironmentConnectionState } from "../../environments/runtime/catalog";
import type { ScheduledTaskEnvironment } from "../../lib/scheduledTasksState";
import { viewerTimeZone } from "../../lib/timeZones";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";

// ---------------------------------------------------------------------------
// Which computers run scheduled tasks
// ---------------------------------------------------------------------------

interface ScheduledTaskComputer {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly descriptor: Pick<ExecutionEnvironmentDescriptor, "capabilities" | "label"> | null;
}

/**
 * This computer and every connected saved computer whose server reports the
 * `scheduledTasks` capability, this one first and the rest by name. An
 * absent capability (an older Threadlines) is a no.
 */
export function scheduledTaskEnvironmentsOf(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primaryDescriptor: Pick<ExecutionEnvironmentDescriptor, "capabilities" | "label"> | null;
  readonly runtimeById: Readonly<Record<EnvironmentId, ScheduledTaskComputer>>;
  readonly savedLabelOf: (environmentId: EnvironmentId) => string | null;
}): ScheduledTaskEnvironment[] {
  const environments: ScheduledTaskEnvironment[] = [];
  const seen = new Set<EnvironmentId>();
  const { primaryEnvironmentId, primaryDescriptor } = input;
  if (primaryEnvironmentId && primaryDescriptor?.capabilities.scheduledTasks === true) {
    seen.add(primaryEnvironmentId);
    environments.push({
      environmentId: primaryEnvironmentId,
      isPrimary: true,
      label: resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironmentId,
        runtimeLabel: primaryDescriptor.label,
      }),
    });
  }
  const others: ScheduledTaskEnvironment[] = [];
  for (const environmentId of Object.keys(input.runtimeById) as EnvironmentId[]) {
    if (seen.has(environmentId)) continue;
    const runtime = input.runtimeById[environmentId];
    if (!runtime || runtime.connectionState !== "connected") continue;
    if (runtime.descriptor?.capabilities.scheduledTasks !== true) continue;
    seen.add(environmentId);
    others.push({
      environmentId,
      isPrimary: false,
      label: resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId,
        runtimeLabel: runtime.descriptor.label,
        savedLabel: input.savedLabelOf(environmentId),
      }),
    });
  }
  return [...environments, ...others.toSorted((a, b) => a.label.localeCompare(b.label))];
}

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
export { viewerTimeZone } from "../../lib/timeZones";

/** A wall time in the viewer's locale ("9:00", "9:00 AM"). */
export function formatClock(clock: ScheduledTaskClock): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, clock.hour, clock.minute));
}

/** A one-time task's day in the viewer's locale: "Oct 22", with the year when it isn't this one. */
export function formatCadenceDay(date: string, nowMs: number = Date.now()): string {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const at = Date.UTC(year, month - 1, day, 12);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(year === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(at);
}

/**
 * A task's schedule in a few words, naming its zone when it isn't the
 * viewer's ("Weekdays at 9:00 · Europe/Madrid").
 */
export function describeTaskSchedule(
  task: Pick<ScheduledTask, "cadence" | "timeZone">,
  viewerZone: string = viewerTimeZone(),
): string {
  const words = describeCadence(task.cadence, formatClock, formatCadenceDay);
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
  if (task.status === "done") return "Done";
  if (task.cadence.kind === "manual") return "Runs when you start it";
  if (task.nextRunAt === null) return "No next run";
  const when = formatWhen(task.nextRunAt, nowMs, timeZone);
  // "Today at 9:00" reads as "Next run today at 9:00"; a weekday or a date keeps its capital.
  return `Next run ${/^(Today|Tomorrow|Yesterday) /u.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : when}`;
}

// ---------------------------------------------------------------------------
// An agent's schedule_create and schedule_update calls, in its chat
// ---------------------------------------------------------------------------

/** The schedule tools whose calls leave a record in the chat. */
export type ScheduleChangeTool = "schedule_create" | "schedule_update";

const SCHEDULE_CALL_OUTCOMES = new Set([
  "created",
  "updated",
  "asked_user",
  "off",
  "not_allowed",
  "refused",
  "failed",
] as const);
type ScheduleCallOutcome = typeof SCHEDULE_CALL_OUTCOMES extends Set<infer T> ? T : never;

/** What a schedule_create or schedule_update result said, as far as it survived. */
export interface ScheduleCallResult {
  readonly outcome: ScheduleCallOutcome | null;
  /** The task it made or changed, or will once the user allows it. */
  readonly taskId: ScheduledTaskId | null;
  /** The card's request, when it asked the user. */
  readonly requestId: string | null;
  readonly name: string | null;
}

/**
 * Reads a call's result (WorkLogEntry.toolResult) as text, so one a provider
 * passed along as JSON inside a string reads the same, and one cut short
 * still gives what survived.
 */
export function parseScheduleCallResult(output: string | undefined): ScheduleCallResult {
  const text = (output ?? "").replaceAll('\\"', '"');
  const field = (pattern: RegExp) => pattern.exec(text)?.[1] ?? null;
  const outcome = field(/"outcome"\s*:\s*"([a-z_]+)"/u);
  const taskId =
    field(/"taskId"\s*:\s*"([^"]+)"/u) ?? field(/"task"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/u);
  return {
    outcome:
      outcome !== null && SCHEDULE_CALL_OUTCOMES.has(outcome as ScheduleCallOutcome)
        ? (outcome as ScheduleCallOutcome)
        : null,
    taskId: taskId === null ? null : (taskId as ScheduledTaskId),
    requestId: field(/"requestId"\s*:\s*"([^"]+)"/u),
    name: field(/"name"\s*:\s*"([^"]+)"/u),
  };
}

/** The line a call leaves in the chat; `open` when its task can be opened. */
export interface ScheduleCallRecord {
  readonly heading: string;
  readonly outcome: string | null;
  readonly open: ScheduledTaskId | null;
}

const SCHEDULE_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  off: "turned off in Settings",
  not_allowed: "not allowed from this thread",
  refused: "refused",
  failed: "failed",
};

/**
 * What one call's line says, live: the task as it is now on its computer,
 * or the card still waiting for the user.
 */
export function describeScheduleCall(input: {
  readonly tool: ScheduleChangeTool;
  readonly result: ScheduleCallResult;
  /** The task the result names, as its computer has it now. */
  readonly task: ScheduledTask | null;
  /** Whether the call's card still waits for the user. */
  readonly waiting: boolean;
  /** The call itself failed (the tool never answered, or answered with an error). */
  readonly failed: boolean;
  /**
   * Whether this client follows the computer's tasks yet: until then (or
   * for one that doesn't run them) the line says only what the call did.
   */
  readonly followed: boolean;
  readonly nowMs: number;
  readonly timeZone?: string;
}): ScheduleCallRecord {
  const { tool, result, task } = input;
  const creating = tool === "schedule_create";
  const refusal =
    result.outcome === null
      ? input.failed
        ? "failed"
        : null
      : (SCHEDULE_REFUSAL_WORDS[result.outcome] ?? null);
  if (refusal !== null) {
    return {
      heading: creating ? "Tried to schedule a task" : "Tried to change a scheduled task",
      outcome: refusal,
      open: null,
    };
  }
  const name = task?.name ?? result.name;
  const quoted = name === null ? null : `“${name}”`;
  const done = creating
    ? quoted === null
      ? "Scheduled a task"
      : `Scheduled ${quoted}`
    : quoted === null
      ? "Changed a scheduled task"
      : `Changed ${quoted}`;
  const asked = creating
    ? quoted === null
      ? "Asked to schedule a task"
      : `Asked to schedule ${quoted}`
    : quoted === null
      ? "Asked to change a scheduled task"
      : `Asked to change ${quoted}`;
  // A one-time task's schedule is its next run; say it once.
  const when =
    task === null
      ? null
      : task.cadence.kind === "once"
        ? describeNextRun(task, input.nowMs, input.timeZone)
        : `${describeTaskSchedule(task, input.timeZone)} · ${describeNextRun(task, input.nowMs, input.timeZone)}`;
  // What it answered is unknown (the provider kept no result): only that it asked.
  if (result.outcome === null) {
    return { heading: asked, outcome: null, open: task?.id ?? null };
  }
  if (!input.followed) {
    return { heading: result.outcome === "asked_user" ? asked : done, outcome: null, open: null };
  }
  if (result.outcome === "asked_user") {
    if (input.waiting) return { heading: asked, outcome: "waiting for you", open: null };
    // Answered: a new task that exists was allowed; one that doesn't wasn't.
    if (creating) {
      return task === null
        ? { heading: asked, outcome: "not scheduled", open: null }
        : { heading: done, outcome: when, open: task.id };
    }
    return { heading: asked, outcome: null, open: task?.id ?? null };
  }
  return task === null
    ? { heading: done, outcome: "deleted since", open: null }
    : { heading: done, outcome: when, open: task.id };
}

// ---------------------------------------------------------------------------
// The task form
// ---------------------------------------------------------------------------

export type CadenceKind = ScheduledTaskCadence["kind"];

export const CADENCE_KIND_LABELS: Record<CadenceKind, string> = {
  once: "Once",
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
  /** A one-time task's day, "2026-10-22". */
  readonly date: string;
  readonly time: ScheduledTaskClock;
  readonly minute: number;
  readonly weekday: number;
  readonly cron: string;
  readonly timeZone: string;
  /**
   * The user picked the zone (or the task already had one): until then a
   * new task follows the chosen computer's own zone.
   */
  readonly timeZoneChosen: boolean;
  readonly target: "new_thread" | "thread";
  readonly threadId: ThreadId | null;
  /** In a room, the agent the continued thread's runs are for; kept until another thread is chosen. */
  readonly threadParticipantId: ThreadParticipantId | null;
}

/** The calendar day of `now` in `timeZone`, "2026-10-21". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The calendar day after `now` in `timeZone`, "2026-10-22". */
export function tomorrowIn(timeZone: string, now: Date = new Date()): string {
  return todayIn(timeZone, new Date(now.getTime() + 24 * 60 * 60_000));
}

export function emptyTaskForm(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly timeZone: string;
}): ScheduledTaskForm {
  return {
    date: tomorrowIn(input.timeZone),
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
    timeZoneChosen: false,
    target: "new_thread",
    threadId: null,
    threadParticipantId: null,
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
    ...(cadence.kind === "daily" ||
    cadence.kind === "weekdays" ||
    cadence.kind === "weekly" ||
    cadence.kind === "once"
      ? { time: cadence.time }
      : {}),
    ...(cadence.kind === "once" ? { date: cadence.date } : {}),
    ...(cadence.kind === "hourly" ? { minute: cadence.minute } : {}),
    ...(cadence.kind === "weekly" ? { weekday: cadence.weekday } : {}),
    ...(cadence.kind === "custom" ? { cron: cadence.cron } : {}),
    timeZoneChosen: true,
    target: task.target.kind,
    threadId: task.target.kind === "thread" ? task.target.threadId : null,
    threadParticipantId: task.target.kind === "thread" ? (task.target.participantId ?? null) : null,
  };
}

export function formCadence(form: ScheduledTaskForm): ScheduledTaskCadence {
  switch (form.cadenceKind) {
    case "once":
      return { kind: "once", date: form.date, time: form.time };
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

export type FormProblems = Partial<
  Record<
    "name" | "prompt" | "computer" | "project" | "agent" | "schedule" | "thread" | "goesTo",
    string
  >
>;

/**
 * What keeps the form from saving, field by field. Editing `saved`, a
 * schedule left as it was isn't checked again: a one-time task that ran can
 * be renamed without a new time. `agentLeft`: the room agent the continued
 * thread's runs go to has left it.
 */
export function formProblems(
  form: ScheduledTaskForm,
  now: Date,
  saved?: Pick<ScheduledTask, "cadence" | "timeZone">,
  agentLeft = false,
): FormProblems {
  const problems: Record<string, string> = {};
  if (form.name.trim().length === 0) problems.name = "Give the task a name.";
  if (form.prompt.trim().length === 0) problems.prompt = "Say what each run should do.";
  if (form.environmentId === null) problems.computer = "Choose a computer.";
  if (form.projectId === null) problems.project = "Choose a project.";
  if (form.modelSelection === null) problems.agent = "Choose an agent.";
  if (form.target === "thread" && form.threadId === null) {
    problems.thread = "Choose the thread each run continues.";
  }
  if (form.target === "thread" && agentLeft) {
    problems.goesTo = "Its agent left the thread. Pick another agent.";
  }
  const unchanged =
    saved !== undefined &&
    saved.timeZone === form.timeZone &&
    sameCadence(saved.cadence, formCadence(form));
  if (form.cadenceKind === "custom" && form.cron.trim().length === 0) {
    problems.schedule = "Write a cron expression.";
  } else if (!unchanged) {
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
        ? {
            kind: "thread",
            threadId: form.threadId,
            ...(form.threadParticipantId !== null
              ? { participantId: form.threadParticipantId }
              : {}),
          }
        : { kind: "new_thread" },
  };
}

/** The next few runs of the form's schedule, for the preview under a custom one. */
export function previewRuns(form: ScheduledTaskForm, now: Date, count = 3): readonly Date[] {
  const slots = upcomingSlots(formCadence(form), form.timeZone, now, count);
  return Result.isSuccess(slots) ? slots.success : [];
}
