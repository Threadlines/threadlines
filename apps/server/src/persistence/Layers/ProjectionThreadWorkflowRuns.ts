import { OrchestrationWorkflowRun, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadWorkflowRunRepository,
  ProjectionThreadWorkflowRunTaskInput,
  ProjectionThreadWorkflowRunThreadInput,
  type ProjectionThreadWorkflowRunRepositoryShape,
} from "../Services/ProjectionThreadWorkflowRuns.ts";

/**
 * The run lives in `run_json`; the other columns repeat what lookups and
 * ordering need. A row that no longer decodes (a run written by a newer
 * build, after a downgrade) is skipped rather than failing the snapshot.
 */
const WorkflowRunRow = Schema.Struct({
  threadId: ThreadId,
  runJson: Schema.String,
});
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationWorkflowRun));

/** Decoded runs of stored rows, skipping any that no longer decode. */
export function decodeWorkflowRunRows(
  rows: ReadonlyArray<typeof WorkflowRunRow.Type>,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly run: OrchestrationWorkflowRun }> {
  return rows.flatMap((row) => {
    const run = decodeRun(row.runJson);
    return run._tag === "Some" ? [{ threadId: row.threadId, run: run.value }] : [];
  });
}

const makeProjectionThreadWorkflowRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: ProjectionThreadWorkflowRunThreadInput,
    Result: WorkflowRunRow,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", run_json AS "runJson"
      FROM projection_thread_workflow_runs
      WHERE thread_id = ${threadId}
      ORDER BY started_at ASC, task_id ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: ProjectionThreadWorkflowRunTaskInput,
    Result: WorkflowRunRow,
    execute: ({ threadId, taskId }) => sql`
      SELECT thread_id AS "threadId", run_json AS "runJson"
      FROM projection_thread_workflow_runs
      WHERE thread_id = ${threadId} AND task_id = ${taskId}
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorkflowRunRow,
    execute: () => sql`
      SELECT runs.thread_id AS "threadId", runs.run_json AS "runJson"
      FROM projection_thread_workflow_runs AS runs
      JOIN projection_threads AS threads ON threads.thread_id = runs.thread_id
      WHERE threads.deleted_at IS NULL
      ORDER BY runs.thread_id ASC, runs.started_at ASC, runs.task_id ASC
    `,
  });

  const writeRun = (threadId: ThreadId, run: OrchestrationWorkflowRun) => sql`
    INSERT INTO projection_thread_workflow_runs (
      thread_id, task_id, turn_id, status, started_at, run_json, event_sequence, updated_at
    )
    VALUES (
      ${threadId}, ${run.taskId}, ${run.turnId}, ${run.status}, ${run.startedAt},
      ${JSON.stringify(run)}, ${run.eventSequence ?? null}, ${run.updatedAt}
    )
    ON CONFLICT (thread_id, task_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      status = excluded.status,
      started_at = excluded.started_at,
      run_json = excluded.run_json,
      event_sequence = excluded.event_sequence,
      updated_at = excluded.updated_at
  `;

  const listByThreadId: ProjectionThreadWorkflowRunRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.map((rows) => decodeWorkflowRunRows(rows).map((entry) => entry.run)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadWorkflowRunRepository.listByThreadId:query"),
      ),
    );

  const getByTaskId: ProjectionThreadWorkflowRunRepositoryShape["getByTaskId"] = (input) =>
    getRow(input).pipe(
      Effect.map((row) =>
        Option.flatMap(row, (found) =>
          Option.fromNullishOr(decodeWorkflowRunRows([found])[0]?.run),
        ),
      ),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadWorkflowRunRepository.getByTaskId:query"),
      ),
    );

  const listAll: ProjectionThreadWorkflowRunRepositoryShape["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.map(decodeWorkflowRunRows),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadWorkflowRunRepository.listAll:query")),
    );

  const upsert: ProjectionThreadWorkflowRunRepositoryShape["upsert"] = (threadId, run) =>
    writeRun(threadId, run).pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionThreadWorkflowRunRepository.upsert:query")),
    );

  const replaceByThreadId: ProjectionThreadWorkflowRunRepositoryShape["replaceByThreadId"] = (
    threadId,
    runs,
  ) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_thread_workflow_runs WHERE thread_id = ${threadId}`;
      yield* Effect.forEach(runs, (run) => writeRun(threadId, run), {
        concurrency: 1,
        discard: true,
      });
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadWorkflowRunRepository.replaceByThreadId:query"),
      ),
    );

  return {
    listByThreadId,
    getByTaskId,
    listAll,
    upsert,
    replaceByThreadId,
  } satisfies ProjectionThreadWorkflowRunRepositoryShape;
});

export const ProjectionThreadWorkflowRunRepositoryLive = Layer.effect(
  ProjectionThreadWorkflowRunRepository,
  makeProjectionThreadWorkflowRunRepository,
);
