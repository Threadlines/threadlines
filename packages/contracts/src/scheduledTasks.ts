import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
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
 * When a task runs. Every kind but `manual` compiles to a 5-field cron
 * expression evaluated in the task's time zone (packages/shared
 * scheduledTasks.ts); `custom` is one, minute resolution only. `weekday` is
 * 0 (Sunday) to 6 (Saturday). `once` runs one time, on `date` at `time`; the
 * task is `done` after.
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
]);
export type ScheduledTaskCadence = typeof ScheduledTaskCadence.Type;
export type ScheduledTaskCadenceKind = ScheduledTaskCadence["kind"];

/** Where a new-thread run works: the project folder itself, or a new worktree per run. */
export const ScheduledTaskCheckout = Schema.Literals(["local", "worktree"]);
export type ScheduledTaskCheckout = typeof ScheduledTaskCheckout.Type;

/** What each run does: start a new thread, or send the prompt to one thread as a follow-up. */
export const ScheduledTaskTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new_thread") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
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

/** `catch_up`: the one run for slots missed while the computer was off or asleep. */
export const ScheduledRunTrigger = Schema.Literals(["schedule", "catch_up", "manual"]);
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

export const ScheduledTask = Schema.Struct({
  ...ScheduledTaskDraft.fields,
  id: ScheduledTaskId,
  status: ScheduledTaskStatus,
  error: Schema.NullOr(Schema.String),
  /** The next scheduled run; null for manual, paused and errored tasks. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRun: Schema.NullOr(ScheduledRun),
  /** Runs not finished yet (launching, queued or started). */
  workingRuns: NonNegativeInt,
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

/** A task's runs, newest first; `before` (a slot) pages back. */
export const ScheduledTaskListRunsInput = Schema.Struct({
  id: ScheduledTaskId,
  before: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt),
});
export type ScheduledTaskListRunsInput = typeof ScheduledTaskListRunsInput.Type;

export const ScheduledTaskListRunsResult = Schema.Struct({
  runs: Schema.Array(ScheduledRun),
  hasMore: Schema.Boolean,
});
export type ScheduledTaskListRunsResult = typeof ScheduledTaskListRunsResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
