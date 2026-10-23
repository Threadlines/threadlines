/**
 * The schedule tools, described to a model (docs/design/fleet.md, Part 6,
 * "Agent tools").
 *
 * They live on the room endpoint beside the thread tools and follow the same
 * house rules (roomTools.ts): every decision is an `outcome`, never an
 * error. `schedule_list`, `schedule_create` and `schedule_update` follow the
 * "Agents can start threads" setting: off refuses them, ask records the
 * change for the user to allow, auto applies it. `scheduled_run_finish` is a
 * scheduled run's own: only its thread's runtime gets it.
 */
import {
  ScheduledRunStatus,
  ScheduledTaskCadence,
  ScheduledTaskStatus,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { McpRoomInvocation } from "./roomTools.ts";

const dependencies = [McpRoomInvocation];

export const AgentScheduledTask = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The schedule in a few words ("Weekdays at 9:00"). */
  schedule: Schema.String,
  cadence: ScheduledTaskCadence,
  timeZone: Schema.String,
  status: ScheduledTaskStatus,
  /** Why it stopped, when `status` is `error`. */
  error: Schema.optional(Schema.String),
  nextRun: Schema.NullOr(Schema.String),
  lastRun: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      status: ScheduledRunStatus,
      reason: Schema.optional(Schema.String),
      threadId: Schema.optional(Schema.String),
    }),
  ),
  /** `this_thread`: each run continues the thread that set it up. */
  eachRun: Schema.Literals(["new_thread", "this_thread", "another_thread"]),
  runsIn: Schema.Literals(["local", "worktree"]),
  prompt: Schema.String,
});
export type AgentScheduledTask = typeof AgentScheduledTask.Type;

export const ScheduleListResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "off", "not_allowed", "refused"]),
  detail: Schema.optional(Schema.String),
  tasks: Schema.Array(AgentScheduledTask),
  /** The time now on this computer, for working out "tomorrow at 8". */
  now: Schema.optional(
    Schema.Struct({
      /** "2026-10-21 14:05, Wednesday", wall time in `timeZone`. */
      localTime: Schema.String,
      timeZone: Schema.String,
    }),
  ),
});
export type ScheduleListResult = typeof ScheduleListResult.Type;

export const ScheduleChangeResult = Schema.Struct({
  /**
   * `created` / `updated`: done. `asked_user`: a card in this thread asks
   * the user, and the change is made when they allow it.
   */
  outcome: Schema.Literals([
    "created",
    "updated",
    "asked_user",
    "off",
    "not_allowed",
    "refused",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
  task: Schema.optional(AgentScheduledTask),
  /** `asked_user`: the request the card answers, and the task it makes or changes. */
  requestId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
export type ScheduleChangeResult = typeof ScheduleChangeResult.Type;

export const ScheduledRunFinishResult = Schema.Struct({
  outcome: Schema.Literals([
    "recorded",
    "not_a_run",
    "not_this_turn",
    "already_ended",
    "not_allowed",
  ]),
  detail: Schema.optional(Schema.String),
});
export type ScheduledRunFinishResult = typeof ScheduledRunFinishResult.Type;

const CadenceParameter = ScheduledTaskCadence.annotate({
  description:
    'When it runs, in its time zone: {kind:"once", date:"YYYY-MM-DD", time:{hour, minute}} (one time, for "tomorrow at 8am"; the task is done after; schedule_list says the date and time now), {kind:"manual"} (only when someone starts it), {kind:"hourly", minute}, {kind:"daily", time:{hour, minute}}, {kind:"weekdays", time}, {kind:"weekly", weekday (0 Sunday to 6 Saturday), time}, or {kind:"custom", cron} with a 5-field cron expression (minute hour day-of-month month day-of-week).',
});

const TimeZoneParameter = Schema.String.annotate({
  description: 'An IANA time zone such as "Europe/Madrid". Leave out for this computer\'s own.',
});

const changesSchedules = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false) as T;

export const ScheduleListTool = Tool.make("schedule_list", {
  description:
    "This project's scheduled tasks on this computer: each one's id, name, schedule, status (active, paused, done for a one-time task that ran, or error with why), next run, last run and its instructions, and the date and time now on this computer. Scheduled tasks start threads at set times while Threadlines is running on this computer.",
  // No `parameters`: Tool.make's default lists as an empty object. An empty
  // `Schema.Struct({})` lists as "object or array", and Claude then rejects
  // the whole room endpoint's tool list.
  success: ScheduleListResult,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Title, "List scheduled tasks");

export const ScheduleCreateTool = changesSchedules(
  Tool.make("schedule_create", {
    description:
      "Create a scheduled task in this project. Use it whenever the user wants work done later or on a schedule: the task shows on Threadlines' Scheduled page, where the user manages it. At each scheduled time it starts a new thread with `prompt` as its first message (each run sees only the prompt, so make it self-contained), or with `each_run: \"this_thread\"` sends it to this thread as a follow-up. Runs use your model unless `agent` names another, and your current access, never more. It runs while Threadlines is running on this computer; a time missed while it was off or asleep gets one catch-up run. Depending on the user's settings the task is created at once or a card asks the user first (`asked_user`): tell the user it waits for their OK, and you'll hear their answer at your next turn.",
    parameters: Schema.Struct({
      name: Schema.String.annotate({ description: "A short name for the task." }),
      prompt: Schema.String.annotate({ description: "What each run should do." }),
      schedule: CadenceParameter,
      time_zone: Schema.optional(TimeZoneParameter),
      each_run: Schema.optional(
        Schema.Literals(["new_thread", "this_thread"]).annotate({
          description: 'Default "new_thread".',
        }),
      ),
      runs_in: Schema.optional(
        Schema.Literals(["local", "worktree"]).annotate({
          description:
            'Where a new thread works: "local", the project folder as it is (the default), or "worktree", a new git worktree for each run.',
        }),
      ),
      agent: Schema.optional(
        Schema.Struct({
          instanceId: Schema.String.annotate({ description: "From thread_agents." }),
          model: Schema.String.annotate({ description: "From thread_agents." }),
        }),
      ),
    }),
    success: ScheduleChangeResult,
    dependencies,
  }).annotate(Tool.Title, "Create a scheduled task"),
);

export const ScheduleUpdateTool = changesSchedules(
  Tool.make("schedule_update", {
    description:
      "Change one of this project's scheduled tasks (an id from schedule_list): its name, instructions, schedule, time zone or where its threads work, or pause and resume it with `paused`. Fields left out stay as they are. Depending on the user's settings the change is made at once or a card asks the user first (`asked_user`): tell the user it waits for their OK, and you'll hear their answer at your next turn.",
    parameters: Schema.Struct({
      id: Schema.String.annotate({ description: "The task's id, from schedule_list." }),
      name: Schema.optional(Schema.String),
      prompt: Schema.optional(Schema.String),
      schedule: Schema.optional(CadenceParameter),
      time_zone: Schema.optional(TimeZoneParameter),
      runs_in: Schema.optional(Schema.Literals(["local", "worktree"])),
      paused: Schema.optional(
        Schema.Boolean.annotate({ description: "true pauses it, false resumes it." }),
      ),
    }),
    success: ScheduleChangeResult,
    dependencies,
  }).annotate(Tool.Title, "Change a scheduled task"),
);

export const ScheduledRunFinishTool = changesSchedules(
  Tool.make("scheduled_run_finish", {
    description:
      "This thread is a scheduled task's run. When you are done, say whether there was anything worth the user's attention: `nothing_to_report: true` files this thread away as read when your turn ends, so a quiet run doesn't wait in the user's inbox; `summary` is one line for the task's history. Only from this run's own turn.",
    parameters: Schema.Struct({
      nothing_to_report: Schema.Boolean,
      summary: Schema.optional(
        Schema.String.annotate({ description: "One line on what this run found or did." }),
      ),
    }),
    success: ScheduledRunFinishResult,
    dependencies,
  }).annotate(Tool.Title, "Finish a scheduled run"),
);

/**
 * The short note a thread's own runtime gets at session start when it has
 * the room tools: work the user wants done later or on a schedule belongs in
 * Threadlines' scheduled tasks, where the user sees it. The rules are in the
 * tools' descriptions. Never for a side runtime, which has no schedule tools.
 */
export function buildScheduleInstructions(input: {
  /** What precedes the tools' names for this provider. */
  readonly toolPrefix: string;
  /** Claude: its own schedulers would keep the work out of Threadlines. */
  readonly claude?: boolean;
}): string {
  const tool = (name: string) => `\`${input.toolPrefix}${name}\``;
  const lines = [
    `When the user wants work done later or on a schedule ("every weekday at 9", "each Monday", "tomorrow at 8am"), make it a Threadlines scheduled task with ${tool("schedule_create")}. At each time it starts an agent on your prompt while Threadlines is running on this computer, and the user sees and manages it on the Scheduled page. ${tool("schedule_list")} and ${tool("schedule_update")} find, change, pause and resume the ones that exist.`,
    ...(input.claude === true
      ? [
          "Don't use CronCreate, ScheduleWakeup or cloud routines (the schedule skill) for that: they live only in this conversation or outside Threadlines, where the user won't find them. They are still the way to check back on your own work later in this conversation.",
        ]
      : []),
  ];
  return `<threadlines_schedules>\n${lines.join("\n")}\n</threadlines_schedules>`;
}

export const ScheduleToolkit = Toolkit.make(
  ScheduleListTool,
  ScheduleCreateTool,
  ScheduleUpdateTool,
  ScheduledRunFinishTool,
);
