import {
  ChildThreadWorkspace,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledRunStatus,
  ScheduledRunTrigger,
  ScheduledTaskCadence,
  ScheduledTaskCheckout,
  ScheduledTaskDraft,
  ScheduledTaskId,
  ScheduledTaskStatus,
  ScheduledTaskTarget,
  ScheduledTaskUpdateInput,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@threadlines/contracts";
import { SCHEDULED_TASK_RUN_CAP } from "@threadlines/shared/scheduledTasks";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * Scheduled tasks and their runs (docs/design/fleet.md, Part 6), one
 * computer's own. A due slot is claimed in one transaction: the task's next
 * slot moves on only if it is still the one the scheduler read, the slot's
 * run row is inserted (unique on task and slot), and the run is decided
 * there too, launching or skipped, against every run still working. So a
 * slot runs at most once, whatever crashes or races with an edit or Run now.
 */

export const ScheduledTaskRow = Schema.Struct({
  id: ScheduledTaskId,
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: ProjectId,
  checkout: ScheduledTaskCheckout,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cadence: ScheduledTaskCadence,
  timeZone: TrimmedNonEmptyString,
  target: ScheduledTaskTarget,
  status: ScheduledTaskStatus,
  error: Schema.NullOr(Schema.String),
  /** The next slot due, a UTC instant; null for manual, paused and errored tasks. */
  nextSlotUtc: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledTaskRow = typeof ScheduledTaskRow.Type;

/**
 * Everything one run launches with, copied from its task when its slot was
 * claimed: a resumed launch reads only this, never the task as edited since.
 * `workspace` is where a new thread works, settled at the launch's first
 * stage and saved before anything is created.
 */
export const ScheduledRunLaunch = Schema.Struct({
  taskName: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: ProjectId,
  checkout: ScheduledTaskCheckout,
  workspace: Schema.NullOr(ChildThreadWorkspace),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  target: ScheduledTaskTarget,
});
export type ScheduledRunLaunch = typeof ScheduledRunLaunch.Type;

/** What a run's agent said with `scheduled_run_finish`, applied when its turn ends. */
export const ScheduledRunFinish = Schema.Struct({
  nothingToReport: Schema.Boolean,
  summary: Schema.NullOr(Schema.String),
  turnId: TurnId,
});
export type ScheduledRunFinish = typeof ScheduledRunFinish.Type;

/** How far a run's launch got. */
export const ScheduledRunStage = Schema.Literals([
  "workspace",
  "create",
  "worktree",
  "setup",
  "turn",
  "submit",
]);
export type ScheduledRunStage = typeof ScheduledRunStage.Type;

export const ScheduledRunRow = Schema.Struct({
  taskId: ScheduledTaskId,
  slotUtc: IsoDateTime,
  trigger: ScheduledRunTrigger,
  status: ScheduledRunStatus,
  stage: Schema.NullOr(ScheduledRunStage),
  reason: Schema.NullOr(Schema.String),
  launch: Schema.NullOr(ScheduledRunLaunch),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  finish: Schema.NullOr(ScheduledRunFinish),
  summary: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledRunRow = typeof ScheduledRunRow.Type;

/** What an agent asked to change, kept whole until the user answers. */
export const ScheduledTaskChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("create"), draft: ScheduledTaskDraft }),
  Schema.Struct({ kind: Schema.Literal("update"), input: ScheduledTaskUpdateInput }),
]);
export type ScheduledTaskChange = typeof ScheduledTaskChange.Type;

const ScheduledTaskRequestPayload = Schema.Struct({
  change: ScheduledTaskChange,
  name: TrimmedNonEmptyString,
  details: Schema.Array(Schema.String),
});

export const ScheduledTaskRequestStatus = Schema.Literals([
  "waiting",
  "allowed",
  "denied",
  "expired",
  "failed",
]);
export type ScheduledTaskRequestStatus = typeof ScheduledTaskRequestStatus.Type;

export const ScheduledTaskRequestRow = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  action: Schema.Literals(["create", "update"]),
  taskId: Schema.NullOr(ScheduledTaskId),
  payload: ScheduledTaskRequestPayload,
  status: ScheduledTaskRequestStatus,
  detail: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type ScheduledTaskRequestRow = typeof ScheduledTaskRequestRow.Type;

const RequestDbRow = Schema.Struct({
  ...ScheduledTaskRequestRow.fields,
  payload: Schema.fromJsonString(ScheduledTaskRequestPayload),
});
const encodeRequestPayload = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskRequestPayload));

const TaskDbRow = Schema.Struct({
  ...ScheduledTaskRow.fields,
  modelSelection: Schema.fromJsonString(ModelSelection),
  cadence: Schema.fromJsonString(ScheduledTaskCadence),
  target: Schema.fromJsonString(ScheduledTaskTarget),
});
const RunDbRow = Schema.Struct({
  ...ScheduledRunRow.fields,
  launch: Schema.NullOr(Schema.fromJsonString(ScheduledRunLaunch)),
  finish: Schema.NullOr(Schema.fromJsonString(ScheduledRunFinish)),
});

const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeCadence = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskCadence));
const encodeTarget = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskTarget));
const encodeLaunch = Schema.encodeSync(Schema.fromJsonString(ScheduledRunLaunch));
const encodeFinish = Schema.encodeSync(Schema.fromJsonString(ScheduledRunFinish));

/** Runs that are not done: they count against overlap and the computer's cap. */
export const WORKING_RUN_STATUSES: ReadonlyArray<ScheduledRunStatus> = [
  "launching",
  "queued",
  "started",
];
export const isWorkingRun = (run: Pick<ScheduledRunRow, "status">) =>
  WORKING_RUN_STATUSES.includes(run.status);

export const SKIP_REASON_PREVIOUS_WORKING = "The previous run was still working.";
export const SKIP_REASON_CAP = `${SCHEDULED_TASK_RUN_CAP} scheduled runs were already working.`;

const working = `('launching', 'queued', 'started')`;

export class ScheduledTaskRepositoryError extends Data.TaggedError("ScheduledTaskRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** A run to record for a slot: launched with this snapshot, unless overlap skips it. */
export interface ScheduledRunClaim {
  readonly slotUtc: string;
  readonly trigger: ScheduledRunTrigger;
  readonly launch: ScheduledRunLaunch;
}

export interface ScheduledTaskRepositoryShape {
  readonly listTasks: Effect.Effect<ReadonlyArray<ScheduledTaskRow>, ScheduledTaskRepositoryError>;
  readonly getTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<Option.Option<ScheduledTaskRow>, ScheduledTaskRepositoryError>;
  readonly insertTask: (row: ScheduledTaskRow) => Effect.Effect<void, ScheduledTaskRepositoryError>;
  /** Writes the whole task over the stored one. */
  readonly saveTask: (row: ScheduledTaskRow) => Effect.Effect<void, ScheduledTaskRepositoryError>;
  /** Deletes the task and its run history; returns the runs it had. */
  readonly deleteTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ReadonlyArray<ScheduledRunRow>, ScheduledTaskRepositoryError>;
  /**
   * Claims a task's due slot: only while its next slot is still
   * `expectedNextSlotUtc` (and it is active), moves it to `nextSlotUtc` (and
   * to `done` when that was its last slot), records the slots it missed as
   * one skipped row, and records the run. None when the task moved on
   * meanwhile (edited, paused, deleted).
   */
  readonly claimSlot: (input: {
    readonly taskId: ScheduledTaskId;
    readonly expectedNextSlotUtc: string;
    readonly nextSlotUtc: string | null;
    readonly done: boolean;
    readonly missed: { readonly slotUtc: string; readonly reason: string } | null;
    readonly run: ScheduledRunClaim | { readonly slotUtc: string; readonly skipReason: string };
    readonly now: string;
  }) => Effect.Effect<Option.Option<ScheduledRunRow>, ScheduledTaskRepositoryError>;
  /** Records a run asked for by hand (Run now, or an agent): skipped too when overlap says so. */
  readonly claimManualRun: (input: {
    readonly taskId: ScheduledTaskId;
    readonly run: ScheduledRunClaim;
    readonly now: string;
  }) => Effect.Effect<ScheduledRunRow, ScheduledTaskRepositoryError>;
  /** Sets a task's next slot, status and error (an error found at a tick). */
  readonly setTaskSchedule: (input: {
    readonly taskId: ScheduledTaskId;
    readonly status: ScheduledTaskRow["status"];
    readonly error: string | null;
    readonly nextSlotUtc: string | null;
    readonly now: string;
  }) => Effect.Effect<void, ScheduledTaskRepositoryError>;
  readonly getRun: (input: {
    readonly taskId: ScheduledTaskId;
    readonly slotUtc: string;
  }) => Effect.Effect<Option.Option<ScheduledRunRow>, ScheduledTaskRepositoryError>;
  /** A task's runs, newest slot first. */
  readonly listRuns: (input: {
    readonly taskId: ScheduledTaskId;
    readonly before?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ScheduledRunRow>, ScheduledTaskRepositoryError>;
  /** Each task's newest run, and how many of its runs are working. */
  readonly runSummaries: Effect.Effect<
    ReadonlyMap<
      ScheduledTaskId,
      { readonly last: ScheduledRunRow | null; readonly working: number }
    >,
    ScheduledTaskRepositoryError
  >;
  /** Every run still launching, queued or started. */
  readonly listWorkingRuns: Effect.Effect<
    ReadonlyArray<ScheduledRunRow>,
    ScheduledTaskRepositoryError
  >;
  readonly listRunsByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ScheduledRunRow>, ScheduledTaskRepositoryError>;
  /**
   * Moves one run on; only from `from` when given. True when it changed.
   * Null fields clear, absent ones stay.
   */
  readonly updateRun: (input: {
    readonly taskId: ScheduledTaskId;
    readonly slotUtc: string;
    readonly from?: ReadonlyArray<ScheduledRunStatus>;
    readonly status?: ScheduledRunStatus;
    readonly stage?: ScheduledRunStage | null;
    readonly reason?: string | null;
    readonly launch?: ScheduledRunLaunch;
    readonly threadId?: ThreadId | null;
    readonly messageId?: MessageId | null;
    readonly turnId?: TurnId | null;
    readonly finish?: ScheduledRunFinish | null;
    readonly summary?: string | null;
    readonly now: string;
  }) => Effect.Effect<boolean, ScheduledTaskRepositoryError>;
  /** Records an agent's change unless its id exists; returns the stored row. */
  readonly insertRequest: (
    row: Omit<ScheduledTaskRequestRow, "status" | "detail" | "decidedAt">,
  ) => Effect.Effect<ScheduledTaskRequestRow, ScheduledTaskRepositoryError>;
  readonly getRequest: (
    requestId: string,
  ) => Effect.Effect<Option.Option<ScheduledTaskRequestRow>, ScheduledTaskRepositoryError>;
  readonly listWaitingRequests: Effect.Effect<
    ReadonlyArray<ScheduledTaskRequestRow>,
    ScheduledTaskRepositoryError
  >;
  /** Answers a waiting request; false when it was already answered. */
  readonly decideRequest: (input: {
    readonly requestId: string;
    readonly status: Exclude<ScheduledTaskRequestStatus, "waiting">;
    readonly detail: string | null;
    readonly now: string;
  }) => Effect.Effect<boolean, ScheduledTaskRepositoryError>;
}

export class ScheduledTaskRepository extends Context.Service<
  ScheduledTaskRepository,
  ScheduledTaskRepositoryShape
>()("threadlines/scheduled/ScheduledTaskRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ScheduledTaskRepositoryError({ operation, cause })),
      );

  const selectTask = `
    SELECT
      task_id AS "id",
      name AS "name",
      prompt AS "prompt",
      project_id AS "projectId",
      checkout AS "checkout",
      model_selection_json AS "modelSelection",
      runtime_mode AS "runtimeMode",
      interaction_mode AS "interactionMode",
      cadence_json AS "cadence",
      time_zone AS "timeZone",
      target_json AS "target",
      status AS "status",
      error AS "error",
      next_slot_utc AS "nextSlotUtc",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM scheduled_tasks
  `;

  const runColumns = `
      task_id AS "taskId",
      slot_utc AS "slotUtc",
      run_trigger AS "trigger",
      status AS "status",
      stage AS "stage",
      reason AS "reason",
      launch_json AS "launch",
      thread_id AS "threadId",
      message_id AS "messageId",
      turn_id AS "turnId",
      finish_json AS "finish",
      summary AS "summary",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `;
  const selectRun = `SELECT ${runColumns} FROM scheduled_runs`;

  const findTasks = (where: string, params: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: TaskDbRow,
      execute: () => sql.unsafe(`${selectTask} ${where}`, [...params]),
    })(undefined);

  const findRuns = (where: string, params: ReadonlyArray<string | number>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: RunDbRow,
      execute: () => sql.unsafe(`${selectRun} ${where}`, [...params]),
    })(undefined);

  const listTasks: ScheduledTaskRepositoryShape["listTasks"] = findTasks(
    "ORDER BY created_at, task_id",
    [],
  ).pipe(wrap("listTasks"));

  const getTask: ScheduledTaskRepositoryShape["getTask"] = (id) =>
    findTasks("WHERE task_id = ?", [id]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getTask"),
    );

  const taskValues = (row: ScheduledTaskRow) => [
    row.name,
    row.prompt,
    row.projectId,
    row.checkout,
    encodeModelSelection(row.modelSelection),
    row.runtimeMode,
    row.interactionMode,
    encodeCadence(row.cadence),
    row.timeZone,
    encodeTarget(row.target),
    row.status,
    row.error,
    row.nextSlotUtc,
  ];

  const insertTask: ScheduledTaskRepositoryShape["insertTask"] = (row) =>
    sql
      .unsafe(
        `INSERT INTO scheduled_tasks (
           task_id, name, prompt, project_id, checkout, model_selection_json, runtime_mode,
           interaction_mode, cadence_json, time_zone, target_json, status, error, next_slot_utc,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO NOTHING`,
        [row.id, ...taskValues(row), row.createdAt, row.updatedAt],
      )
      .pipe(Effect.asVoid, wrap("insertTask"));

  const saveTask: ScheduledTaskRepositoryShape["saveTask"] = (row) =>
    sql
      .unsafe(
        `UPDATE scheduled_tasks SET
           name = ?, prompt = ?, project_id = ?, checkout = ?, model_selection_json = ?,
           runtime_mode = ?, interaction_mode = ?, cadence_json = ?, time_zone = ?,
           target_json = ?, status = ?, error = ?, next_slot_utc = ?, updated_at = ?
         WHERE task_id = ?`,
        [...taskValues(row), row.updatedAt, row.id],
      )
      .pipe(Effect.asVoid, wrap("saveTask"));

  const deleteTask: ScheduledTaskRepositoryShape["deleteTask"] = (id) =>
    Effect.gen(function* () {
      const runs = yield* findRuns("WHERE task_id = ?", [id]);
      yield* sql`DELETE FROM scheduled_runs WHERE task_id = ${id}`;
      yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`;
      return runs;
    }).pipe(sql.withTransaction, wrap("deleteTask"));

  const getRunRow = (taskId: string, slotUtc: string) =>
    findRuns("WHERE task_id = ? AND slot_utc = ?", [taskId, slotUtc]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const insertSkipped = (
    taskId: string,
    trigger: string,
    slotUtc: string,
    reason: string,
    now: string,
  ) =>
    sql`
      INSERT INTO scheduled_runs (
        task_id, slot_utc, run_trigger, status, reason, created_at, updated_at
      ) VALUES (${taskId}, ${slotUtc}, ${trigger}, 'skipped', ${reason}, ${now}, ${now})
      ON CONFLICT(task_id, slot_utc) DO NOTHING
    `;

  /**
   * Records `run` for a slot, decided against every working run: skipped
   * while the task's own previous run works, or the computer's cap is full.
   * Call inside a transaction.
   */
  const insertDecidedRun = (taskId: string, run: ScheduledRunClaim, now: string) =>
    Effect.gen(function* () {
      const counts = yield* sql<{ readonly task: number | null; readonly all: number }>`
        SELECT
          SUM(CASE WHEN task_id = ${taskId} THEN 1 ELSE 0 END) AS "task",
          COUNT(*) AS "all"
        FROM scheduled_runs
        WHERE status IN ('launching', 'queued', 'started')
      `;
      const taskWorking = Number(counts[0]?.task ?? 0);
      const allWorking = Number(counts[0]?.all ?? 0);
      const skipReason =
        taskWorking > 0
          ? SKIP_REASON_PREVIOUS_WORKING
          : allWorking >= SCHEDULED_TASK_RUN_CAP
            ? SKIP_REASON_CAP
            : null;
      if (skipReason !== null) {
        yield* insertSkipped(taskId, run.trigger, run.slotUtc, skipReason, now);
      } else {
        yield* sql`
          INSERT INTO scheduled_runs (
            task_id, slot_utc, run_trigger, status, launch_json, created_at, updated_at
          ) VALUES (
            ${taskId}, ${run.slotUtc}, ${run.trigger}, 'launching', ${encodeLaunch(run.launch)},
            ${now}, ${now}
          )
          ON CONFLICT(task_id, slot_utc) DO NOTHING
        `;
      }
      return Option.getOrThrow(yield* getRunRow(taskId, run.slotUtc));
    });

  const claimSlot: ScheduledTaskRepositoryShape["claimSlot"] = (input) =>
    Effect.gen(function* () {
      const moved = yield* sql<{ readonly id: string }>`
        UPDATE scheduled_tasks SET
          next_slot_utc = ${input.nextSlotUtc},
          status = ${input.done ? "done" : "active"},
          updated_at = ${input.now}
        WHERE task_id = ${input.taskId}
          AND status = 'active'
          AND next_slot_utc = ${input.expectedNextSlotUtc}
        RETURNING task_id AS "id"
      `;
      if (moved.length === 0) return Option.none();
      if (input.missed !== null) {
        yield* insertSkipped(
          input.taskId,
          "catch_up",
          input.missed.slotUtc,
          input.missed.reason,
          input.now,
        );
      }
      if ("skipReason" in input.run) {
        yield* insertSkipped(
          input.taskId,
          "schedule",
          input.run.slotUtc,
          input.run.skipReason,
          input.now,
        );
        return yield* getRunRow(input.taskId, input.run.slotUtc);
      }
      return Option.some(yield* insertDecidedRun(input.taskId, input.run, input.now));
    }).pipe(sql.withTransaction, wrap("claimSlot"));

  const claimManualRun: ScheduledTaskRepositoryShape["claimManualRun"] = (input) =>
    insertDecidedRun(input.taskId, input.run, input.now).pipe(
      sql.withTransaction,
      wrap("claimManualRun"),
    );

  const setTaskSchedule: ScheduledTaskRepositoryShape["setTaskSchedule"] = (input) =>
    sql`
      UPDATE scheduled_tasks SET
        status = ${input.status},
        error = ${input.error},
        next_slot_utc = ${input.nextSlotUtc},
        updated_at = ${input.now}
      WHERE task_id = ${input.taskId}
    `.pipe(Effect.asVoid, wrap("setTaskSchedule"));

  const getRun: ScheduledTaskRepositoryShape["getRun"] = (input) =>
    getRunRow(input.taskId, input.slotUtc).pipe(wrap("getRun"));

  const listRuns: ScheduledTaskRepositoryShape["listRuns"] = (input) =>
    (input.before === undefined
      ? findRuns("WHERE task_id = ? ORDER BY slot_utc DESC LIMIT ?", [input.taskId, input.limit])
      : findRuns("WHERE task_id = ? AND slot_utc < ? ORDER BY slot_utc DESC LIMIT ?", [
          input.taskId,
          input.before,
          input.limit,
        ])
    ).pipe(wrap("listRuns"));

  const runSummaries: ScheduledTaskRepositoryShape["runSummaries"] = Effect.gen(function* () {
    const latest = yield* findRuns(
      `WHERE slot_utc = (
         SELECT MAX(newer.slot_utc) FROM scheduled_runs AS newer
         WHERE newer.task_id = scheduled_runs.task_id
       )`,
      [],
    );
    const counts = yield* sql<{ readonly taskId: string; readonly working: number }>`
      SELECT task_id AS "taskId", COUNT(*) AS "working"
      FROM scheduled_runs
      WHERE status IN ('launching', 'queued', 'started')
      GROUP BY task_id
    `;
    const summaries = new Map<
      ScheduledTaskId,
      { readonly last: ScheduledRunRow | null; working: number }
    >();
    for (const run of latest) summaries.set(run.taskId, { last: run, working: 0 });
    for (const count of counts) {
      const taskId = ScheduledTaskId.make(count.taskId);
      const entry = summaries.get(taskId) ?? { last: null, working: 0 };
      entry.working = Number(count.working);
      summaries.set(taskId, entry);
    }
    return summaries;
  }).pipe(wrap("runSummaries"));

  const listWorkingRuns: ScheduledTaskRepositoryShape["listWorkingRuns"] = findRuns(
    `WHERE status IN ${working} ORDER BY created_at`,
    [],
  ).pipe(wrap("listWorkingRuns"));

  const listRunsByThread: ScheduledTaskRepositoryShape["listRunsByThread"] = (threadId) =>
    findRuns("WHERE thread_id = ? ORDER BY slot_utc", [threadId]).pipe(wrap("listRunsByThread"));

  const updateRun: ScheduledTaskRepositoryShape["updateRun"] = (input) =>
    Effect.gen(function* () {
      const sets: Array<string> = ["updated_at = ?"];
      const values: Array<string | null> = [input.now];
      const set = (column: string, value: string | null) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (input.status !== undefined) set("status", input.status);
      if (input.stage !== undefined) set("stage", input.stage);
      if (input.reason !== undefined) set("reason", input.reason);
      if (input.launch !== undefined) set("launch_json", encodeLaunch(input.launch));
      if (input.threadId !== undefined) set("thread_id", input.threadId);
      if (input.messageId !== undefined) set("message_id", input.messageId);
      if (input.turnId !== undefined) set("turn_id", input.turnId);
      if (input.finish !== undefined) {
        set("finish_json", input.finish === null ? null : encodeFinish(input.finish));
      }
      if (input.summary !== undefined) set("summary", input.summary);
      const from = input.from ?? [];
      const guard = from.length === 0 ? "" : ` AND status IN (${from.map(() => "?").join(", ")})`;
      const rows = yield* sql.unsafe<{ readonly taskId: string }>(
        `UPDATE scheduled_runs SET ${sets.join(", ")}
         WHERE task_id = ? AND slot_utc = ?${guard}
         RETURNING task_id AS "taskId"`,
        [...values, input.taskId, input.slotUtc, ...from],
      );
      return rows.length > 0;
    }).pipe(wrap("updateRun"));

  const selectRequest = `
    SELECT
      request_id AS "requestId",
      thread_id AS "threadId",
      action AS "action",
      task_id AS "taskId",
      payload_json AS "payload",
      status AS "status",
      detail AS "detail",
      created_at AS "createdAt",
      decided_at AS "decidedAt"
    FROM scheduled_task_requests
  `;
  const findRequests = (where: string, params: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: RequestDbRow,
      execute: () => sql.unsafe(`${selectRequest} ${where}`, [...params]),
    })(undefined);

  const getRequest: ScheduledTaskRepositoryShape["getRequest"] = (requestId) =>
    findRequests("WHERE request_id = ?", [requestId]).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getRequest"),
    );

  const insertRequest: ScheduledTaskRepositoryShape["insertRequest"] = (row) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO scheduled_task_requests (
          request_id, thread_id, action, task_id, payload_json, status, created_at
        ) VALUES (
          ${row.requestId}, ${row.threadId}, ${row.action}, ${row.taskId},
          ${encodeRequestPayload(row.payload)}, 'waiting', ${row.createdAt}
        )
        ON CONFLICT(request_id) DO NOTHING
      `;
      const stored = yield* findRequests("WHERE request_id = ?", [row.requestId]);
      return stored[0]!;
    }).pipe(wrap("insertRequest"));

  const listWaitingRequests: ScheduledTaskRepositoryShape["listWaitingRequests"] = findRequests(
    "WHERE status = 'waiting' ORDER BY created_at",
    [],
  ).pipe(wrap("listWaitingRequests"));

  const decideRequest: ScheduledTaskRepositoryShape["decideRequest"] = (input) =>
    sql<{ readonly requestId: string }>`
      UPDATE scheduled_task_requests
      SET status = ${input.status}, detail = ${input.detail}, decided_at = ${input.now}
      WHERE request_id = ${input.requestId} AND status = 'waiting'
      RETURNING request_id AS "requestId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("decideRequest"),
    );

  return ScheduledTaskRepository.of({
    insertRequest,
    getRequest,
    listWaitingRequests,
    decideRequest,
    listTasks,
    getTask,
    insertTask,
    saveTask,
    deleteTask,
    claimSlot,
    claimManualRun,
    setTaskSchedule,
    getRun,
    listRuns,
    runSummaries,
    listWorkingRuns,
    listRunsByThread,
    updateRun,
  });
});

export const ScheduledTaskRepositoryLive = Layer.effect(ScheduledTaskRepository, make);
