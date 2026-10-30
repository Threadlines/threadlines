import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  OrchestrationAwaitedBackgroundTask,
  OrchestrationContinueAtReset,
  OrchestrationSessionStartup,
  OrchestrationSessionUsageLimit,
} from "@threadlines/contracts";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  DismissProjectionThreadSessionErrorInput,
  GetProjectionThreadSessionInput,
  ProjectionThreadContinueAtReset,
  SetProjectionThreadSessionContinueAtResetInput,
} from "../Services/ProjectionThreadSessions.ts";

const ProjectionThreadSessionDbRow = ProjectionThreadSession.mapFields(
  Struct.assign({
    awaitedBackgroundTasks: Schema.fromJsonString(Schema.Array(OrchestrationAwaitedBackgroundTask)),
    startup: Schema.optional(Schema.NullOr(Schema.fromJsonString(OrchestrationSessionStartup))),
    lastErrorUsageLimit: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(OrchestrationSessionUsageLimit)),
    ),
    continueAtReset: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(OrchestrationContinueAtReset)),
    ),
  }),
);

const ProjectionThreadContinueAtResetDbRow = ProjectionThreadContinueAtReset.mapFields(
  Struct.assign({
    continueAtReset: Schema.fromJsonString(OrchestrationContinueAtReset),
  }),
);

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          checkout_cwd,
          participant_id,
          active_turn_id,
          pending_background_task_count,
          awaited_background_task_count,
          awaited_background_tasks,
          startup,
          last_error,
          last_error_at,
          last_error_dismissed_at,
          last_error_usage_limit,
          continue_at_reset,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId},
          ${row.providerSessionId},
          ${row.providerThreadId},
          ${row.runtimeMode},
          ${row.checkoutCwd},
          CASE
            WHEN ${row.participantId === undefined ? 1 : 0} = 1 THEN (
              SELECT participant_id
              FROM projection_thread_sessions
              WHERE thread_id = ${row.threadId}
            )
            ELSE ${row.participantId ?? null}
          END,
          ${row.activeTurnId},
          ${row.pendingBackgroundTaskCount},
          ${row.awaitedBackgroundTaskCount},
          ${JSON.stringify(row.awaitedBackgroundTasks)},
          CASE
            WHEN ${row.startup === undefined ? 1 : 0} = 1 THEN (
              SELECT startup
              FROM projection_thread_sessions
              WHERE thread_id = ${row.threadId}
            )
            ELSE ${row.startup == null ? null : JSON.stringify(row.startup)}
          END,
          ${row.lastError},
          ${row.lastErrorAt ?? null},
          ${row.lastErrorDismissedAt ?? null},
          ${row.lastErrorUsageLimit == null ? null : JSON.stringify(row.lastErrorUsageLimit)},
          ${row.continueAtReset == null ? null : JSON.stringify(row.continueAtReset)},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          provider_session_id = excluded.provider_session_id,
          provider_thread_id = excluded.provider_thread_id,
          runtime_mode = excluded.runtime_mode,
          checkout_cwd = excluded.checkout_cwd,
          participant_id = excluded.participant_id,
          active_turn_id = excluded.active_turn_id,
          pending_background_task_count = excluded.pending_background_task_count,
          awaited_background_task_count = excluded.awaited_background_task_count,
          awaited_background_tasks = excluded.awaited_background_tasks,
          startup = excluded.startup,
          last_error = excluded.last_error,
          last_error_at = excluded.last_error_at,
          last_error_dismissed_at = excluded.last_error_dismissed_at,
          last_error_usage_limit = excluded.last_error_usage_limit,
          continue_at_reset = excluded.continue_at_reset,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSessionDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          checkout_cwd AS "checkoutCwd",
          participant_id AS "participantId",
          active_turn_id AS "activeTurnId",
          pending_background_task_count AS "pendingBackgroundTaskCount",
          awaited_background_task_count AS "awaitedBackgroundTaskCount",
          awaited_background_tasks AS "awaitedBackgroundTasks",
          startup,
          last_error AS "lastError",
          last_error_at AS "lastErrorAt",
          last_error_dismissed_at AS "lastErrorDismissedAt",
          last_error_usage_limit AS "lastErrorUsageLimit",
          continue_at_reset AS "continueAtReset",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const dismissProjectionThreadSessionError = SqlSchema.void({
    Request: DismissProjectionThreadSessionErrorInput,
    execute: ({ threadId, lastError, lastErrorAt, dismissedAt }) =>
      sql`
        UPDATE projection_thread_sessions
        SET last_error_dismissed_at = ${dismissedAt}
        WHERE thread_id = ${threadId}
          AND last_error = ${lastError}
          AND last_error_at IS ${lastErrorAt}
      `,
  });

  const setProjectionThreadSessionContinueAtReset = SqlSchema.void({
    Request: SetProjectionThreadSessionContinueAtResetInput,
    execute: ({ threadId, lastErrorAt, continueAtReset }) =>
      sql`
        UPDATE projection_thread_sessions
        SET continue_at_reset = ${continueAtReset === null ? null : JSON.stringify(continueAtReset)}
        WHERE thread_id = ${threadId}
          AND last_error_at IS ${lastErrorAt}
      `,
  });

  const listProjectionThreadContinueAtReset = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadContinueAtResetDbRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          last_error_at AS "lastErrorAt",
          provider_instance_id AS "providerInstanceId",
          continue_at_reset AS "continueAtReset"
        FROM projection_thread_sessions
        WHERE continue_at_reset IS NOT NULL
          AND last_error_at IS NOT NULL
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const dismissError: ProjectionThreadSessionRepositoryShape["dismissError"] = (input) =>
    dismissProjectionThreadSessionError(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.dismissError:query"),
      ),
    );

  const setContinueAtReset: ProjectionThreadSessionRepositoryShape["setContinueAtReset"] = (
    input,
  ) =>
    setProjectionThreadSessionContinueAtReset(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.setContinueAtReset:query"),
      ),
    );

  const listContinueAtReset: ProjectionThreadSessionRepositoryShape["listContinueAtReset"] = () =>
    listProjectionThreadContinueAtReset(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.listContinueAtReset:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    dismissError,
    setContinueAtReset,
    listContinueAtReset,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
