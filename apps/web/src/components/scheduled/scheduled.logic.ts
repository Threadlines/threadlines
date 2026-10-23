/**
 * The Scheduled page's pure parts (docs/design/fleet.md, Part 6): how runs
 * and times read, and the task form's state, checks and the draft it saves.
 * Which computers it lists and its search params are in scheduledShell.logic.ts.
 */
import {
  type EnvironmentId,
  type GitHubEventPreset,
  type GitHubEventTrigger,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ScheduledRunStatus,
  type ScheduledRunTrigger,
  type ScheduledTask,
  type ScheduledTaskCadence,
  type ScheduledTaskCheckout,
  type ScheduledTaskClock,
  type ScheduledTaskDraft,
  type ScheduledTaskGitHubContext,
  type ScheduledTaskId,
  type ScheduledTaskWebhookCadence,
  type ThreadId,
  type ThreadParticipantId,
  WEBHOOK_MAX_FILTERS,
  type WebhookEventRecord,
  type WebhookEventStatus,
  type WebhookFilter,
  type WebhookFilterOp,
  type WebhookSignature,
} from "@threadlines/contracts";
import {
  cadenceSaveRefusal,
  describeCadence,
  sameCadence,
  upcomingSlots,
} from "@threadlines/shared/scheduledTasks";
import {
  compileGitHubTrigger,
  describeWebhookFilter,
  GITHUB_WEBHOOK_SIGNATURE,
  webhookCadenceProblem,
} from "@threadlines/shared/webhookTasks";
import * as Result from "effect/Result";

import { viewerTimeZone } from "../../lib/timeZones";

// ---------------------------------------------------------------------------
// Where the page is (its search params are in scheduledShell.logic.ts)
// ---------------------------------------------------------------------------

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
  webhook: "Event",
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
  return task.cadence.kind === "manual" ||
    task.cadence.kind === "webhook" ||
    task.timeZone === viewerZone
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

/** "Today at 9:00" after a word reads "today at 9:00"; a weekday or a date keeps its capital. */
const whenAfterWord = (when: string) =>
  /^(Today|Tomorrow|Yesterday) /u.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : when;

/** When an event task's last event came: "Last event today at 9:00", or "No events yet". */
export function describeLastEvent(
  lastEventAt: string | null,
  nowMs: number,
  timeZone?: string,
): string {
  return lastEventAt === null
    ? "No events yet"
    : `Last event ${whenAfterWord(formatWhen(lastEventAt, nowMs, timeZone))}`;
}

/**
 * The line a task's row shows about when it runs next; for an event task,
 * when its last event came.
 */
export function describeNextRun(task: ScheduledTask, nowMs: number, timeZone?: string): string {
  if (task.status === "paused") return "Paused";
  if (task.status === "error") return "Stopped";
  if (task.status === "done") return "Done";
  if (task.cadence.kind === "manual") return "Runs when you start it";
  if (task.cadence.kind === "webhook") {
    const last = task.webhook?.lastEventAt ?? null;
    return last === null
      ? "No events yet"
      : `Last event ${whenAfterWord(formatWhen(last, nowMs, timeZone))}`;
  }
  if (task.nextRunAt === null) return "No next run";
  return `Next run ${whenAfterWord(formatWhen(task.nextRunAt, nowMs, timeZone))}`;
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
  webhook: "When something happens",
};

/** The kinds the Schedule field offers, in its order; event tasks only on a computer that runs them. */
export function cadenceKindsFor(eventTasks: boolean): readonly CadenceKind[] {
  const clock: CadenceKind[] = [
    "manual",
    "once",
    "hourly",
    "daily",
    "weekdays",
    "weekly",
    "custom",
  ];
  return eventTasks ? [...clock, "webhook"] : clock;
}

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** One filter row as the form edits it: the value is kept while "exists" is picked. */
export interface WebhookFilterRow {
  readonly path: string;
  readonly op: WebhookFilterOp;
  readonly value: string;
}

/**
 * An event task's start as the form edits it (docs/design/event-tasks.md):
 * every part is kept while another is picked, so switching GitHub to Any
 * service and back loses nothing. `webhookCadenceOf` makes the cadence it
 * saves. The `…Chosen` flags say the user set that part: until then the
 * project's repository and the signed-in GitHub login fill it in.
 */
export interface WebhookForm {
  readonly source: "github" | "any";
  readonly sourceChosen: boolean;
  /** "owner/name". */
  readonly repository: string;
  readonly repositoryChosen: boolean;
  readonly when: GitHubEventPreset;
  readonly label: string;
  readonly phrase: string;
  /** Custom: the GitHub events it subscribes to. */
  readonly events: readonly string[];
  /** "Only from": anyone, or these GitHub logins. */
  readonly anyone: boolean;
  readonly logins: readonly string[];
  readonly loginsChosen: boolean;
  readonly ignoreBots: boolean;
  /** The same issue or pull request continues its thread (new-thread tasks only). */
  readonly onePerSubject: boolean;
  /** Any service: check a signature. */
  readonly signed: boolean;
  readonly signature: WebhookSignature;
  readonly filters: readonly WebhookFilterRow[];
  readonly includeEvent: boolean;
  readonly maxLateMinutes: number;
  readonly dailyRunLimit: number;
}

/** "GitHub style": the header, encoding and prefix GitHub signs with. */
export const GITHUB_STYLE_SIGNATURE: WebhookSignature = {
  header: "X-Hub-Signature-256",
  encoding: GITHUB_WEBHOOK_SIGNATURE.encoding,
  prefix: GITHUB_WEBHOOK_SIGNATURE.prefix,
};

/**
 * A new event task's start: GitHub, an issue getting a label, only from the
 * signed-in GitHub user, bots ignored, at most 20 runs a day, events up to a
 * day late. The project's repository and the login fill in once
 * `scheduledTasks.gitHubContext` has them (webhookFormWithContext).
 */
export const DEFAULT_WEBHOOK_FORM: WebhookForm = {
  source: "github",
  sourceChosen: false,
  repository: "",
  repositoryChosen: false,
  when: "issue_labeled",
  label: "",
  phrase: "",
  events: ["issues"],
  anyone: false,
  logins: [],
  loginsChosen: false,
  ignoreBots: true,
  onePerSubject: false,
  signed: false,
  signature: GITHUB_STYLE_SIGNATURE,
  filters: [],
  includeEvent: true,
  maxLateMinutes: 1440,
  dailyRunLimit: 20,
};

/** The form opened on an event task's saved start: every part counts as chosen. */
export function webhookFormOf(cadence: ScheduledTaskWebhookCadence): WebhookForm {
  const github = cadence.github;
  return {
    ...DEFAULT_WEBHOOK_FORM,
    source: cadence.source,
    sourceChosen: true,
    repositoryChosen: true,
    loginsChosen: true,
    ...(github
      ? {
          repository: github.repository,
          when: github.when,
          label: github.label ?? "",
          phrase: github.phrase ?? "",
          events: github.events ?? DEFAULT_WEBHOOK_FORM.events,
          anyone: github.from.kind === "anyone",
          logins: github.from.kind === "people" ? github.from.logins : [],
          ignoreBots: github.ignoreBots,
          onePerSubject: github.onePerSubject,
        }
      : {}),
    signed: cadence.signature != null,
    signature: cadence.signature ?? DEFAULT_WEBHOOK_FORM.signature,
    filters: cadence.filters.map((filter) => ({
      path: filter.path,
      op: filter.op,
      value: filter.value ?? "",
    })),
    includeEvent: cadence.includeEvent,
    maxLateMinutes: cadence.maxLateMinutes,
    dailyRunLimit: cadence.dailyRunLimit,
  };
}

/**
 * The parts the user hasn't set, filled from the project's GitHub context:
 * its repository (and GitHub as the source, or Any service for a project
 * that has none), and the signed-in login as the one sender. Null context
 * (not known yet): as it is.
 */
export function webhookFormWithContext(
  webhook: WebhookForm,
  context: ScheduledTaskGitHubContext | null,
): WebhookForm {
  if (context === null) return webhook;
  return {
    ...webhook,
    source: webhook.sourceChosen ? webhook.source : context.repository !== null ? "github" : "any",
    repository: webhook.repositoryChosen ? webhook.repository : (context.repository ?? ""),
    logins: webhook.loginsChosen ? webhook.logins : context.login !== null ? [context.login] : [],
  };
}

const nonEmpty = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** The GitHub trigger the form's parts make. */
function githubTriggerOf(webhook: WebhookForm, newThread: boolean): GitHubEventTrigger {
  const label =
    webhook.when === "issue_labeled" || webhook.when === "pr_labeled"
      ? nonEmpty(webhook.label)
      : undefined;
  const phrase = webhook.when === "comment_phrase" ? nonEmpty(webhook.phrase) : undefined;
  return {
    repository: webhook.repository.trim(),
    when: webhook.when,
    ...(webhook.when === "custom" ? { events: [...webhook.events] } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(phrase !== undefined ? { phrase } : {}),
    from: webhook.anyone ? { kind: "anyone" } : { kind: "people", logins: [...webhook.logins] },
    ignoreBots: webhook.ignoreBots,
    onePerSubject: newThread && webhook.onePerSubject,
  };
}

/** The cadence an event task saves. `newThread`: each run starts a thread (not a continued one). */
export function webhookCadenceOf(
  webhook: WebhookForm,
  newThread: boolean,
): ScheduledTaskWebhookCadence {
  const filters = webhook.filters.map((row): WebhookFilter =>
    row.op === "exists"
      ? { path: row.path.trim(), op: row.op }
      : { path: row.path.trim(), op: row.op, value: row.value },
  );
  const shared = {
    kind: "webhook" as const,
    filters,
    includeEvent: webhook.includeEvent,
    maxLateMinutes: webhook.maxLateMinutes,
    dailyRunLimit: webhook.dailyRunLimit,
  };
  return webhook.source === "github"
    ? { ...shared, source: "github", github: githubTriggerOf(webhook, newThread) }
    : {
        ...shared,
        source: "any",
        signature: webhook.signed
          ? {
              header: webhook.signature.header.trim(),
              encoding: webhook.signature.encoding,
              prefix: webhook.signature.prefix,
            }
          : null,
      };
}

/** The GitHub events a trigger subscribes to, as the form has it now. */
export function webhookFormEvents(webhook: WebhookForm): readonly string[] {
  return compileGitHubTrigger(githubTriggerOf(webhook, true)).events;
}

/** What each "When" preset reads as in the form's dropdown. */
export const GITHUB_PRESET_LABELS: Record<GitHubEventPreset, string> = {
  issue_opened: "Issue opened",
  issue_labeled: "Issue gets a label…",
  pr_opened: "Pull request opened",
  pr_labeled: "Pull request gets a label…",
  comment_phrase: "Comment contains…",
  checks_failed: "Checks fail on a pull request",
  custom: "Custom",
};

export const GITHUB_PRESETS: readonly GitHubEventPreset[] = [
  "issue_opened",
  "issue_labeled",
  "pr_opened",
  "pr_labeled",
  "comment_phrase",
  "checks_failed",
  "custom",
];

/** GitHub's own names for its webhook events, as its "Let me select individual events" list shows them. */
const GITHUB_EVENT_LABELS: Readonly<Record<string, string>> = {
  issues: "Issues",
  issue_comment: "Issue comments",
  pull_request: "Pull requests",
  pull_request_review: "Pull request reviews",
  pull_request_review_comment: "Pull request review comments",
  push: "Pushes",
  check_suite: "Check suites",
  check_run: "Check runs",
  workflow_run: "Workflow runs",
  release: "Releases",
  discussion: "Discussions",
  discussion_comment: "Discussion comments",
};

/** A GitHub event as GitHub's settings name it ("Issue comments"); its id when unknown. */
export function githubEventLabel(event: string): string {
  return GITHUB_EVENT_LABELS[event] ?? event;
}

/** Fields worth filtering on, per GitHub event; "Insert field" offers the chosen events' ones. */
const GITHUB_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  issues: [
    "action",
    "issue.title",
    "issue.body",
    "issue.labels[].name",
    "issue.user.login",
    "label.name",
  ],
  issue_comment: [
    "action",
    "comment.body",
    "comment.user.login",
    "issue.title",
    "issue.labels[].name",
    "issue.pull_request",
  ],
  pull_request: [
    "action",
    "pull_request.title",
    "pull_request.draft",
    "pull_request.base.ref",
    "pull_request.head.ref",
    "pull_request.labels[].name",
    "pull_request.user.login",
    "label.name",
  ],
  pull_request_review: [
    "action",
    "review.state",
    "review.body",
    "pull_request.title",
    "pull_request.base.ref",
  ],
  pull_request_review_comment: [
    "action",
    "comment.body",
    "comment.path",
    "pull_request.title",
    "pull_request.base.ref",
  ],
  push: ["ref", "pusher.name", "head_commit.message", "commits[].message"],
  check_suite: [
    "action",
    "check_suite.conclusion",
    "check_suite.head_branch",
    "check_suite.app.slug",
  ],
  check_run: [
    "action",
    "check_run.name",
    "check_run.conclusion",
    "check_run.check_suite.head_branch",
  ],
  workflow_run: [
    "action",
    "workflow_run.name",
    "workflow_run.conclusion",
    "workflow_run.head_branch",
  ],
  release: ["action", "release.tag_name", "release.prerelease"],
  discussion: ["action", "discussion.title", "discussion.category.name"],
  discussion_comment: ["action", "comment.body", "discussion.title"],
};

/** Every event's own fields, then the ones all GitHub events carry; no repeats. */
export function githubEventFields(events: readonly string[]): readonly string[] {
  const fields = new Set<string>();
  for (const event of events) {
    for (const field of GITHUB_EVENT_FIELDS[event] ?? []) fields.add(field);
  }
  for (const field of ["sender.login", "sender.type", "repository.full_name"]) fields.add(field);
  return [...fields];
}

/** What each filter test reads as in its dropdown. */
export const WEBHOOK_FILTER_OP_LABELS: Record<WebhookFilterOp, string> = {
  equals: "equals",
  notEquals: "isn't",
  in: "is one of",
  contains: "contains",
  startsWith: "starts with",
  exists: "exists",
};

export const WEBHOOK_FILTER_OPS: readonly WebhookFilterOp[] = [
  "equals",
  "notEquals",
  "in",
  "contains",
  "startsWith",
  "exists",
];

/** The form can hold this many filter rows; past it, Add filter is off. */
export const MAX_WEBHOOK_FILTER_ROWS = WEBHOOK_MAX_FILTERS;

/** The late limits the form offers, in minutes; a saved one outside these is added. */
const LATE_LIMIT_MINUTES = [5, 15, 60, 360, 1440] as const;

/** "15 minutes", "1 hour", "6 hours", "1 day". */
export function formatLateLimit(minutes: number): string {
  if (minutes === 1440) return "1 day";
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function lateLimitOptions(current: number): readonly number[] {
  return [...new Set<number>([...LATE_LIMIT_MINUTES, current])].toSorted((a, b) => a - b);
}

/** Everything the form edits; the cadence's parts are kept apart so switching kinds keeps them. */
export interface ScheduledTaskForm {
  readonly name: string;
  readonly prompt: string;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly checkout: ScheduledTaskCheckout;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  /**
   * The user picked the access (or the task already had one): until then a
   * new event task asks before changes (eventTaskRuntimeMode).
   */
  readonly runtimeModeChosen: boolean;
  readonly cadenceKind: CadenceKind;
  /** A one-time task's day, "2026-10-22". */
  readonly date: string;
  readonly time: ScheduledTaskClock;
  readonly minute: number;
  readonly weekday: number;
  readonly cron: string;
  /** An event task's start (docs/design/event-tasks.md), kept while another kind is picked. */
  readonly webhook: WebhookForm;
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

/**
 * The access a new event task starts with: "ask before changes"
 * (approval-required). Text strangers write lands in its runs' prompts
 * (docs/design/event-tasks.md, Safety defaults).
 */
export const EVENT_TASK_RUNTIME_MODE: RuntimeMode = "approval-required";

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
    runtimeModeChosen: false,
    cadenceKind: "weekdays",
    time: { hour: 9, minute: 0 },
    minute: 0,
    weekday: 1,
    cron: "0 9 * * 1-5",
    webhook: DEFAULT_WEBHOOK_FORM,
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
    runtimeModeChosen: true,
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
    ...(cadence.kind === "webhook" ? { webhook: webhookFormOf(cadence) } : {}),
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
    case "webhook":
      return webhookCadenceOf(form.webhook, form.target === "new_thread");
  }
}

export type FormProblems = Partial<
  Record<
    "name" | "prompt" | "computer" | "project" | "agent" | "schedule" | "thread" | "goesTo",
    string
  >
>;

/** What keeps an event task's start from saving, in one sentence; null when nothing does. */
function webhookFormProblem(form: ScheduledTaskForm): string | null {
  const webhook = form.webhook;
  if (webhook.source === "github" && !webhook.anyone && webhook.logins.length === 0) {
    return "Add at least one GitHub username, or choose Anyone.";
  }
  if (webhook.source === "any" && webhook.signed && webhook.signature.header.trim().length === 0) {
    return "Name the header the signature comes in.";
  }
  if (
    !Number.isInteger(webhook.dailyRunLimit) ||
    webhook.dailyRunLimit < 1 ||
    webhook.dailyRunLimit > 200
  ) {
    return "Allow from 1 to 200 runs a day.";
  }
  return webhookCadenceProblem(
    webhookCadenceOf(webhook, form.target === "new_thread"),
    form.prompt,
  );
}

/**
 * What keeps the form from saving, field by field. Editing `saved`, a
 * schedule left as it was isn't checked again: a one-time task that ran can
 * be renamed without a new time. `agentLeft`: the room agent the continued
 * thread's runs go to has left it. An event task's settings are always
 * checked, with its instructions (their `{{...}}` placeholders).
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
  if (form.cadenceKind === "webhook") {
    const problem = webhookFormProblem(form);
    if (problem !== null) problems.schedule = problem;
    return problems;
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

/**
 * Who could start a run with full access, said before saving: an event task
 * with full access that takes events from anyone on GitHub, or from any
 * sender with the address (no signature). Null otherwise.
 */
export function eventTaskAccessWarning(form: ScheduledTaskForm): string | null {
  if (form.cadenceKind !== "webhook" || form.runtimeMode !== "full-access") return null;
  const webhook = form.webhook;
  if (webhook.source === "github") {
    return webhook.anyone ? `${anyoneOnGitHub(webhook.repository)} with full access.` : null;
  }
  return webhook.signed
    ? null
    : "Anyone who has this task's address can start a run with full access.";
}

/** "Anyone who can comment on acme/app can start a run", the start of the Anyone warning. */
function anyoneOnGitHub(repository: string): string {
  const named = repository.trim().length > 0 ? repository.trim() : "the repository";
  return `Anyone who can comment on ${named} can start a run`;
}

/** The confirm "Anyone" asks for: who could start a run, and with what. */
export function anyoneConfirmText(repository: string): string {
  return `${anyoneOnGitHub(repository)} with this task's access.`;
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

// ---------------------------------------------------------------------------
// An event task's events
// ---------------------------------------------------------------------------

const WEBHOOK_EVENT_STATUS_LABELS: Record<WebhookEventStatus, string> = {
  received: "Received",
  waiting: "Waiting",
  ran: "Started a run",
  joined: "Continued its thread",
  skipped: "Skipped",
  failed: "Failed",
};

/** The dot beside an event: green when it started work, red when it failed, blue while it waits. */
export const WEBHOOK_EVENT_DOT_CLASSES: Record<WebhookEventStatus, string> = {
  received: "bg-primary-graph",
  waiting: "bg-primary-graph",
  ran: "bg-success",
  joined: "bg-success",
  skipped: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

/** What happened to an event, in words: "Skipped. The task is paused." */
export function describeWebhookEventOutcome(
  event: Pick<WebhookEventRecord, "status" | "reason" | "eventName">,
): string {
  // GitHub's ping only checks the address works: nothing was meant to run.
  if (event.eventName === "ping") return "GitHub checked the address. Nothing to run.";
  const label = WEBHOOK_EVENT_STATUS_LABELS[event.status];
  const reason = event.reason?.trim();
  return reason ? `${label}. ${reason}` : label;
}

/** What an event was, in one line: its summary, else GitHub's event name, else "An event". */
export function describeWebhookEvent(
  event: Pick<WebhookEventRecord, "summary" | "eventName">,
): string {
  return event.summary ?? event.eventName ?? "An event";
}

/** Where an event came from, when it isn't the task's address: a test or a run again. */
export const WEBHOOK_EVENT_SOURCE_LABELS: Record<WebhookEventRecord["source"], string | null> = {
  relay: null,
  local: "On this computer",
  test: "Test",
  replay: "Run again",
};

/** GitHub's page for adding a webhook to a repository ("owner/name"). */
export function githubNewHookUrl(repository: string): string {
  return `https://github.com/${repository}/settings/hooks/new`;
}

/** Whose events an event task takes, in a few words: "@badcuban, bots ignored". */
export function describeWebhookSenders(cadence: ScheduledTaskWebhookCadence): string {
  if (cadence.source === "any") {
    return cadence.signature
      ? `Senders that sign with its secret (${cadence.signature.header})`
      : "Anyone who has its address";
  }
  const github = cadence.github;
  if (!github) return "Nobody yet";
  const who =
    github.from.kind === "anyone"
      ? `Anyone who can comment on ${github.repository}`
      : github.from.logins.map((login) => `@${login}`).join(", ");
  return github.ignoreBots ? `${who}, bots ignored` : who;
}

/** An event task's limits: "20 runs a day, events more than 1 day late skipped". */
export function describeWebhookLimits(cadence: ScheduledTaskWebhookCadence): string {
  return `${cadence.dailyRunLimit} run${cadence.dailyRunLimit === 1 ? "" : "s"} a day, events more than ${formatLateLimit(cadence.maxLateMinutes)} late skipped`;
}

/** The GitHub events to tick when adding an event task's webhook by hand: "Issues, Issue comments". */
export function githubHookEventLabels(cadence: ScheduledTaskWebhookCadence): string {
  if (cadence.source !== "github" || !cadence.github) return "";
  return compileGitHubTrigger(cadence.github).events.map(githubEventLabel).join(", ");
}

/** An event task's cadence; null for a clock task. */
export function webhookCadenceOfTask(
  task: Pick<ScheduledTask, "cadence">,
): ScheduledTaskWebhookCadence | null {
  return task.cadence.kind === "webhook" ? task.cadence : null;
}

/** What starts an event task's runs and what limits them, as detail rows. */
export function eventTaskDetailRows(cadence: ScheduledTaskWebhookCadence): ReadonlyArray<{
  readonly label: string;
  readonly value: string;
}> {
  return [
    { label: "Only from", value: describeWebhookSenders(cadence) },
    ...(cadence.filters.length > 0
      ? [{ label: "Filters", value: cadence.filters.map(describeWebhookFilter).join("; ") }]
      : []),
    { label: "Limits", value: describeWebhookLimits(cadence) },
    {
      label: "Message",
      value: cadence.includeEvent ? "Instructions, then the event" : "Instructions only",
    },
  ];
}
