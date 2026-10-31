/**
 * Outside agents' starts, sends and stops, by the caller's request id
 * (migration 089, `outside_agent_requests`; docs/design/outside-agents.md,
 * "Retries").
 *
 * A start or send claims its (connection, requestId) once its checks pass and
 * before it dispatches anything: `starting`, with the input's hash and the
 * ids it dispatches with. It ends `done` with its answer, or is released
 * when it was refused before anything happened, so the same requestId can
 * try again. A row still `starting` when the server starts was cut off by a
 * restart: it turns `failed`, and a retry answers from what it left (its
 * thread, its command's receipt), never running it again. Rows go 24 hours
 * after they were made; the starts among them are the connection's daily
 * count.
 *
 * An assistant's start answers before its setup runs
 * (docs/design/assistants.md, "Tools"), so its row is the durable record of
 * the start: it ends `done` with the answer, or `failed` with why
 * (`fail`), and its thread id finds it (`findStart`).
 */
import { CommandId, IsoDateTime, OutsideAgentConnectionId, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** How long a request is remembered: a retry later than this is a new call. */
export const OUTSIDE_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

export const OutsideAgentRequestState = Schema.Literals(["starting", "done", "failed"]);
export type OutsideAgentRequestState = typeof OutsideAgentRequestState.Type;

export const OutsideAgentRequestTool = Schema.Literals([
  "thread_start",
  "thread_send",
  "thread_stop",
  "thread_answer",
]);
export type OutsideAgentRequestTool = typeof OutsideAgentRequestTool.Type;

export const OutsideAgentRequestRow = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  requestId: Schema.String,
  tool: OutsideAgentRequestTool,
  inputHash: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  commandId: Schema.NullOr(CommandId),
  state: OutsideAgentRequestState,
  /** The answer, once `done`: the tool's result as JSON. */
  resultJson: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type OutsideAgentRequestRow = typeof OutsideAgentRequestRow.Type;

export class OutsideAgentRequestsError extends Data.TaggedError("OutsideAgentRequestsError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface OutsideAgentRequestsShape {
  readonly get: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly requestId: string;
  }) => Effect.Effect<Option.Option<OutsideAgentRequestRow>, OutsideAgentRequestsError>;
  /**
   * Claims a request as `starting`. False when the connection already has a
   * row under that request id (read it with `get`).
   */
  readonly claim: (
    row: Omit<OutsideAgentRequestRow, "state" | "resultJson">,
  ) => Effect.Effect<boolean, OutsideAgentRequestsError>;
  /** The request answered: `done`, with the answer. */
  readonly finish: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly requestId: string;
    readonly resultJson: string;
  }) => Effect.Effect<void, OutsideAgentRequestsError>;
  /**
   * The request failed after its answer went out (an assistant's start whose
   * setup failed): `failed`, with the answer a retry or a read gets.
   */
  readonly fail: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly requestId: string;
    readonly resultJson: string;
  }) => Effect.Effect<void, OutsideAgentRequestsError>;
  /** The start that set `threadId` up for the connection, if its row is still kept. */
  readonly findStart: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<OutsideAgentRequestRow>, OutsideAgentRequestsError>;
  /** The request was refused before anything happened: forgotten, so it can be tried again. */
  readonly release: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly requestId: string;
  }) => Effect.Effect<void, OutsideAgentRequestsError>;
  /** How many threads the connection started (or began to) since `since`. */
  readonly countStartsSince: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly since: string;
  }) => Effect.Effect<number, OutsideAgentRequestsError>;
  /** Drops the rows made before `before`. */
  readonly prune: (input: {
    readonly before: string;
  }) => Effect.Effect<void, OutsideAgentRequestsError>;
}

export class OutsideAgentRequests extends Context.Service<
  OutsideAgentRequests,
  OutsideAgentRequestsShape
>()("threadlines/outsideAgents/OutsideAgentRequests") {}

const RowKey = Schema.Struct({ connectionId: Schema.String, requestId: Schema.String });
const ThreadKey = Schema.Struct({ connectionId: Schema.String, threadId: Schema.String });

const SELECT_ROW = `
  SELECT
    connection_id AS "connectionId",
    request_id AS "requestId",
    tool,
    input_hash AS "inputHash",
    thread_id AS "threadId",
    command_id AS "commandId",
    state,
    result_json AS "resultJson",
    created_at AS "createdAt"
  FROM outside_agent_requests
`;

/** Builds the store; rows a restart cut off (`starting`) turn `failed` first. */
export const makeOutsideAgentRequests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new OutsideAgentRequestsError({ operation, cause })));

  yield* sql`
    UPDATE outside_agent_requests SET state = 'failed' WHERE state = 'starting'
  `.pipe(wrap("failInterrupted"));

  const findOne = SqlSchema.findOneOption({
    Request: RowKey,
    Result: OutsideAgentRequestRow,
    execute: ({ connectionId, requestId }) =>
      sql.unsafe(`${SELECT_ROW} WHERE connection_id = ? AND request_id = ?`, [
        connectionId,
        requestId,
      ]),
  });

  const findByThread = SqlSchema.findOneOption({
    Request: ThreadKey,
    Result: OutsideAgentRequestRow,
    execute: ({ connectionId, threadId }) =>
      sql.unsafe(
        `${SELECT_ROW} WHERE connection_id = ? AND thread_id = ? AND tool = 'thread_start' ORDER BY created_at DESC LIMIT 1`,
        [connectionId, threadId],
      ),
  });

  const get: OutsideAgentRequestsShape["get"] = (input) => findOne(input).pipe(wrap("get"));

  const claim: OutsideAgentRequestsShape["claim"] = (row) =>
    sql<{ readonly requestId: string }>`
      INSERT INTO outside_agent_requests (
        connection_id, request_id, tool, input_hash, thread_id, command_id, state, created_at
      ) VALUES (
        ${row.connectionId}, ${row.requestId}, ${row.tool}, ${row.inputHash}, ${row.threadId},
        ${row.commandId}, 'starting', ${row.createdAt}
      )
      ON CONFLICT (connection_id, request_id) DO NOTHING
      RETURNING request_id AS "requestId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("claim"),
    );

  const finish: OutsideAgentRequestsShape["finish"] = (input) =>
    sql`
      UPDATE outside_agent_requests
      SET state = 'done', result_json = ${input.resultJson}
      WHERE connection_id = ${input.connectionId} AND request_id = ${input.requestId}
    `.pipe(Effect.asVoid, wrap("finish"));

  const fail: OutsideAgentRequestsShape["fail"] = (input) =>
    sql`
      UPDATE outside_agent_requests
      SET state = 'failed', result_json = ${input.resultJson}
      WHERE connection_id = ${input.connectionId} AND request_id = ${input.requestId}
    `.pipe(Effect.asVoid, wrap("fail"));

  const findStart: OutsideAgentRequestsShape["findStart"] = (input) =>
    findByThread(input).pipe(wrap("findStart"));

  const release: OutsideAgentRequestsShape["release"] = (input) =>
    sql`
      DELETE FROM outside_agent_requests
      WHERE connection_id = ${input.connectionId} AND request_id = ${input.requestId}
    `.pipe(Effect.asVoid, wrap("release"));

  const countStartsSince: OutsideAgentRequestsShape["countStartsSince"] = (input) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count"
      FROM outside_agent_requests
      WHERE connection_id = ${input.connectionId}
        AND tool = 'thread_start'
        AND created_at >= ${input.since}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      wrap("countStartsSince"),
    );

  const prune: OutsideAgentRequestsShape["prune"] = (input) =>
    sql`
      DELETE FROM outside_agent_requests WHERE created_at < ${input.before}
    `.pipe(Effect.asVoid, wrap("prune"));

  return {
    get,
    claim,
    finish,
    fail,
    findStart,
    release,
    countStartsSince,
    prune,
  } satisfies OutsideAgentRequestsShape;
});

export const OutsideAgentRequestsLive = Layer.effect(
  OutsideAgentRequests,
  makeOutsideAgentRequests,
);
