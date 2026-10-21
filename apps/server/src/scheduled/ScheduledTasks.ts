/**
 * ScheduledTasks: this computer's scheduled tasks and the scheduler that runs
 * them (docs/design/fleet.md, Part 6, with its rev 2 and rev 3 changes).
 *
 * - Every 30 seconds each active task whose next slot has come is claimed in
 *   one transaction (ScheduledTaskRepository.claimSlot): its next slot moves
 *   on and the slot's run row is recorded, launching or skipped. Of several
 *   slots that passed only the latest runs: on time when it is under 90
 *   seconds late, as the one catch-up run when it is under 7 days late; the
 *   slots before it are recorded as one skipped row ("the computer was off
 *   or asleep").
 * - A launching run copies its task's settings into the row, and launches in
 *   stages from that copy alone, with ids derived from its task and slot: a
 *   new thread through the staged ThreadBootstrap (create, worktree, setup,
 *   turn), or a follow-up queued in the task's thread. A crash anywhere
 *   resumes the launch at startup and never makes a second thread or message.
 * - A run ends with the turn its own message started (ScheduledRunTurnEnds),
 *   or, when that is missed (a session that never started, a restart), with
 *   what the thread's turns say when a sweep looks.
 * - `scheduled_run_finish` (the run's agent) records whether there was
 *   anything to report; the run's end applies it, and wraps a new thread
 *   that had nothing to report.
 *
 * Runs work while Threadlines is running on this computer; nothing wakes it.
 */
import {
  type AgentThreadsMode,
  type ChildThreadLaunch,
  type ChildThreadWorkspace,
  type OrchestrationEvent,
  type ProjectId,
  type RuntimeMode,
  type ScheduledRun,
  ScheduledTaskError,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskDeleteInput,
  ScheduledTaskId,
  type ScheduledTaskListRunsInput,
  type ScheduledTaskListRunsResult,
  type ScheduledTaskRequest,
  type ScheduledTaskRespondRequestInput,
  type ScheduledTaskRunNowInput,
  type ScheduledTasksSnapshot,
  type ScheduledTaskUpdateInput,
  type ThreadId,
  type ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { exceedsRuntimeMode, saferRuntimeMode } from "@threadlines/shared/runtimeMode";
import { agentThreadsMode } from "@threadlines/shared/serverSettings";
import {
  cadenceSaveRefusal,
  compileCadence,
  describeCadence,
  dueSlots,
  formatWallTime,
  nextSlotOf,
  sameCadence,
  SCHEDULED_TASK_CATCH_UP_WINDOW_MS,
  SCHEDULED_TASK_ON_TIME_MS,
  upcomingSlots,
} from "@threadlines/shared/scheduledTasks";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ScheduledRunTurnEnds,
  type ScheduledRunTurnEndsShape,
} from "../orchestration/Services/ScheduledRunTurnEnds.ts";
import {
  ScheduledTaskNotes,
  type ScheduledTaskNotesShape,
} from "../orchestration/Services/ScheduledTaskNotes.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { derivedUuid } from "../orchestration/childRequestIds.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  isWorkingRun,
  type ScheduledRunLaunch,
  type ScheduledRunRow,
  type ScheduledTaskChange,
  ScheduledTaskRepository,
  type ScheduledTaskRepositoryShape,
  type ScheduledTaskRequestRow,
  type ScheduledTaskRow,
  WORKING_RUN_STATUSES,
} from "./ScheduledTaskRepository.ts";
import {
  scheduledRunCommandId,
  scheduledRunKey,
  scheduledRunMessageId,
  scheduledRunThreadId,
} from "./scheduledRunIds.ts";

/** How often the scheduler looks for due slots and finished runs. */
export const SCHEDULER_TICK = Duration.seconds(30);
/** A run whose turn never started, with its thread idle this long, has failed. */
const NEVER_STARTED_GRACE_MS = 60_000;
const GIT_TIMEOUT_MS = 60_000;
/** An agent's change that nobody answered within a day expires. */
const REQUEST_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RUN_PAGE = 50;
/** Drivers that take the Threadlines tools on every session (ACP agents only sometimes). */
const NATIVE_TOOL_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "opencode",
  "muse",
  "pi",
]);

export const SKIP_REASON_MISSED = "The computer was off or asleep.";

/**
 * A session's error as one plain sentence for the run's history: its first
 * line, without the error class and call-site prefixes a provider adds
 * ("ProviderValidationError: ... startSession: Provider instance 'codex' is
 * disabled" reads "Provider instance 'codex' is disabled").
 */
export const plainRunError = (error: string | null | undefined, fallback: string): string => {
  const firstLine = error?.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return fallback;
  const parts = firstLine.split(": ");
  const last = parts.at(-1)?.trim() ?? "";
  const plain = last.length >= 12 ? last : firstLine;
  return plain.length > 300 ? `${plain.slice(0, 297)}...` : plain;
};
const missedReason = (count: number) =>
  count === 1 ? SKIP_REASON_MISSED : `Missed ${count} runs while the computer was off or asleep.`;

export interface ScheduledTasksShape {
  readonly snapshot: Effect.Effect<ScheduledTasksSnapshot, ScheduledTaskError>;
  /** The snapshot now, then again after every change. */
  readonly changes: Stream.Stream<ScheduledTasksSnapshot, ScheduledTaskError>;
  readonly listRuns: (
    input: ScheduledTaskListRunsInput,
  ) => Effect.Effect<ScheduledTaskListRunsResult, ScheduledTaskError>;
  readonly create: (
    input: ScheduledTaskCreateInput,
  ) => Effect.Effect<ScheduledTask, ScheduledTaskError>;
  readonly update: (
    input: ScheduledTaskUpdateInput,
  ) => Effect.Effect<ScheduledTask, ScheduledTaskError>;
  /**
   * Deletes a task and its history. Returns the threads its runs started
   * (never a continued thread) that exist, for `archiveRunThreads`.
   */
  readonly remove: (
    input: ScheduledTaskDeleteInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ScheduledTaskError>;
  readonly runNow: (
    input: ScheduledTaskRunNowInput,
  ) => Effect.Effect<ScheduledRun, ScheduledTaskError>;
  /**
   * An agent's change to the tasks (schedule_create, schedule_update),
   * checked first: applied at once (`auto`) or recorded for the user to
   * answer (`ask`). `requestId` is the call's own, so a retried call finds
   * its first one's request or task.
   */
  readonly propose: (input: {
    readonly requestId: string;
    readonly threadId: ThreadId;
    /** The room agent asking; null for the thread's own. */
    readonly participantId: ThreadParticipantId | null;
    /**
     * "Agents can start threads", read live: after the change is checked
     * and right before it is written, so a setting changed meanwhile wins.
     */
    readonly mode: Effect.Effect<AgentThreadsMode>;
    /** The asking agent's own access: a task with more is the user's to change. */
    readonly callerRuntimeMode: RuntimeMode;
    readonly change: ScheduledTaskChange;
  }) => Effect.Effect<
    | { readonly outcome: "off" }
    | { readonly outcome: "applied"; readonly task: ScheduledTask }
    | {
        readonly outcome: "asked_user";
        readonly requestId: string;
        /** The task it makes or changes once the user allows it. */
        readonly taskId: ScheduledTaskId;
        readonly name: string;
      },
    ScheduledTaskError
  >;
  /**
   * What the user answered to one agent's changes since its last turn: one
   * line each, for that turn to carry (ScheduledTaskNotes).
   */
  readonly pendingNotes: ScheduledTaskNotesShape["pendingFor"];
  /** Those answers went out with a turn the provider took. */
  readonly notesDelivered: ScheduledTaskNotesShape["delivered"];
  /** The threads whose agent's change waits for the user; none on a failed read. */
  readonly waitingThreadIds: Effect.Effect<ReadonlySet<ThreadId>>;
  /** The user allows or denies an agent's change. */
  readonly respondRequest: (
    input: ScheduledTaskRespondRequestInput,
  ) => Effect.Effect<void, ScheduledTaskError>;
  /** A task by id, as the snapshot has it. */
  readonly getTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | undefined, ScheduledTaskError>;
  /**
   * What a run's agent said (`scheduled_run_finish`), from the turn
   * `turnId` in `threadId`. Accepted only from the run's own turn: the turn
   * its message started.
   */
  readonly recordFinish: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly nothingToReport: boolean;
    readonly summary: string | null;
  }) => Effect.Effect<"recorded" | "not_a_run" | "not_this_turn" | "already_ended">;
  readonly onTurnEnd: ScheduledRunTurnEndsShape["onTurnEnd"];
  /** One scheduler pass now: runs that ended, then due slots, then launches to resume. */
  readonly tick: Effect.Effect<void>;
  /** Settle what the previous process left, then tick every 30 seconds. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ScheduledTasks extends Context.Service<ScheduledTasks, ScheduledTasksShape>()(
  "threadlines/scheduled/ScheduledTasks",
) {}

const taskError = (detail: string) => new ScheduledTaskError({ detail });

/** Why an agent's change to a task waits for the user even when agents may act alone. */
const ABOVE_CALLER_DETAIL = "This task runs with more access than the agent asking to change it.";

/** An edit that only pauses the task. */
const isPauseOnly = (input: ScheduledTaskUpdateInput): boolean =>
  input.status === "paused" &&
  Object.entries(input).every(
    ([key, value]) => key === "id" || key === "status" || value === undefined,
  );

/** Tries at saving an edit over a task other writes keep moving. */
const SAVE_ATTEMPTS = 3;
const KEPT_CHANGING = "The task kept changing while it was being saved. Try again.";

const toRun = (row: ScheduledRunRow): ScheduledRun => ({
  taskId: row.taskId,
  slotUtc: row.slotUtc,
  trigger: row.trigger,
  status: row.status,
  reason: row.reason,
  threadId: row.threadId,
  summary: row.summary,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRequest = (row: ScheduledTaskRequestRow): ScheduledTaskRequest => ({
  requestId: row.requestId,
  threadId: row.threadId,
  action: row.action,
  taskId: row.taskId,
  name: row.payload.name,
  details: row.payload.details,
  createdAt: row.createdAt,
});

/** What a new task would be, in plain lines for the user's yes. */
const createDetails = (row: ScheduledTaskRow): ReadonlyArray<string> => [
  describeCadence(row.cadence),
  row.target.kind === "thread"
    ? "Each run continues this thread"
    : row.checkout === "worktree"
      ? "Each run starts a new thread in a new worktree"
      : "Each run starts a new thread in the project folder",
  `Instructions: ${row.prompt.length > 160 ? `${row.prompt.slice(0, 157)}...` : row.prompt}`,
];

/** What an edit would change, in plain lines for the user's yes. */
const updateDetails = (current: ScheduledTaskRow, row: ScheduledTaskRow): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (row.name !== current.name) lines.push(`Rename it from "${current.name}"`);
  // A done task made active again is rescheduled: its new schedule says so.
  if (row.status !== current.status && current.status !== "done") {
    lines.push(row.status === "paused" ? "Pause it" : "Resume it");
  }
  const schedule = describeCadence(row.cadence);
  if (schedule !== describeCadence(current.cadence)) {
    lines.push(`Run it ${schedule.charAt(0).toLowerCase()}${schedule.slice(1)}`);
  }
  if (row.timeZone !== current.timeZone) lines.push(`Use the ${row.timeZone} time zone`);
  if (row.prompt !== current.prompt) {
    lines.push(
      `New instructions: ${row.prompt.length > 160 ? `${row.prompt.slice(0, 157)}...` : row.prompt}`,
    );
  }
  if (row.checkout !== current.checkout) {
    lines.push(row.checkout === "worktree" ? "Run in a new worktree" : "Run in the project folder");
  }
  return lines.length > 0 ? lines : ["No change"];
};

const toTask = (
  row: ScheduledTaskRow,
  summary: { readonly last: ScheduledRunRow | null; readonly working: number } | undefined,
): ScheduledTask => ({
  id: row.id,
  name: row.name,
  prompt: row.prompt,
  projectId: row.projectId,
  checkout: row.checkout,
  modelSelection: row.modelSelection,
  runtimeMode: row.runtimeMode,
  interactionMode: row.interactionMode,
  cadence: row.cadence,
  timeZone: row.timeZone,
  target: row.target,
  status: row.status,
  error: row.error,
  nextRunAt: row.status === "active" ? row.nextSlotUtc : null,
  lastRun: summary?.last ? toRun(summary.last) : null,
  workingRuns: summary?.working ?? 0,
  originThreadId: row.originThreadId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const launchOf = (task: ScheduledTaskRow, projectRoot: string | null): ScheduledRunLaunch => ({
  taskName: task.name,
  prompt: task.prompt,
  projectId: task.projectId,
  checkout: task.checkout,
  workspace: null,
  modelSelection: task.modelSelection,
  runtimeMode: task.runtimeMode,
  interactionMode: task.interactionMode,
  target: task.target,
  projectRoot,
});

/** The first message of a new-thread run: a short note, then the task's own words. */
export const runMessageText = (launch: ScheduledRunLaunch, withFinishTool: boolean) =>
  [
    `Scheduled task: ${launch.taskName}.${
      withFinishTool
        ? " If there is nothing to report, call scheduled_run_finish with nothing_to_report: true."
        : ""
    }`,
    "",
    launch.prompt,
  ].join("\n");

const make = Effect.gen(function* () {
  const repo = yield* ScheduledTaskRepository;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const bootstrap = yield* ThreadBootstrap;
  const turns = yield* ProjectionTurnRepository;
  const providers = yield* ProviderRegistry;
  const git = yield* GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService;
  const settings = yield* ServerSettingsService;

  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  /** Launches running in this process, so a tick never starts a second one. */
  const launching = new Set<string>();
  /** Threads with a run still working: the domain events worth reading. */
  let workingThreads = new Set<ThreadId>();

  const runKey = (run: Pick<ScheduledRunRow, "taskId" | "slotUtc">) =>
    `${run.taskId}\u0000${run.slotUtc}`;

  const nowMillis = Clock.currentTimeMillis;
  const nowIso = Effect.map(nowMillis, (millis) => new Date(millis).toISOString());

  const storageError = (what: string) => () => taskError(`Couldn't ${what}.`);

  const refreshWorkingThreads = repo.listWorkingRuns.pipe(
    Effect.map((runs) => {
      workingThreads = new Set(
        runs.flatMap((run) => (run.threadId !== null ? [run.threadId] : [])),
      );
    }),
    Effect.ignore,
  );

  /** After any write: the index of working threads, and the clients' snapshot. */
  const changedRuns = refreshWorkingThreads.pipe(Effect.andThen(notify));

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  const snapshot: ScheduledTasksShape["snapshot"] = Effect.gen(function* () {
    const [tasks, summaries, requests] = yield* Effect.all([
      repo.listTasks,
      repo.runSummaries,
      repo.listWaitingRequests,
    ]);
    return {
      tasks: tasks.map((task) => toTask(task, summaries.get(task.id))),
      requests: requests.map(toRequest),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }).pipe(Effect.mapError(storageError("read the scheduled tasks")));

  const getTask: ScheduledTasksShape["getTask"] = (id) =>
    snapshot.pipe(Effect.map((current) => current.tasks.find((task) => task.id === id)));

  const changes: ScheduledTasksShape["changes"] = Stream.concat(
    Stream.make(undefined),
    Stream.fromPubSub(changed),
  ).pipe(
    Stream.debounce(Duration.millis(100)),
    Stream.mapEffect(() => snapshot),
  );

  const listRuns: ScheduledTasksShape["listRuns"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(input.limit ?? DEFAULT_RUN_PAGE, 200);
      const rows = yield* repo.listRuns({
        taskId: input.id,
        before: input.before,
        limit: limit + 1,
      });
      return { runs: rows.slice(0, limit).map(toRun), hasMore: rows.length > limit };
    }).pipe(Effect.mapError(storageError("read the task's runs")));

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const readProject = (projectId: ProjectId) =>
    snapshots.getProjectShellById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  /** The task's next slot after `now`, or why it can't be saved. */
  const firstSlot = (task: Pick<ScheduledTaskRow, "cadence" | "timeZone">, now: number) => {
    const refusal = cadenceSaveRefusal(task.cadence, task.timeZone, new Date(now));
    if (refusal !== null) return Result.fail(refusal);
    const next = upcomingSlots(task.cadence, task.timeZone, new Date(now), 1);
    return Result.isFailure(next)
      ? Result.fail(next.failure)
      : Result.succeed(next.success[0]?.toISOString() ?? null);
  };

  /** Refuses a task whose project, agent or thread this computer doesn't have. */
  const checkDraft = (task: ScheduledTaskRow) =>
    Effect.gen(function* () {
      const project = yield* readProject(task.projectId);
      if (project === undefined) {
        return yield* taskError("That project isn't on this computer.");
      }
      if (project.kind === "general-chat" && task.checkout === "worktree") {
        return yield* taskError("General Chats has no repository to make a worktree in.");
      }
      const all = yield* providers.getProviders;
      if (!all.some((provider) => provider.instanceId === task.modelSelection.instanceId)) {
        return yield* taskError("That agent isn't set up on this computer.");
      }
      if (task.target.kind === "thread") {
        const thread = yield* readThread(task.target.threadId);
        if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
          return yield* taskError("The thread it should continue isn't open on this computer.");
        }
        if (thread.projectId !== task.projectId) {
          return yield* taskError("The thread it should continue is in another project.");
        }
        if ((thread.remoteOrigin ?? null) !== null) {
          return yield* taskError(
            "A thread another computer started can't be continued on a schedule.",
          );
        }
      }
    });

  /** The task with its schedule worked out from now: active, paused, or an error. */
  const scheduled = (
    task: ScheduledTaskRow,
    now: number,
  ): Effect.Effect<ScheduledTaskRow, ScheduledTaskError> => {
    // One that won't run (paused) needs a schedule that parses, not a next
    // run: a one-time task whose time passed can still be paused.
    if (task.status !== "active") {
      const compiled = compileCadence(task.cadence, task.timeZone);
      return Result.isFailure(compiled)
        ? Effect.fail(taskError(compiled.failure))
        : Effect.succeed({ ...task, error: null, nextSlotUtc: null });
    }
    const first = firstSlot(task, now);
    if (Result.isFailure(first)) return Effect.fail(taskError(first.failure));
    return Effect.succeed({
      ...task,
      error: null,
      nextSlotUtc: task.status === "active" ? first.success : null,
    });
  };

  /**
   * A new task from its settings, checked and scheduled from now; not saved.
   * `origin` is the thread whose agent set it up, if one did.
   */
  const prepareCreate = (
    input: ScheduledTaskCreateInput,
    now: number,
    made?: { readonly id: ScheduledTaskId; readonly origin: ThreadId },
  ) =>
    Effect.gen(function* () {
      const at = new Date(now).toISOString();
      const draft: ScheduledTaskRow = {
        ...input,
        id: made?.id ?? ScheduledTaskId.make(crypto.randomUUID()),
        status: "active",
        error: null,
        nextSlotUtc: null,
        originThreadId: made?.origin ?? null,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      };
      yield* checkDraft(draft);
      return yield* scheduled(draft, now);
    });

  /** A task as an edit leaves it, checked and scheduled; not saved. */
  const prepareUpdate = (input: ScheduledTaskUpdateInput, now: number) =>
    Effect.gen(function* () {
      const found = yield* repo
        .getTask(input.id)
        .pipe(Effect.mapError(storageError("read the task")));
      if (Option.isNone(found)) return yield* taskError("That task was deleted.");
      const current = found.value;
      const { id: _id, status, ...fields } = input;
      // A schedule sent back as it was (a form sends every field) is no change.
      const timesChanged =
        (fields.cadence !== undefined && !sameCadence(fields.cadence, current.cadence)) ||
        (fields.timeZone !== undefined && fields.timeZone !== current.timeZone);
      const edited: ScheduledTaskRow = {
        ...current,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
        // A paused task stays paused through an edit; saving an errored one
        // resumes it, and so does giving a done one a new schedule.
        status:
          status ??
          (current.status === "error" || (current.status === "done" && timesChanged)
            ? "active"
            : current.status),
        updatedAt: new Date(now).toISOString(),
      };
      const settingsChanged = Object.values(fields).some((value) => value !== undefined);
      if (settingsChanged) yield* checkDraft(edited);
      // The next slot is worked out again when the schedule or the status
      // changed; otherwise it stays, so a rename never skips a due slot.
      const scheduleChanged =
        timesChanged || edited.status !== current.status || current.status === "error";
      const row = scheduleChanged ? yield* scheduled(edited, now) : edited;
      return { current, row };
    });

  const create: ScheduledTasksShape["create"] = (input) =>
    Effect.gen(function* () {
      const row = yield* prepareCreate(input, yield* nowMillis);
      yield* repo.insertTask(row).pipe(Effect.mapError(storageError("save the task")));
      yield* notify;
      return toTask(row, undefined);
    });

  /**
   * An edit, saved only over the task it was worked out from: one that lost
   * to another write (a slot claimed meanwhile) is worked out again from a
   * fresh read, so neither undoes the other.
   */
  const update: ScheduledTasksShape["update"] = (input) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
        const { row } = yield* prepareUpdate(input, yield* nowMillis);
        const saved = yield* repo
          .saveTask(row)
          .pipe(Effect.mapError(storageError("save the task")));
        if (!saved) continue;
        yield* notify;
        const summaries = yield* repo.runSummaries.pipe(Effect.orElseSucceed(() => new Map()));
        return toTask(row, summaries.get(row.id));
      }
      return yield* taskError(KEPT_CHANGING);
    });

  /** The task an agent's create makes: one per request, whatever retries. */
  const requestTaskId = (requestId: string) =>
    ScheduledTaskId.make(derivedUuid("scheduled-task-request", requestId));

  /** Saves an agent's change (from a thread's agent), checked again now. */
  const applyChange = (requestId: string, change: ScheduledTaskChange, origin: ThreadId) =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      if (change.kind === "create") {
        const id = requestTaskId(requestId);
        const existing = yield* repo
          .getTask(id)
          .pipe(Effect.mapError(storageError("read the task")));
        if (Option.isSome(existing)) return toTask(existing.value, undefined);
        const row = yield* prepareCreate(change.draft, now, { id, origin });
        yield* repo.insertTask(row).pipe(Effect.mapError(storageError("save the task")));
        yield* notify;
        return toTask(row, undefined);
      }
      return yield* update(change.input);
    });

  const propose: ScheduledTasksShape["propose"] = (input) =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      const { change } = input;
      if (
        change.kind === "create" &&
        exceedsRuntimeMode(change.draft.runtimeMode, input.callerRuntimeMode)
      ) {
        return yield* taskError("A task can't run with more access than the agent setting it up.");
      }
      // Checked before anyone is asked: the user only sees changes that can be made.
      const preview =
        change.kind === "create"
          ? yield* prepareCreate(change.draft, now).pipe(
              Effect.map((row) => ({
                name: row.name,
                details: createDetails(row),
                taskId: null,
                aboveCaller: false,
              })),
            )
          : yield* prepareUpdate(change.input, now).pipe(
              Effect.map(({ current, row }) => ({
                name: row.name,
                details: updateDetails(current, row),
                taskId: row.id,
                // Pausing only takes work away; anything else on a task with
                // more access than the agent asking is the user's call.
                aboveCaller:
                  exceedsRuntimeMode(current.runtimeMode, input.callerRuntimeMode) &&
                  !isPauseOnly(change.input),
              })),
            );
      const mode = yield* input.mode;
      if (mode === "off") return { outcome: "off" as const };
      if (mode === "auto" && !preview.aboveCaller) {
        return {
          outcome: "applied" as const,
          task: yield* applyChange(input.requestId, input.change, input.threadId),
        };
      }
      yield* repo
        .insertRequest({
          requestId: input.requestId,
          threadId: input.threadId,
          participantId: input.participantId,
          action: input.change.kind,
          taskId: preview.taskId,
          payload: {
            change: input.change,
            name: preview.name,
            details: preview.aboveCaller
              ? [...preview.details, ABOVE_CALLER_DETAIL]
              : preview.details,
          },
          createdAt: new Date(now).toISOString(),
        })
        .pipe(Effect.mapError(storageError("record the request")));
      yield* notify;
      return {
        outcome: "asked_user" as const,
        requestId: input.requestId,
        taskId: preview.taskId ?? requestTaskId(input.requestId),
        name: preview.name,
      };
    });

  /** What allowing an agent's request writes, checked from now: the new task or the edit. */
  const allowedWrite = (
    request: ScheduledTaskRequestRow,
    now: number,
  ): Effect.Effect<
    Parameters<ScheduledTaskRepositoryShape["allowRequest"]>[0]["write"],
    ScheduledTaskError
  > =>
    Effect.gen(function* () {
      const change = request.payload.change;
      if (change.kind === "create") {
        const row = yield* prepareCreate(change.draft, now, {
          id: requestTaskId(request.requestId),
          origin: request.threadId,
        });
        return { kind: "insert", row };
      }
      const { row } = yield* prepareUpdate(change.input, now);
      return { kind: "save", row };
    });

  const respondRequest: ScheduledTasksShape["respondRequest"] = (input) =>
    Effect.gen(function* () {
      const found = yield* repo
        .getRequest(input.requestId)
        .pipe(Effect.mapError(storageError("read the request")));
      if (Option.isNone(found)) return yield* taskError("That request is gone.");
      const request = found.value;
      if (request.status !== "waiting") {
        return yield* taskError("That request was already answered.");
      }
      const decide = (status: "allowed" | "denied" | "failed", detail: string | null) =>
        Effect.gen(function* () {
          yield* repo
            .decideRequest({ requestId: request.requestId, status, detail, now: yield* nowIso })
            .pipe(Effect.mapError(storageError("record the answer")));
          yield* notify;
        });
      if (!input.allow) return yield* decide("denied", null);
      // The answer and the change are one write, so they can never disagree:
      // an answer that came first (Not now, a day passing) leaves the tasks
      // as they were, and a change that can't be made is the answer.
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
        const now = yield* nowMillis;
        const prepared = yield* allowedWrite(request, now).pipe(Effect.result);
        if (Result.isFailure(prepared)) {
          yield* decide("failed", prepared.failure.detail);
          return yield* Effect.fail(prepared.failure);
        }
        // Read after the change was checked, right before it is written: a
        // setting turned off meanwhile wins.
        const mode = yield* settings.getSettings.pipe(
          Effect.map(agentThreadsMode),
          Effect.orElseSucceed(() => "off" as const),
        );
        if (mode === "off") {
          const detail =
            "Agents can't change scheduled tasks while starting threads is turned off.";
          yield* decide("denied", detail);
          return yield* taskError(detail);
        }
        const outcome = yield* repo
          .allowRequest({
            requestId: request.requestId,
            write: prepared.success,
            now: new Date(now).toISOString(),
          })
          .pipe(Effect.mapError(storageError("allow the request")));
        if (outcome === "answered") return yield* taskError("That request was already answered.");
        if (outcome === "allowed") {
          yield* notify;
          return;
        }
      }
      return yield* taskError(KEPT_CHANGING);
    });

  /** What one answered request tells the agent that asked. */
  const noteFor = (request: ScheduledTaskRequestRow, tasks: ReadonlyArray<ScheduledTaskRow>) => {
    const name = `"${request.payload.name}"`;
    const subject =
      request.action === "create" ? `your scheduled task ${name}` : `your change to ${name}`;
    const detail = request.detail !== null ? ` ${request.detail}` : "";
    switch (request.status) {
      case "allowed": {
        if (request.action === "update") return `The user allowed ${subject}.`;
        const task = tasks.find((entry) => entry.id === requestTaskId(request.requestId));
        const next =
          task?.status === "active" && task.nextSlotUtc !== null
            ? `, next run ${formatWallTime(new Date(task.nextSlotUtc), task.timeZone)} (${task.timeZone})`
            : "";
        return `The user allowed ${subject}: it's on the Scheduled page (id ${requestTaskId(request.requestId)})${next}.`;
      }
      case "denied":
        return `The user said no to ${subject}.${detail}`;
      case "expired":
        return `Nobody answered about ${subject} within a day, so nothing changed.`;
      case "failed":
        return `The user allowed ${subject}, but it couldn't be saved.${detail}`;
      case "waiting":
        return null;
    }
  };

  const pendingNotes: ScheduledTasksShape["pendingNotes"] = (threadId, participantId) =>
    Effect.gen(function* () {
      const requests = yield* repo.listUnnotedRequests(threadId);
      const mine = requests.filter((request) => request.participantId === participantId);
      if (mine.length === 0) return [];
      const tasks = mine.some(
        (request) => request.action === "create" && request.status === "allowed",
      )
        ? yield* repo.listTasks
        : [];
      return mine.flatMap((request) => {
        const text = noteFor(request, tasks);
        return text === null ? [] : [{ requestId: request.requestId, text }];
      });
    }).pipe(Effect.orElseSucceed(() => []));

  const notesDelivered: ScheduledTasksShape["notesDelivered"] = (requestIds) =>
    Effect.gen(function* () {
      yield* repo.markRequestsNoted({ requestIds, now: yield* nowIso });
    }).pipe(Effect.ignore);

  const waitingThreadIds: ScheduledTasksShape["waitingThreadIds"] = repo.listWaitingRequests.pipe(
    Effect.map((requests): ReadonlySet<ThreadId> => new Set(requests.map((row) => row.threadId))),
    Effect.orElseSucceed(() => new Set<ThreadId>()),
  );

  /** Agents' changes nobody answered within a day. */
  const expireRequests = Effect.gen(function* () {
    const now = yield* nowMillis;
    const waiting = yield* repo.listWaitingRequests.pipe(Effect.orElseSucceed(() => []));
    let expired = false;
    for (const request of waiting) {
      if (Date.parse(request.createdAt) + REQUEST_TTL_MS > now) continue;
      expired =
        (yield* repo
          .decideRequest({
            requestId: request.requestId,
            status: "expired",
            detail: "Nobody answered within a day.",
            now: new Date(now).toISOString(),
          })
          .pipe(Effect.orElseSucceed(() => false))) || expired;
    }
    if (expired) yield* notify;
  });

  const remove: ScheduledTasksShape["remove"] = (input) =>
    Effect.gen(function* () {
      const runs = yield* repo
        .deleteTask(input.id)
        .pipe(Effect.mapError(storageError("delete the task")));
      yield* changedRuns;
      const threadIds = new Set<ThreadId>();
      for (const run of runs) {
        if (run.threadId === null || run.launch?.target.kind !== "new_thread") continue;
        threadIds.add(run.threadId);
      }
      const existing: Array<ThreadId> = [];
      for (const threadId of threadIds) {
        const thread = yield* readThread(threadId);
        if (thread !== undefined && thread.deletedAt === null && thread.archivedAt === null) {
          existing.push(threadId);
        }
      }
      return existing;
    });

  // ---------------------------------------------------------------------------
  // Claiming slots
  // ---------------------------------------------------------------------------

  /** Marks a task errored with the reason: it stops running until it is saved again. */
  const failTask = (
    task: ScheduledTaskRow,
    reason: string,
    /** The revision the task is at; an edit since wins. */
    revision: number = task.revision,
  ) =>
    Effect.gen(function* () {
      yield* repo.setTaskSchedule({
        taskId: task.id,
        expectedRevision: revision,
        status: "error",
        error: reason,
        nextSlotUtc: null,
        now: yield* nowIso,
      });
      yield* Effect.logWarning("a scheduled task stopped: its schedule failed", {
        taskId: task.id,
        reason,
      });
      yield* notify;
    }).pipe(Effect.ignore);

  /** Claims the task's due slot, if it has one; returns the run to launch. */
  const claimDue = (task: ScheduledTaskRow, now: number) =>
    Effect.gen(function* () {
      if (task.status !== "active" || task.nextSlotUtc === null) return null;
      const compiled = compileCadence(task.cadence, task.timeZone);
      if (Result.isFailure(compiled)) {
        yield* failTask(task, compiled.failure);
        return null;
      }
      const schedule = compiled.success;
      if (schedule === null) {
        // Manual: nothing is due. A stale slot is cleared.
        yield* repo.setTaskSchedule({
          taskId: task.id,
          expectedRevision: task.revision,
          status: task.status,
          error: null,
          nextSlotUtc: null,
          now: new Date(now).toISOString(),
        });
        return null;
      }
      const due = dueSlots(schedule, new Date(task.nextSlotUtc), new Date(now));
      if (Result.isFailure(due)) {
        yield* failTask(task, due.failure);
        return null;
      }
      if (due.success === null) return null;
      const { latest, earlier, firstEarlier } = due.success;
      const after = nextSlotOf(schedule, latest);
      const nextSlotUtc = Result.isSuccess(after) ? (after.success?.toISOString() ?? null) : null;
      const lateness = now - latest.getTime();
      const at = new Date(now).toISOString();
      const tooLate = lateness > SCHEDULED_TASK_CATCH_UP_WINDOW_MS;
      // A one-time task has had its one slot.
      const done = Result.isSuccess(after) && after.success === null;
      // Where it runs, as of now: a launch later checks it still is.
      const projectRoot = (yield* readProject(task.projectId))?.workspaceRoot ?? null;
      const claimed = yield* repo.claimSlot({
        taskId: task.id,
        // Claimed from the task as this tick read it: an edit since wins,
        // and the next tick claims with the edited settings.
        expectedRevision: task.revision,
        expectedNextSlotUtc: task.nextSlotUtc,
        nextSlotUtc,
        done,
        // Its only run waits for room (until the catch-up window passes)
        // rather than being skipped.
        waitWhenBusy: done,
        // Too late to catch up: every missed slot is one skipped row.
        missed:
          !tooLate && earlier > 0 && firstEarlier !== null
            ? { slotUtc: firstEarlier.toISOString(), reason: missedReason(earlier) }
            : null,
        run: tooLate
          ? {
              slotUtc: (firstEarlier ?? latest).toISOString(),
              skipReason: missedReason(earlier + 1),
            }
          : {
              slotUtc: latest.toISOString(),
              trigger: lateness <= SCHEDULED_TASK_ON_TIME_MS ? "schedule" : "catch_up",
              launch: launchOf(task, projectRoot),
            },
        now: at,
      });
      if (Option.isSome(claimed) && Result.isFailure(after)) {
        yield* failTask(task, "This schedule doesn't run again.", task.revision + 1);
      }
      return Option.getOrNull(claimed);
    });

  // ---------------------------------------------------------------------------
  // Launching
  // ---------------------------------------------------------------------------

  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "ScheduledTasks.resolveWorkspace",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: 16_384,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );

  /**
   * Where a new-thread run works: the project folder (Local checkout, or a
   * project without git), or a new worktree off the branch the project has
   * checked out, at its upstream's latest when that is ahead.
   */
  const resolveWorkspace = (projectCwd: string, checkout: ScheduledRunLaunch["checkout"]) =>
    Effect.gen(function* () {
      if (checkout === "local") return { kind: "project_folder" } satisfies ChildThreadWorkspace;
      if ((yield* runGit(projectCwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
        return { kind: "project_folder" } satisfies ChildThreadWorkspace;
      }
      const branch = yield* runGit(projectCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch !== null && branch !== "HEAD") {
        const fresh = yield* gitWorkflow
          .resolveFreshWorktreeBase({ cwd: projectCwd, branch })
          .pipe(Effect.orElseSucceed(() => ({ refName: branch })));
        return {
          kind: "worktree",
          projectCwd,
          baseRef: fresh.refName,
        } satisfies ChildThreadWorkspace;
      }
      const head = yield* runGit(projectCwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
      return head === null
        ? ({ kind: "project_folder" } satisfies ChildThreadWorkspace)
        : ({ kind: "worktree", projectCwd, baseRef: head } satisfies ChildThreadWorkspace);
    });

  /** Ends a run that couldn't launch, unless something ended it first. */
  const failLaunch = (run: ScheduledRunRow, reason: string) =>
    Effect.gen(function* () {
      yield* repo
        .updateRun({
          taskId: run.taskId,
          slotUtc: run.slotUtc,
          from: ["launching"],
          status: "failed",
          reason,
          now: yield* nowIso,
        })
        .pipe(Effect.ignore);
      yield* changedRuns;
    });

  /** Whether the run is still launching, recording how far it got. */
  const stillLaunching = (run: ScheduledRunRow, stage: NonNullable<ScheduledRunRow["stage"]>) =>
    Effect.gen(function* () {
      return yield* repo.updateRun({
        taskId: run.taskId,
        slotUtc: run.slotUtc,
        from: ["launching"],
        stage,
        now: yield* nowIso,
      });
    }).pipe(Effect.orElseSucceed(() => false));

  const takesFinishTool = (launch: ScheduledRunLaunch) =>
    providers.getProviders.pipe(
      Effect.map((all) => {
        const driver = all.find(
          (provider) => provider.instanceId === launch.modelSelection.instanceId,
        )?.driver;
        return driver !== undefined && NATIVE_TOOL_DRIVERS.has(driver);
      }),
    );

  /** A new thread for the run, set up in stages by ThreadBootstrap. */
  const launchNewThread = (row: ScheduledRunRow, initial: ScheduledRunLaunch) =>
    Effect.gen(function* () {
      const project = yield* readProject(initial.projectId);
      if (project === undefined) {
        return yield* failLaunch(row, "Its project isn't on this computer any more.");
      }
      // Never somewhere other than where it was planned to run.
      if (initial.projectRoot !== null && project.workspaceRoot !== initial.projectRoot) {
        return yield* failLaunch(
          row,
          "Its project moved to another folder since this run was planned.",
        );
      }
      let launch = initial;
      if (launch.workspace === null) {
        if (!(yield* stillLaunching(row, "workspace"))) return;
        const workspace = yield* resolveWorkspace(project.workspaceRoot, launch.checkout);
        launch = { ...launch, workspace };
        // Saved before anything is created: a resumed launch uses this base.
        yield* repo.updateRun({
          taskId: row.taskId,
          slotUtc: row.slotUtc,
          from: ["launching"],
          launch,
          now: yield* nowIso,
        });
      }
      const workspace = launch.workspace ?? ({ kind: "project_folder" } as const);
      const threadId = scheduledRunThreadId(row.taskId, row.slotUtc);
      const messageId = scheduledRunMessageId(row.taskId, row.slotUtc);
      yield* repo.updateRun({
        taskId: row.taskId,
        slotUtc: row.slotUtc,
        from: ["launching"],
        messageId,
        now: yield* nowIso,
      });
      const childLaunch: ChildThreadLaunch = {
        title: launch.taskName,
        prompt: runMessageText(launch, yield* takesFinishTool(launch)),
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: launch.interactionMode,
        reportBack: false,
        runSetup: true,
        workspace,
      };
      const exit = yield* Effect.exit(
        bootstrap.startChild({
          lineage: {
            kind: "scheduled",
            scheduledRun: { taskId: row.taskId, taskName: launch.taskName, slotUtc: row.slotUtc },
          },
          projectId: launch.projectId,
          requestId: scheduledRunKey(row.taskId, row.slotUtc),
          childThreadId: threadId,
          childMessageId: messageId,
          launch: childLaunch,
          createdAt: row.createdAt,
          checkpoint: (stage) =>
            Effect.gen(function* () {
              const going = yield* stillLaunching(row, stage);
              // Past creating it, the thread exists: the run links to it, and
              // its turn's end finds the run by it.
              if (going && stage !== "create") {
                yield* repo
                  .updateRun({
                    taskId: row.taskId,
                    slotUtc: row.slotUtc,
                    from: ["launching"],
                    threadId,
                    now: yield* nowIso,
                  })
                  .pipe(Effect.ignore);
                yield* refreshWorkingThreads;
              }
              return going;
            }),
        }),
      );
      if (exit._tag === "Failure") {
        // Cut off (the server stopping): it resumes from its stage later.
        if (Cause.hasInterruptsOnly(exit.cause)) return;
        const failure = Cause.findErrorOption(exit.cause);
        const created = yield* readThread(threadId);
        if (created !== undefined) {
          yield* repo
            .updateRun({
              taskId: row.taskId,
              slotUtc: row.slotUtc,
              from: ["launching"],
              threadId,
              now: yield* nowIso,
            })
            .pipe(Effect.ignore);
        }
        return yield* failLaunch(
          row,
          Option.isSome(failure) ? failure.value.detail : "Its thread couldn't be set up.",
        );
      }
      // Its turn may have ended already (then the run did too): never back.
      yield* repo.updateRun({
        taskId: row.taskId,
        slotUtc: row.slotUtc,
        from: ["launching"],
        status: "started",
        stage: "turn",
        threadId,
        now: yield* nowIso,
      });
      yield* changedRuns;
    });

  /** A follow-up in the task's thread: it waits behind the thread's own work. */
  const launchFollowUp = (
    row: ScheduledRunRow,
    launch: ScheduledRunLaunch & {
      readonly target: { readonly kind: "thread"; readonly threadId: ThreadId };
    },
  ) =>
    Effect.gen(function* () {
      const threadId = launch.target.threadId;
      const thread = yield* readThread(threadId);
      if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* failLaunch(row, "The thread it continues isn't open any more.");
      }
      const messageId = scheduledRunMessageId(row.taskId, row.slotUtc);
      if (!(yield* stillLaunching(row, "submit"))) return;
      yield* repo.updateRun({
        taskId: row.taskId,
        slotUtc: row.slotUtc,
        from: ["launching"],
        threadId,
        messageId,
        now: yield* nowIso,
      });
      yield* refreshWorkingThreads;
      const alreadySent =
        thread.messages.some((message) => message.id === messageId) ||
        (thread.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId);
      if (!alreadySent) {
        const sent = yield* engine
          .dispatch({
            type: "thread.follow-up.submit",
            commandId: scheduledRunCommandId(row.taskId, row.slotUtc, "submit"),
            threadId,
            // Queued, never steered: the run is a turn of its own.
            turnId:
              thread.session?.activeTurnId ??
              TurnId.make(`scheduled-run:${scheduledRunKey(row.taskId, row.slotUtc)}`),
            message: { messageId, role: "user", text: launch.prompt, attachments: [] },
            delivery: "queue",
            // The task's saved settings, never more access than the task
            // has, nor than the thread has now (its user may have lowered it).
            modelSelection: launch.modelSelection,
            runtimeMode: saferRuntimeMode(launch.runtimeMode, thread.runtimeMode),
            interactionMode: launch.interactionMode,
            // In a room, for the agent that set the task up.
            ...(launch.target.kind === "thread" && launch.target.participantId !== undefined
              ? { participantId: launch.target.participantId }
              : {}),
            createdAt: yield* nowIso,
          })
          .pipe(Effect.result);
        if (Result.isFailure(sent)) {
          const reread = yield* readThread(threadId);
          const landed =
            reread?.messages.some((message) => message.id === messageId) === true ||
            (reread?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId);
          if (!landed) {
            return yield* failLaunch(row, "The thread it continues didn't take the message.");
          }
        }
      }
      // Its turn may have started or ended already: never back.
      yield* repo.updateRun({
        taskId: row.taskId,
        slotUtc: row.slotUtc,
        from: ["launching"],
        status: "queued",
        now: yield* nowIso,
      });
      yield* changedRuns;
      yield* settleThreadRuns(threadId);
    });

  /** Launches (or resumes) one run, once per process at a time. */
  const launchRun = (run: Pick<ScheduledRunRow, "taskId" | "slotUtc">) =>
    Effect.gen(function* () {
      const key = runKey(run);
      if (launching.has(key)) return;
      launching.add(key);
      yield* Effect.gen(function* () {
        const found = yield* repo.getRun(run);
        if (Option.isNone(found) || found.value.status !== "launching") return;
        const row = found.value;
        const launch = row.launch;
        if (launch === null) return yield* failLaunch(row, "It had nothing to launch.");
        if (launch.target.kind === "thread") {
          return yield* launchFollowUp(row, { ...launch, target: launch.target });
        }
        return yield* launchNewThread(row, launch);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("a scheduled run could not launch", {
                taskId: run.taskId,
                slotUtc: run.slotUtc,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.ensuring(Effect.sync(() => launching.delete(key))),
      );
    });

  const runNow: ScheduledTasksShape["runNow"] = (input) =>
    Effect.gen(function* () {
      // Claimed only from the task as it is: one deleted or edited since it
      // was read is read again (or is gone), never launched from the old read.
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
        const found = yield* repo
          .getTask(input.id)
          .pipe(Effect.mapError(storageError("read the task")));
        if (Option.isNone(found)) return yield* taskError("That task was deleted.");
        const task = found.value;
        const projectRoot = (yield* readProject(task.projectId))?.workspaceRoot ?? null;
        const now = yield* nowIso;
        const claimed = yield* repo
          .claimManualRun({
            taskId: task.id,
            expectedRevision: task.revision,
            run: { slotUtc: now, trigger: "manual", launch: launchOf(task, projectRoot) },
            now,
          })
          .pipe(Effect.mapError(storageError("start the run")));
        if (Option.isNone(claimed)) continue;
        return yield* startedManually(claimed.value);
      }
      return yield* taskError(KEPT_CHANGING);
    });

  /** A run claimed by hand: launched unless overlap skipped it. */
  const startedManually = (row: ScheduledRunRow) =>
    Effect.gen(function* () {
      yield* changedRuns;
      if (row.status === "launching") yield* launchRun(row).pipe(Effect.forkDetach);
      return toRun(row);
    });

  // ---------------------------------------------------------------------------
  // Ending runs
  // ---------------------------------------------------------------------------

  /**
   * Ends a run with its turn: its agent's word on it applies when it came
   * from that turn. A new thread that had nothing to report is wrapped and
   * marked seen; a continued thread never is.
   */
  const endRun = (
    run: ScheduledRunRow,
    end: {
      readonly turnId: TurnId | null;
      readonly outcome: "completed" | "failed" | "interrupted";
      readonly reason: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const finish =
        run.finish !== null && end.turnId !== null && run.finish.turnId === end.turnId
          ? run.finish
          : null;
      const status =
        end.outcome === "completed"
          ? finish?.nothingToReport === true
            ? "nothing_to_report"
            : "finished"
          : end.outcome === "failed"
            ? "failed"
            : "interrupted";
      const at = yield* nowIso;
      const ended = yield* repo
        .updateRun({
          taskId: run.taskId,
          slotUtc: run.slotUtc,
          from: WORKING_RUN_STATUSES,
          status,
          reason: end.reason,
          ...(end.turnId !== null ? { turnId: end.turnId } : {}),
          summary: finish?.summary ?? null,
          now: at,
        })
        .pipe(Effect.orElseSucceed(() => false));
      if (!ended) return;
      if (
        status === "nothing_to_report" &&
        run.launch?.target.kind === "new_thread" &&
        run.threadId !== null &&
        end.turnId !== null &&
        // A card waiting there needs the user; the thread stays in front.
        !(yield* waitingThreadIds).has(run.threadId)
      ) {
        const threadId = run.threadId;
        // Wrapped and seen in one step, only while the run's own turn is
        // still the last thing in the thread.
        yield* engine
          .dispatch({
            type: "thread.done-override.set",
            commandId: scheduledRunCommandId(run.taskId, run.slotUtc, "wrap"),
            threadId,
            state: "done",
            at,
            whileLatestTurnId: end.turnId,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logInfo("a scheduled run could not wrap its thread", {
                threadId,
                detail: String(error),
              }),
            ),
          );
      }
      yield* changedRuns;
    });

  const onTurnEnd: ScheduledTasksShape["onTurnEnd"] = (input) =>
    Effect.gen(function* () {
      if (input.pendingMessageId === null || !workingThreads.has(input.threadId)) return;
      const runs = yield* repo.listRunsByThread(input.threadId);
      for (const run of runs) {
        if (!isWorkingRun(run) || run.messageId !== input.pendingMessageId) continue;
        yield* endRun(run, {
          turnId: input.turnId,
          outcome: input.outcome,
          reason:
            input.outcome === "failed"
              ? plainRunError(input.error, "Its turn failed.")
              : input.outcome === "interrupted"
                ? "Its turn was stopped before it finished."
                : null,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("scheduled tasks could not record a turn's end", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /**
   * Settles a queued or started run from what its thread says now: its
   * message's turn when there is one, else a thread that's gone, a message
   * taken back, or a turn that never started.
   */
  const settleRun = (run: ScheduledRunRow, now: number) =>
    Effect.gen(function* () {
      if (run.status !== "queued" && run.status !== "started") return;
      if (run.threadId === null || run.messageId === null) return;
      const thread = yield* readThread(run.threadId);
      if (thread === undefined || thread.deletedAt !== null) {
        return yield* endRun(run, {
          turnId: null,
          outcome: "failed",
          reason: "Its thread was deleted.",
        });
      }
      const messageId = run.messageId;
      if ((thread.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId)) return;
      const threadTurns = yield* turns.listByThreadId({ threadId: thread.id });
      const turn = threadTurns.find((entry) => entry.pendingMessageId === messageId);
      if (turn !== undefined && turn.turnId !== null) {
        switch (turn.state) {
          case "pending":
          case "running":
            if (run.status === "queued") {
              yield* repo.updateRun({
                taskId: run.taskId,
                slotUtc: run.slotUtc,
                from: ["queued"],
                status: "started",
                now: new Date(now).toISOString(),
              });
              yield* changedRuns;
            }
            return;
          case "completed":
            return yield* endRun(run, { turnId: turn.turnId, outcome: "completed", reason: null });
          case "error":
            return yield* endRun(run, {
              turnId: turn.turnId,
              outcome: "failed",
              reason: plainRunError(thread.session?.lastError, "Its turn failed."),
            });
          case "interrupted":
            return yield* endRun(run, {
              turnId: turn.turnId,
              outcome: "interrupted",
              reason:
                thread.session?.status === "interrupted"
                  ? "A restart cut its turn off."
                  : "Its turn was stopped before it finished.",
            });
        }
      }
      if (thread.archivedAt !== null) {
        return yield* endRun(run, {
          turnId: null,
          outcome: "failed",
          reason: "Its thread was archived before it ran.",
        });
      }
      const sent = thread.messages.some((message) => message.id === messageId);
      if (!sent) {
        if (run.status === "queued") {
          // Delivered, then neither waiting nor sent: the user took it back.
          return yield* endRun(run, {
            turnId: null,
            outcome: "failed",
            reason: "Its message was taken back before it ran.",
          });
        }
        return;
      }
      if (run.status === "queued") {
        yield* repo.updateRun({
          taskId: run.taskId,
          slotUtc: run.slotUtc,
          from: ["queued"],
          status: "started",
          now: new Date(now).toISOString(),
        });
        yield* changedRuns;
      }
      // Sent, but no turn of its own yet: wait while the thread works.
      const session = thread.session;
      const working =
        session !== null &&
        (session.status === "starting" ||
          session.status === "running" ||
          session.activeTurnId !== null);
      if (working || now - Date.parse(run.updatedAt) < NEVER_STARTED_GRACE_MS) return;
      return yield* endRun(run, {
        turnId: null,
        outcome: session?.status === "interrupted" ? "interrupted" : "failed",
        reason:
          session?.status === "interrupted"
            ? "A restart cut it off before its turn started."
            : plainRunError(session?.lastError, "Its turn never started."),
      });
    });

  const settleThreadRuns = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      const runs = yield* repo.listRunsByThread(threadId);
      for (const run of runs) {
        if (isWorkingRun(run)) yield* settleRun(run, now);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("scheduled tasks could not settle a thread's runs", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const recordFinish: ScheduledTasksShape["recordFinish"] = (input) =>
    Effect.gen(function* () {
      const runs = yield* repo.listRunsByThread(input.threadId);
      // Only a thread a run started takes the tool's word (never a continued one).
      const own = runs.filter((run) => run.launch?.target.kind === "new_thread");
      if (own.length === 0) return "not_a_run" as const;
      const turn = yield* turns
        .getByTurnId({ threadId: input.threadId, turnId: input.turnId })
        .pipe(Effect.map(Option.getOrUndefined));
      const run = own.find(
        (entry) => entry.messageId !== null && entry.messageId === turn?.pendingMessageId,
      );
      if (run === undefined) return "not_this_turn" as const;
      if (!isWorkingRun(run)) return "already_ended" as const;
      const recorded = yield* repo.updateRun({
        taskId: run.taskId,
        slotUtc: run.slotUtc,
        from: WORKING_RUN_STATUSES,
        finish: {
          nothingToReport: input.nothingToReport,
          summary: input.summary,
          turnId: input.turnId,
        },
        now: yield* nowIso,
      });
      return recorded ? ("recorded" as const) : ("already_ended" as const);
    }).pipe(Effect.orElseSucceed(() => "not_a_run" as const));

  // ---------------------------------------------------------------------------
  // The scheduler
  // ---------------------------------------------------------------------------

  /** Runs still launching that nobody here is launching: resumed. */
  const resumeLaunches = Effect.gen(function* () {
    const working = yield* repo.listWorkingRuns.pipe(Effect.orElseSucceed(() => []));
    for (const run of working) {
      if (run.status === "launching" && !launching.has(runKey(run))) {
        yield* launchRun(run).pipe(Effect.forkDetach);
      }
    }
  });

  /** Queued and started runs, checked against their threads. */
  const sweepRuns = Effect.gen(function* () {
    const now = yield* nowMillis;
    const working = yield* repo.listWorkingRuns.pipe(Effect.orElseSucceed(() => []));
    for (const run of working) {
      yield* settleRun(run, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled tasks could not check a run", {
            taskId: run.taskId,
            slotUtc: run.slotUtc,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const tick: ScheduledTasksShape["tick"] = Effect.gen(function* () {
    // Runs whose turns ended (one the previous process never saw end, say)
    // are settled first, so they never count against overlap or the cap of
    // the slots claimed next.
    yield* sweepRuns;
    const now = yield* nowMillis;
    const tasks = yield* repo.listTasks.pipe(Effect.orElseSucceed(() => []));
    let claimedAny = false;
    for (const task of tasks) {
      const claimed = yield* claimDue(task, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("a scheduled task's slot could not be claimed", {
            taskId: task.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (claimed === null) continue;
      claimedAny = true;
      if (claimed.status === "launching") yield* launchRun(claimed).pipe(Effect.forkDetach);
    }
    if (claimedAny) yield* changedRuns;
    yield* resumeLaunches;
    yield* expireRequests;
  });

  /** Events that can end, start or take back a run in a thread that has one. */
  const onEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested":
        case "thread.follow-up-unqueued":
        case "thread.session-set":
        case "thread.turn-completed":
        case "thread.archived":
        case "thread.deleted": {
          const threadId = event.payload.threadId;
          if (!workingThreads.has(threadId)) return;
          yield* settleThreadRuns(threadId);
          return;
        }
        default:
          return;
      }
    });

  const start: ScheduledTasksShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("scheduled tasks: scheduler started");
      const domainEvents = yield* engine.subscribeDomainEvents;
      yield* refreshWorkingThreads;
      yield* Effect.forkScoped(
        Stream.runForEach(domainEvents, (event) =>
          onEvent(event).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("scheduled tasks could not handle an event", {
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ),
      );
      // The first pass settles what the previous process left (launches
      // resume, ended turns end their runs) and claims what came due while
      // it was off; then one every 30 seconds.
      yield* Effect.forkScoped(
        tick.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("the scheduler's pass failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.repeat(Schedule.spaced(SCHEDULER_TICK)),
        ),
      );
    });

  return ScheduledTasks.of({
    snapshot,
    changes,
    listRuns,
    create,
    update,
    remove,
    runNow,
    propose,
    pendingNotes,
    notesDelivered,
    waitingThreadIds,
    respondRequest,
    getTask,
    recordFinish,
    onTurnEnd,
    tick,
    start,
  });
});

export const ScheduledTasksLive = Layer.effect(ScheduledTasks, make);

/** The provider command reactor's source of answers for agents: see ScheduledTaskNotes. */
export const ScheduledTaskNotesLive = Layer.effect(
  ScheduledTaskNotes,
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTasks;
    return ScheduledTaskNotes.of({
      pendingFor: scheduledTasks.pendingNotes,
      delivered: scheduledTasks.notesDelivered,
    });
  }),
);

/** Runtime ingestion's hook for turns that end: see ScheduledRunTurnEnds. */
export const ScheduledRunTurnEndsLive = Layer.effect(
  ScheduledRunTurnEnds,
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTasks;
    return ScheduledRunTurnEnds.of({ onTurnEnd: scheduledTasks.onTurnEnd });
  }),
);
