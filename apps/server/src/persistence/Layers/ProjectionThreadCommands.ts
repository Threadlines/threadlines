import {
  NonNegativeInt,
  OrchestrationCommandRequest,
  OrchestrationCommandRun,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadCommandRepository,
  type ProjectionThreadCommandRepositoryShape,
} from "../Services/ProjectionThreadCommands.ts";

const ThreadInput = Schema.Struct({ threadId: ThreadId });
const RunInput = Schema.Struct({ threadId: ThreadId, runId: Schema.String });
const RequestJsonRow = Schema.Struct({ json: Schema.fromJsonString(OrchestrationCommandRequest) });
const RunJsonRow = Schema.Struct({ json: Schema.fromJsonString(OrchestrationCommandRun) });
const OutputRow = Schema.Struct({ output: Schema.NullOr(Schema.String) });
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationCommandRequest));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(OrchestrationCommandRun));

const makeProjectionThreadCommandRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRequestRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      requestId: Schema.String,
      eventSequence: Schema.NullOr(NonNegativeInt),
      json: Schema.String,
    }),
    execute: (row) => sql`
      INSERT INTO projection_thread_command_requests (
        thread_id, request_id, event_sequence, request_json
      )
      VALUES (${row.threadId}, ${row.requestId}, ${row.eventSequence}, ${row.json})
      ON CONFLICT (thread_id, request_id)
      DO UPDATE SET event_sequence = excluded.event_sequence, request_json = excluded.request_json
    `,
  });
  const listRequestRows = SqlSchema.findAll({
    Request: ThreadInput,
    Result: RequestJsonRow,
    execute: ({ threadId }) => sql`
      SELECT request_json AS "json"
      FROM projection_thread_command_requests
      WHERE thread_id = ${threadId}
      ORDER BY event_sequence ASC, request_id ASC
    `,
  });

  const upsertRunRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      runId: Schema.String,
      eventSequence: Schema.NullOr(NonNegativeInt),
      json: Schema.String,
    }),
    execute: (row) => sql`
      INSERT INTO projection_thread_command_runs (thread_id, run_id, event_sequence, run_json)
      VALUES (${row.threadId}, ${row.runId}, ${row.eventSequence}, ${row.json})
      ON CONFLICT (thread_id, run_id)
      DO UPDATE SET event_sequence = excluded.event_sequence, run_json = excluded.run_json
    `,
  });
  const listRunRows = SqlSchema.findAll({
    Request: ThreadInput,
    Result: RunJsonRow,
    execute: ({ threadId }) => sql`
      SELECT run_json AS "json"
      FROM projection_thread_command_runs
      WHERE thread_id = ${threadId}
      ORDER BY event_sequence ASC, run_id ASC
    `,
  });
  const listAllRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      threadId: ThreadId,
      json: Schema.fromJsonString(OrchestrationCommandRun),
    }),
    execute: () => sql`
      SELECT runs.thread_id AS "threadId", runs.run_json AS "json"
      FROM projection_thread_command_runs AS runs
      JOIN projection_threads AS threads ON threads.thread_id = runs.thread_id
      WHERE threads.deleted_at IS NULL
      ORDER BY runs.thread_id ASC, runs.event_sequence ASC
    `,
  });
  const setOutputRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId, runId: Schema.String, output: Schema.String }),
    execute: (row) => sql`
      UPDATE projection_thread_command_runs
      SET output = ${row.output}
      WHERE thread_id = ${row.threadId} AND run_id = ${row.runId}
    `,
  });
  const getOutputRow = SqlSchema.findOneOption({
    Request: RunInput,
    Result: OutputRow,
    execute: ({ threadId, runId }) => sql`
      SELECT output
      FROM projection_thread_command_runs
      WHERE thread_id = ${threadId} AND run_id = ${runId}
      LIMIT 1
    `,
  });

  const fail = (operation: string) =>
    toPersistenceSqlError(`ProjectionThreadCommandRepository.${operation}:query`);

  const upsertRequest: ProjectionThreadCommandRepositoryShape["upsertRequest"] = ({
    threadId,
    request,
  }) =>
    upsertRequestRow({
      threadId,
      requestId: request.requestId,
      eventSequence: request.eventSequence ?? null,
      json: encodeRequest(request),
    }).pipe(Effect.mapError(fail("upsertRequest")));

  const listRequests: ProjectionThreadCommandRepositoryShape["listRequests"] = (input) =>
    listRequestRows(input).pipe(
      Effect.map((rows) => rows.map((row) => row.json)),
      Effect.mapError(fail("listRequests")),
    );

  const deleteRequests: ProjectionThreadCommandRepositoryShape["deleteRequests"] = ({
    threadId,
    requestIds,
  }) =>
    requestIds.length === 0
      ? Effect.void
      : sql`
          DELETE FROM projection_thread_command_requests
          WHERE thread_id = ${threadId} AND request_id IN ${sql.in(requestIds)}
        `.pipe(Effect.asVoid, Effect.mapError(fail("deleteRequests")));

  const upsertRun: ProjectionThreadCommandRepositoryShape["upsertRun"] = ({ threadId, run }) =>
    upsertRunRow({
      threadId,
      runId: run.runId,
      eventSequence: run.eventSequence ?? null,
      json: encodeRun(run),
    }).pipe(Effect.mapError(fail("upsertRun")));

  const listRuns: ProjectionThreadCommandRepositoryShape["listRuns"] = (input) =>
    listRunRows(input).pipe(
      Effect.map((rows) => rows.map((row) => row.json)),
      Effect.mapError(fail("listRuns")),
    );

  const deleteRuns: ProjectionThreadCommandRepositoryShape["deleteRuns"] = ({
    threadId,
    runIds,
  }) =>
    runIds.length === 0
      ? Effect.void
      : sql`
          DELETE FROM projection_thread_command_runs
          WHERE thread_id = ${threadId} AND run_id IN ${sql.in(runIds)}
        `.pipe(Effect.asVoid, Effect.mapError(fail("deleteRuns")));

  const listAllRuns: ProjectionThreadCommandRepositoryShape["listAllRuns"] = () =>
    listAllRunRows(undefined).pipe(
      Effect.map((rows) => rows.map((row) => ({ threadId: row.threadId, run: row.json }))),
      Effect.mapError(fail("listAllRuns")),
    );

  const setRunOutput: ProjectionThreadCommandRepositoryShape["setRunOutput"] = (input) =>
    setOutputRow(input).pipe(Effect.mapError(fail("setRunOutput")));

  const getRunOutput: ProjectionThreadCommandRepositoryShape["getRunOutput"] = (input) =>
    getOutputRow(input).pipe(
      Effect.map((row) => (Option.isSome(row) ? row.value.output : null)),
      Effect.mapError(fail("getRunOutput")),
    );

  return {
    upsertRequest,
    listRequests,
    deleteRequests,
    upsertRun,
    listRuns,
    deleteRuns,
    listAllRuns,
    setRunOutput,
    getRunOutput,
  } satisfies ProjectionThreadCommandRepositoryShape;
});

export const ProjectionThreadCommandRepositoryLive = Layer.effect(
  ProjectionThreadCommandRepository,
  makeProjectionThreadCommandRepository,
);
