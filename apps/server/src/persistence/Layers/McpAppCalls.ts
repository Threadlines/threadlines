import {
  McpAppView,
  ProviderInstanceId,
  RuntimeMcpAppCall,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  McpAppCallKey,
  McpAppCallRepository,
  type McpAppCallRecord,
  type McpAppCallRepositoryShape,
} from "../Services/McpAppCalls.ts";

const McpAppCallRow = Schema.Struct({
  threadId: ThreadId,
  toolCallId: Schema.String,
  participantId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  providerThreadId: Schema.NullOr(Schema.String),
  callJson: Schema.String,
  viewJson: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

/** What `call_json` holds: the call and whether it was cut to fit. */
const StoredCall = Schema.Struct({ call: RuntimeMcpAppCall, truncated: Schema.Boolean });
const decodeStoredCall = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCall));
const decodeView = Schema.decodeUnknownOption(Schema.fromJsonString(McpAppView));
const decodeInstanceId = Schema.decodeUnknownOption(ProviderInstanceId);

/** A stored row as a record; none for a row that no longer decodes (written
 *  by a newer build, after a downgrade). A view that no longer decodes is
 *  read again. */
function decodeRow(row: typeof McpAppCallRow.Type): Option.Option<McpAppCallRecord> {
  return Option.map(decodeStoredCall(row.callJson), (stored) => ({
    threadId: row.threadId,
    toolCallId: row.toolCallId,
    participantId: (row.participantId ?? null) as McpAppCallRecord["participantId"],
    providerInstanceId:
      row.providerInstanceId === null
        ? null
        : Option.getOrNull(decodeInstanceId(row.providerInstanceId)),
    providerThreadId: row.providerThreadId,
    call: stored.call,
    truncated: stored.truncated,
    view: row.viewJson === null ? null : Option.getOrNull(decodeView(row.viewJson)),
    createdAt: row.createdAt,
  }));
}

const makeMcpAppCallRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: McpAppCallKey,
    Result: McpAppCallRow,
    execute: ({ threadId, toolCallId }) => sql`
      SELECT
        thread_id AS "threadId",
        tool_call_id AS "toolCallId",
        participant_id AS "participantId",
        provider_instance_id AS "providerInstanceId",
        provider_thread_id AS "providerThreadId",
        call_json AS "callJson",
        view_json AS "viewJson",
        created_at AS "createdAt"
      FROM mcp_app_calls
      WHERE thread_id = ${threadId} AND tool_call_id = ${toolCallId}
    `,
  });

  const upsert: McpAppCallRepositoryShape["upsert"] = (record) =>
    sql`
      INSERT INTO mcp_app_calls (
        thread_id, tool_call_id, participant_id, provider_instance_id,
        provider_thread_id, call_json, view_json, created_at
      )
      VALUES (
        ${record.threadId}, ${record.toolCallId}, ${record.participantId},
        ${record.providerInstanceId}, ${record.providerThreadId},
        ${JSON.stringify({ call: record.call, truncated: record.truncated })}, NULL,
        ${record.createdAt}
      )
      ON CONFLICT (thread_id, tool_call_id) DO UPDATE SET
        participant_id = excluded.participant_id,
        provider_instance_id = excluded.provider_instance_id,
        provider_thread_id = excluded.provider_thread_id,
        call_json = excluded.call_json
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("McpAppCallRepository.upsert:query")),
    );

  const get: McpAppCallRepositoryShape["get"] = (key) =>
    getRow(key).pipe(
      Effect.map(Option.flatMap(decodeRow)),
      Effect.mapError(toPersistenceSqlError("McpAppCallRepository.get:query")),
    );

  const setView: McpAppCallRepositoryShape["setView"] = (key, view) =>
    sql`
      UPDATE mcp_app_calls SET view_json = ${JSON.stringify(view)}
      WHERE thread_id = ${key.threadId} AND tool_call_id = ${key.toolCallId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("McpAppCallRepository.setView:query")),
    );

  const deleteByThreadId: McpAppCallRepositoryShape["deleteByThreadId"] = (threadId) =>
    sql`DELETE FROM mcp_app_calls WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("McpAppCallRepository.deleteByThreadId:query")),
    );

  return { upsert, get, setView, deleteByThreadId } satisfies McpAppCallRepositoryShape;
});

export const McpAppCallRepositoryLive = Layer.effect(
  McpAppCallRepository,
  makeMcpAppCallRepository,
);
