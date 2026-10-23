import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  ThreadParticipantId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

/**
 * Scheduled tasks (docs/design/fleet.md, Part 6). Each computer's server
 * keeps its own tasks and starts their runs while Threadlines is running on
 * it; a client lists the tasks of every connected computer that has the
 * `scheduledTasks` capability. A run is an ordinary thread (or a follow-up in
 * one), started through orchestration commands; the task and its run history
 * are configuration, kept apart from thread history.
 */

/** A wall-clock time in the task's time zone. */
export const ScheduledTaskClock = Schema.Struct({
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
});
export type ScheduledTaskClock = typeof ScheduledTaskClock.Type;

/** A calendar day in the task's time zone: "2026-10-22". */
export const ScheduledTaskDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type ScheduledTaskDate = typeof ScheduledTaskDate.Type;

/**
 * One test on a field of an event (docs/design/event-tasks.md). `path` reads
 * `headers.<name>`, `query.<name>`, or the body (anything else; a `body.`
 * prefix is accepted too); `[]` fans out over an array
 * (`issue.labels[].name`). Values compare as strings; a missing or null field
 * fails every test, `notEquals` included. `contains` is a plain substring
 * test: there is no regex, so strangers' text can't stall the server.
 */
export const WebhookFilterOp = Schema.Literals([
  "equals",
  "notEquals",
  "in",
  "contains",
  "startsWith",
  "exists",
]);
export type WebhookFilterOp = typeof WebhookFilterOp.Type;

export const WebhookFilter = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  op: WebhookFilterOp,
  /** Unused by `exists`; `in` takes a comma-separated list. */
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type WebhookFilter = typeof WebhookFilter.Type;

/** At most this many filters per task, all of which must pass. */
export const WEBHOOK_MAX_FILTERS = 16;

/**
 * What happens on GitHub to start a run. Each compiles (packages/shared
 * webhookTasks.ts) to the GitHub events to subscribe to plus filters.
 * `checks_failed`: a check suite on a pull request's branch completed with a
 * failure. `custom`: the events in `events`, narrowed by the task's filters.
 */
export const GitHubEventPreset = Schema.Literals([
  "issue_opened",
  "issue_labeled",
  "pr_opened",
  "pr_labeled",
  "comment_phrase",
  "checks_failed",
  "custom",
]);
export type GitHubEventPreset = typeof GitHubEventPreset.Type;

/** Whose events start a run: these GitHub logins, or anyone. */
export const WebhookSenders = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("people"),
    logins: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ kind: Schema.Literal("anyone") }),
]);
export type WebhookSenders = typeof WebhookSenders.Type;

export const GitHubEventTrigger = Schema.Struct({
  /** "owner/repo". */
  repository: TrimmedNonEmptyString,
  when: GitHubEventPreset,
  /** `custom` only: the GitHub events to subscribe to ("issues", "push"). */
  events: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** The label the label presets wait for. */
  label: Schema.optional(TrimmedNonEmptyString),
  /** The words `comment_phrase` waits for in a comment. */
  phrase: Schema.optional(TrimmedNonEmptyString),
  from: WebhookSenders,
  /** Events a bot account started are skipped. */
  ignoreBots: Schema.Boolean,
  /** The same issue or pull request continues its own thread. */
  onePerSubject: Schema.Boolean,
});
export type GitHubEventTrigger = typeof GitHubEventTrigger.Type;

/**
 * How an "any service" sender signs its events: an HMAC-SHA256 of the raw
 * body in `header`, after `prefix` ("sha256="). GitHub's is fixed.
 */
export const WebhookSignature = Schema.Struct({
  header: TrimmedNonEmptyString,
  encoding: Schema.Literals(["hex", "base64"]),
  prefix: Schema.String,
});
export type WebhookSignature = typeof WebhookSignature.Type;

/**
 * An event task's start: an outside service sends the computer an event
 * (docs/design/event-tasks.md). `source` "github" carries `github` and always
 * checks GitHub's signature; "any" checks `signature` when set.
 */
export const ScheduledTaskWebhookCadence = Schema.Struct({
  kind: Schema.Literal("webhook"),
  source: Schema.Literals(["github", "any"]),
  github: Schema.optional(GitHubEventTrigger),
  signature: Schema.optional(Schema.NullOr(WebhookSignature)),
  filters: Schema.Array(WebhookFilter).check(Schema.isMaxLength(WEBHOOK_MAX_FILTERS)),
  /** Adds the event itself to the run's message (a summary for GitHub, else JSON). */
  includeEvent: Schema.Boolean,
  /** An event older than this when its turn comes is skipped. */
  maxLateMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
  /** At most this many runs a day (in the task's time zone). */
  dailyRunLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});
export type ScheduledTaskWebhookCadence = typeof ScheduledTaskWebhookCadence.Type;

/**
 * When a task runs. Every kind but `manual` and `webhook` compiles to a
 * 5-field cron expression evaluated in the task's time zone (packages/shared
 * scheduledTasks.ts); `custom` is one, minute resolution only. `weekday` is
 * 0 (Sunday) to 6 (Saturday). `once` runs one time, on `date` at `time`; the
 * task is `done` after. `webhook` runs when an event arrives (an "event
 * task"); servers without the `eventTasks` capability refuse it.
 */
export const ScheduledTaskCadence = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("once"),
    date: ScheduledTaskDate,
    time: ScheduledTaskClock,
  }),
  Schema.Struct({
    kind: Schema.Literal("hourly"),
    minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
  }),
  Schema.Struct({ kind: Schema.Literal("daily"), time: ScheduledTaskClock }),
  Schema.Struct({ kind: Schema.Literal("weekdays"), time: ScheduledTaskClock }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
    time: ScheduledTaskClock,
  }),
  Schema.Struct({ kind: Schema.Literal("custom"), cron: TrimmedNonEmptyString }),
  ScheduledTaskWebhookCadence,
]);
export type ScheduledTaskCadence = typeof ScheduledTaskCadence.Type;
export type ScheduledTaskCadenceKind = ScheduledTaskCadence["kind"];

/** Where a new-thread run works: the project folder itself, or a new worktree per run. */
export const ScheduledTaskCheckout = Schema.Literals(["local", "worktree"]);
export type ScheduledTaskCheckout = typeof ScheduledTaskCheckout.Type;

/**
 * What each run does: start a new thread, or send the prompt to one thread
 * as a follow-up. In a room, `participantId` is the agent the follow-up is
 * for (the one that set the task up); absent, the thread's own.
 */
export const ScheduledTaskTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new_thread") }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
    participantId: Schema.optional(ThreadParticipantId),
  }),
]);
export type ScheduledTaskTarget = typeof ScheduledTaskTarget.Type;

/**
 * `error`: the server couldn't work out the task's next run (its schedule
 * stopped making sense, say its cron); `error` names why. Saving it again
 * clears it. `done`: a `once` task whose time came; saving it with a new
 * time makes it active again.
 */
export const ScheduledTaskStatus = Schema.Literals(["active", "paused", "error", "done"]);
export type ScheduledTaskStatus = typeof ScheduledTaskStatus.Type;

/**
 * Where one run is. `launching`: its thread or message is being set up.
 * `queued`: its follow-up waits behind the thread's own work. `started`: its
 * turn is running. The rest are ends: `finished` (its turn ended),
 * `nothing_to_report` (its agent said so), `failed`, `interrupted` (a
 * restart cut its turn off), `skipped` (it never ran; `reason` says why).
 */
export const ScheduledRunStatus = Schema.Literals([
  "launching",
  "queued",
  "started",
  "finished",
  "nothing_to_report",
  "failed",
  "interrupted",
  "skipped",
]);
export type ScheduledRunStatus = typeof ScheduledRunStatus.Type;

/**
 * `catch_up`: the one run for slots missed while the computer was off or
 * asleep. `webhook`: an event task's run, started by an event.
 */
export const ScheduledRunTrigger = Schema.Literals(["schedule", "catch_up", "manual", "webhook"]);
export type ScheduledRunTrigger = typeof ScheduledRunTrigger.Type;

export const ScheduledRun = Schema.Struct({
  taskId: ScheduledTaskId,
  /** The slot it ran for: a UTC instant (Run now: the moment it was asked for). */
  slotUtc: IsoDateTime,
  trigger: ScheduledRunTrigger,
  status: ScheduledRunStatus,
  /** Why it was skipped or failed, in one plain sentence. */
  reason: Schema.NullOr(Schema.String),
  /** The thread it runs in, once there is one. */
  threadId: Schema.NullOr(ThreadId),
  /** What its agent said when it finished with `scheduled_run_finish`. */
  summary: Schema.NullOr(Schema.String),
  /** An event task's run: the event that started it. */
  event: Schema.optionalKey(
    Schema.Struct({
      eventId: TrimmedNonEmptyString,
      /** "Issue #123 in acme/app labeled agent by @badcuban". */
      summary: Schema.String,
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledRun = typeof ScheduledRun.Type;

/** The settings a task is created with, and edited. */
export const ScheduledTaskDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: ProjectId,
  checkout: ScheduledTaskCheckout,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cadence: ScheduledTaskCadence,
  /** An IANA zone ("Europe/Madrid"); the computer's own when the task was created. */
  timeZone: TrimmedNonEmptyString,
  target: ScheduledTaskTarget,
});
export type ScheduledTaskDraft = typeof ScheduledTaskDraft.Type;

/**
 * An event task's address as the snapshot shows it; the address itself and
 * its secrets come from `scheduledTasks.webhookAddress` only.
 * `address`: `waiting_for_relay` until the relay has given the task an
 * address (it was made offline, say). `addressChanged`: the computer got a new
 * relay identity and the address with it; a sender set up by hand still uses
 * the old one. `github`: set up on GitHub by Threadlines ("Add to GitHub").
 */
export const ScheduledTaskWebhookState = Schema.Struct({
  address: Schema.Literals(["ready", "waiting_for_relay"]),
  addressChanged: Schema.Boolean,
  github: Schema.Boolean,
  signingSecretSet: Schema.Boolean,
  lastEventAt: Schema.NullOr(IsoDateTime),
  /**
   * A webhook Threadlines added on GitHub and has to remove (the task moved
   * to another repository or stopped being a GitHub task) but couldn't yet,
   * in plain words. It keeps trying; absent once it's gone.
   */
  githubProblem: Schema.optionalKey(Schema.String),
});
export type ScheduledTaskWebhookState = typeof ScheduledTaskWebhookState.Type;

export const ScheduledTask = Schema.Struct({
  ...ScheduledTaskDraft.fields,
  id: ScheduledTaskId,
  status: ScheduledTaskStatus,
  error: Schema.NullOr(Schema.String),
  /** The next scheduled run; null for manual, paused, errored and done tasks. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRun: Schema.NullOr(ScheduledRun),
  /** Runs not finished yet (launching, queued or started). */
  workingRuns: NonNegativeInt,
  /** The thread whose agent set it up; null for a task a person made. */
  originThreadId: Schema.NullOr(ThreadId),
  /** An event task's address and connection; absent for clock tasks. */
  webhook: Schema.optionalKey(ScheduledTaskWebhookState),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledTask = typeof ScheduledTask.Type;

/**
 * A change an agent asked to make to this computer's scheduled tasks, waiting
 * for the user ("Agents can start threads" set to ask first). Shown as a card
 * in the asking thread, with Allow and Deny.
 */
export const ScheduledTaskRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  /** The thread whose agent asked. */
  threadId: ThreadId,
  action: Schema.Literals(["create", "update"]),
  /** The task an update changes. */
  taskId: Schema.NullOr(ScheduledTaskId),
  /** The task's name, as the change leaves it. */
  name: TrimmedNonEmptyString,
  /** What it asks for, one plain line each ("Weekdays at 9:00", "Pause it"). */
  details: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
});
export type ScheduledTaskRequest = typeof ScheduledTaskRequest.Type;

export const ScheduledTasksSnapshot = Schema.Struct({
  tasks: Schema.Array(ScheduledTask),
  /** Agents' changes waiting for the user. */
  requests: Schema.Array(ScheduledTaskRequest),
  /** The computer's own time zone: a new task there starts in it. */
  timeZone: Schema.String,
  /**
   * The computer has event tasks and has been cut off from the relay for 10
   * minutes or more: events wait there (up to a day) until it's back.
   */
  eventsUnreachable: Schema.optionalKey(Schema.Boolean),
});
export type ScheduledTasksSnapshot = typeof ScheduledTasksSnapshot.Type;

export const ScheduledTaskCreateInput = ScheduledTaskDraft;
export type ScheduledTaskCreateInput = typeof ScheduledTaskCreateInput.Type;

/** A partial edit; `status` pauses or resumes (an errored task resumes by saving it). */
export const ScheduledTaskUpdateInput = Schema.Struct({
  id: ScheduledTaskId,
  name: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(ProjectId),
  checkout: Schema.optional(ScheduledTaskCheckout),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  cadence: Schema.optional(ScheduledTaskCadence),
  timeZone: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(ScheduledTaskTarget),
  status: Schema.optional(Schema.Literals(["active", "paused"])),
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
  /** Also archive every thread its runs started (never a continued thread). */
  archiveRunThreads: Schema.Boolean,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({ id: ScheduledTaskId });
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

/** The user allows or denies an agent's change (ScheduledTaskRequest). */
export const ScheduledTaskRespondRequestInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  allow: Schema.Boolean,
});
export type ScheduledTaskRespondRequestInput = typeof ScheduledTaskRespondRequestInput.Type;

/**
 * What a client can show. A client that leaves `webhook` out (one older than
 * event tasks) gets no event tasks and no event runs, so it never meets a
 * cadence or trigger it can't read.
 */
export const ScheduledTaskClientSupport = Schema.Array(Schema.Literal("webhook"));
export type ScheduledTaskClientSupport = typeof ScheduledTaskClientSupport.Type;

export const ScheduledTasksSubscribeInput = Schema.Struct({
  supports: Schema.optionalKey(ScheduledTaskClientSupport),
});
export type ScheduledTasksSubscribeInput = typeof ScheduledTasksSubscribeInput.Type;

/** A task's runs, newest first; `before` (a slot) pages back. */
export const ScheduledTaskListRunsInput = Schema.Struct({
  id: ScheduledTaskId,
  before: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt),
  /** See ScheduledTasksSubscribeInput. */
  supports: Schema.optionalKey(ScheduledTaskClientSupport),
});
export type ScheduledTaskListRunsInput = typeof ScheduledTaskListRunsInput.Type;

export const ScheduledTaskListRunsResult = Schema.Struct({
  runs: Schema.Array(ScheduledRun),
  hasMore: Schema.Boolean,
});
export type ScheduledTaskListRunsResult = typeof ScheduledTaskListRunsResult.Type;

// ---------------------------------------------------------------------------
// Event tasks (docs/design/event-tasks.md)
// ---------------------------------------------------------------------------

export const ScheduledTaskIdInput = Schema.Struct({ id: ScheduledTaskId });
export type ScheduledTaskIdInput = typeof ScheduledTaskIdInput.Type;

/**
 * Where an event task's events go. `relayUrl`: the public address through
 * the Threadlines relay; null until the relay has given one. `localUrl`: the
 * same task on this computer's own port, for senders that can reach it.
 */
export const ScheduledTaskWebhookAddress = Schema.Struct({
  relayUrl: Schema.NullOr(Schema.String),
  localUrl: Schema.String,
});
export type ScheduledTaskWebhookAddress = typeof ScheduledTaskWebhookAddress.Type;

/** Sets the signing secret: one the sender gave, or "generate" for a new one. */
export const ScheduledTaskSetSigningSecretInput = Schema.Struct({
  id: ScheduledTaskId,
  secret: Schema.Union([Schema.Literal("generate"), TrimmedNonEmptyString]),
});
export type ScheduledTaskSetSigningSecretInput = typeof ScheduledTaskSetSigningSecretInput.Type;

/** A signing secret, when asked for on purpose; null when none is set. */
export const ScheduledTaskSigningSecret = Schema.Struct({ secret: Schema.NullOr(Schema.String) });
export type ScheduledTaskSigningSecret = typeof ScheduledTaskSigningSecret.Type;

/**
 * What the form needs to set up a GitHub event task in a project: its GitHub
 * repository (from the origin remote), and who `gh` is signed in as.
 * `canConnect`: "Add to GitHub" can work (signed in, repository known);
 * whether the account may add webhooks is only known when it tries.
 */
export const ScheduledTaskGitHubContext = Schema.Struct({
  repository: Schema.NullOr(Schema.String),
  login: Schema.NullOr(Schema.String),
  canConnect: Schema.Boolean,
});
export type ScheduledTaskGitHubContext = typeof ScheduledTaskGitHubContext.Type;

export const ScheduledTaskGitHubContextInput = Schema.Struct({ projectId: ProjectId });
export type ScheduledTaskGitHubContextInput = typeof ScheduledTaskGitHubContextInput.Type;

/**
 * Where an event got to. `received`: stored, not looked at yet. `waiting`:
 * its run waits for room. `ran`: it started a run in a new thread. `joined`:
 * it went to a thread as a follow-up. `skipped`: a check stopped it (`reason`
 * says which). `failed`: its run couldn't be started.
 */
export const WebhookEventStatus = Schema.Literals([
  "received",
  "waiting",
  "ran",
  "joined",
  "skipped",
  "failed",
]);
export type WebhookEventStatus = typeof WebhookEventStatus.Type;

/** `test`: a dry run from the form. `replay`: "Run with this event". */
export const WebhookEventSource = Schema.Literals(["relay", "local", "test", "replay"]);
export type WebhookEventSource = typeof WebhookEventSource.Type;

export const WebhookEventRecord = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  taskId: ScheduledTaskId,
  receivedAt: IsoDateTime,
  source: WebhookEventSource,
  status: WebhookEventStatus,
  /** Why it stopped where it did, in one plain sentence. */
  reason: Schema.NullOr(Schema.String),
  /** "Issue #123 in acme/app labeled agent by @badcuban"; null when unknown. */
  summary: Schema.NullOr(Schema.String),
  /** GitHub's event and action ("issues.labeled"), when there is one. */
  eventName: Schema.NullOr(Schema.String),
  /** Who started it on the sender's side ("badcuban"), when known. */
  sender: Schema.NullOr(Schema.String),
  /** The thread its run started or joined. */
  threadId: Schema.NullOr(ThreadId),
  /** "Run with this event" is offered: verified, and its body still kept. */
  canReplay: Schema.Boolean,
});
export type WebhookEventRecord = typeof WebhookEventRecord.Type;

export const ScheduledTaskListWebhookEventsInput = Schema.Struct({
  id: ScheduledTaskId,
  /** Pages back from this receive time. */
  before: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt),
});
export type ScheduledTaskListWebhookEventsInput = typeof ScheduledTaskListWebhookEventsInput.Type;

export const ScheduledTaskListWebhookEventsResult = Schema.Struct({
  events: Schema.Array(WebhookEventRecord),
  hasMore: Schema.Boolean,
});
export type ScheduledTaskListWebhookEventsResult = typeof ScheduledTaskListWebhookEventsResult.Type;

export const ScheduledTaskWebhookEventInput = Schema.Struct({
  id: ScheduledTaskId,
  eventId: TrimmedNonEmptyString,
});
export type ScheduledTaskWebhookEventInput = typeof ScheduledTaskWebhookEventInput.Type;

/**
 * One event opened up. `headers` are the kept ones, with secrets hidden;
 * `body` is the start of the raw body; `message` is what the agent was (or, for
 * a dry run, would be) sent; `missingFields` the placeholders that filled in
 * empty.
 */
export const WebhookEventDetail = Schema.Struct({
  event: WebhookEventRecord,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
  missingFields: Schema.Array(Schema.String),
});
export type WebhookEventDetail = typeof WebhookEventDetail.Type;

/**
 * "Send a test event": a sample event for the task's trigger, sent as the
 * signed-in GitHub user so it passes "Only from". `startRun` false is a dry
 * run: every check, nothing started.
 */
export const ScheduledTaskTestWebhookInput = Schema.Struct({
  id: ScheduledTaskId,
  startRun: Schema.Boolean,
});
export type ScheduledTaskTestWebhookInput = typeof ScheduledTaskTestWebhookInput.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
