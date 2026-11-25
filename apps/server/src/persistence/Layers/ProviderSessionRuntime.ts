import { ThreadId } from "@threadlines/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../Services/ProviderSessionRuntime.ts";

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const decodeRuntime = Schema.decodeUnknownEffect(ProviderSessionRuntime);

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const ThreadIdRowSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProviderSessionRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.providerInstanceId},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const listActiveRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE status != 'stopped'
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const listRuntimeThreadIdRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadIdRowSchema,
    execute: () =>
      sql`
        SELECT thread_id AS "threadId"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const listRuntimeThreadIdRowsForThread = SqlSchema.findAll({
    Request: GetRuntimeRequestSchema,
    Result: ThreadIdRowSchema,
    execute: ({ threadId }) => {
      // Room participant keys are `<threadId>__agent__<participantId>` and side
      // keys are `<threadId>__side__...`. Bound each with `[prefix, prefixEnd)`
      // where '`' (0x60) immediately follows '_' (0x5f) so SQLite uses the
      // primary-key index without LIKE wildcard escaping bugs.
      const agentPrefix = `${threadId}__agent__`;
      const agentPrefixEnd = `${threadId}__agent_\``;
      const sidePrefix = `${threadId}__side__`;
      const sidePrefixEnd = `${threadId}__side_\``;
      return sql`
        SELECT thread_id AS "threadId"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
           OR (thread_id >= ${agentPrefix} AND thread_id < ${agentPrefixEnd})
           OR (thread_id >= ${sidePrefix} AND thread_id < ${sidePrefixEnd})
        ORDER BY last_seen_at ASC, thread_id ASC
      `;
    },
  });

  const getRuntimeRowsByThreadIds = SqlSchema.findAll({
    Request: Schema.Array(ThreadId),
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: (threadIds) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE ${sql.in("thread_id", threadIds)}
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const patchIfSession: ProviderSessionRuntimeRepositoryShape["patchIfSession"] = (input) =>
    sql<{ readonly threadId: string }>`
      UPDATE provider_session_runtime
      SET
        runtime_payload_json = json_patch(
          COALESCE(runtime_payload_json, '{}'),
          ${JSON.stringify(input.runtimePayload)}
        ),
        resume_cursor_json = CASE
          WHEN ${input.clearResumeCursor === true ? 1 : 0} = 1 THEN NULL
          ELSE resume_cursor_json
        END,
        last_seen_at = ${input.lastSeenAt}
      WHERE thread_id = ${input.threadId}
        AND json_extract(runtime_payload_json, '$.sessionCreatedAt') = ${input.sessionCreatedAt}
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        toPersistenceSqlError("ProviderSessionRuntimeRepository.patchIfSession:query"),
      ),
    );

  const upsert: ProviderSessionRuntimeRepositoryShape["upsert"] = (runtime) =>
    upsertRuntimeRow(runtime).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByThreadId: ProviderSessionRuntimeRepositoryShape["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderSessionRuntimeRepository.getByThreadId:rowToRuntime",
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepositoryShape["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderSessionRuntimeRepository.list:rowToRuntime"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const listActive: NonNullable<ProviderSessionRuntimeRepositoryShape["listActive"]> = () =>
    listActiveRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.listActive:query",
          "ProviderSessionRuntimeRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderSessionRuntimeRepository.listActive:rowToRuntime",
                ),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const markAllStopped: NonNullable<ProviderSessionRuntimeRepositoryShape["markAllStopped"]> = (
    input,
  ) =>
    sql`
      UPDATE provider_session_runtime
      SET
        status = 'stopped',
        last_seen_at = ${input.lastSeenAt},
        runtime_payload_json = CASE
          WHEN json_type(runtime_payload_json) = 'object' THEN json_set(
            runtime_payload_json,
            '$.activeTurnId', json('null'),
            '$.lastRuntimeEvent', ${input.lastRuntimeEvent},
            '$.lastRuntimeEventAt', ${input.lastRuntimeEventAt}
          )
          ELSE json_object(
            'activeTurnId', NULL,
            'lastRuntimeEvent', ${input.lastRuntimeEvent},
            'lastRuntimeEventAt', ${input.lastRuntimeEventAt}
          )
        END
      WHERE status != 'stopped'
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("ProviderSessionRuntimeRepository.markAllStopped:query"),
      ),
    );

  const listThreadIds: NonNullable<ProviderSessionRuntimeRepositoryShape["listThreadIds"]> = () =>
    listRuntimeThreadIdRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.listThreadIds:query",
          "ProviderSessionRuntimeRepository.listThreadIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listThreadIdsForThread: NonNullable<
    ProviderSessionRuntimeRepositoryShape["listThreadIdsForThread"]
  > = (input) =>
    listRuntimeThreadIdRowsForThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.listThreadIdsForThread:query",
          "ProviderSessionRuntimeRepository.listThreadIdsForThread:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const GET_BY_THREAD_IDS_CHUNK_SIZE = 500;
  const getByThreadIds: NonNullable<ProviderSessionRuntimeRepositoryShape["getByThreadIds"]> = (
    threadIds,
  ) =>
    Effect.gen(function* () {
      if (threadIds.length === 0) {
        return [];
      }
      const chunks: Array<ReadonlyArray<ThreadId>> = [];
      for (let i = 0; i < threadIds.length; i += GET_BY_THREAD_IDS_CHUNK_SIZE) {
        chunks.push(threadIds.slice(i, i + GET_BY_THREAD_IDS_CHUNK_SIZE));
      }
      const rowChunks = yield* Effect.forEach(
        chunks,
        (chunk) =>
          getRuntimeRowsByThreadIds(chunk).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProviderSessionRuntimeRepository.getByThreadIds:query",
                "ProviderSessionRuntimeRepository.getByThreadIds:decodeRows",
              ),
            ),
          ),
        { concurrency: 1 },
      );
      const rows = rowChunks.flat();
      return yield* Effect.forEach(
        rows,
        (row) =>
          decodeRuntime(row).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProviderSessionRuntimeRepository.getByThreadIds:rowToRuntime",
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

  const deleteByThreadId: ProviderSessionRuntimeRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRuntimeByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSessionRuntimeRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    patchIfSession,
    getByThreadId,
    getByThreadIds,
    list,
    listActive,
    markAllStopped,
    listThreadIds,
    listThreadIdsForThread,
    deleteByThreadId,
  } satisfies ProviderSessionRuntimeRepositoryShape;
});

export const ProviderSessionRuntimeRepositoryLive = Layer.effect(
  ProviderSessionRuntimeRepository,
  makeProviderSessionRuntimeRepository,
);
