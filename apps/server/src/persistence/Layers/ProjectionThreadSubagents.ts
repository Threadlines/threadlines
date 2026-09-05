import { NonNegativeInt, type OrchestrationSubagent } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadSubagent,
  ProjectionThreadSubagentRepository,
  ProjectionThreadSubagentThreadInput,
  type ProjectionThreadSubagentRepositoryShape,
} from "../Services/ProjectionThreadSubagents.ts";

/** SQLite keeps the optional flag as NULL/0/1. */
export const ProjectionThreadSubagentDbRowSchema = ProjectionThreadSubagent.mapFields(
  Struct.assign({
    isBackgrounded: Schema.NullOr(Schema.Number),
    resultEventSequence: Schema.NullOr(NonNegativeInt),
    liveEventSequence: Schema.NullOr(NonNegativeInt),
  }),
);

export function toProjectionThreadSubagent(
  row: Schema.Schema.Type<typeof ProjectionThreadSubagentDbRowSchema>,
): ProjectionThreadSubagent {
  const { isBackgrounded, resultEventSequence, liveEventSequence, ...rest } = row;
  return {
    ...rest,
    ...(isBackgrounded !== null ? { isBackgrounded: isBackgrounded === 1 } : {}),
    ...(resultEventSequence !== null ? { resultEventSequence } : {}),
    ...(liveEventSequence !== null ? { liveEventSequence } : {}),
  };
}

export function subagentBackgroundedColumn(row: OrchestrationSubagent): number | null {
  return row.isBackgrounded === undefined ? null : row.isBackgrounded ? 1 : 0;
}

const makeProjectionThreadSubagentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: ProjectionThreadSubagentThreadInput,
    Result: ProjectionThreadSubagentDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId", subagent_id AS "id", agent_thread_id AS "agentThreadId",
        parent_agent_thread_id AS "parentAgentThreadId",
        spawn_call_id AS "spawnCallId", transcript_agent_id AS "transcriptAgentId",
        turn_id AS "turnId", agent_path AS "agentPath", parent_agent_path AS "parentAgentPath",
        tree_depth AS "treeDepth", is_backgrounded AS "isBackgrounded",
        nickname, role, objective, status,
        requested_model AS "requestedModel", resolved_model AS "resolvedModel",
        reasoning_effort AS "reasoningEffort", model_provenance AS "modelProvenance",
        reasoning_effort_provenance AS "reasoningEffortProvenance",
        result_body AS "resultBody", result_created_at AS "resultCreatedAt",
        result_event_sequence AS "resultEventSequence", live_event_sequence AS "liveEventSequence",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_subagents
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, subagent_id ASC
    `,
  });

  const listByThreadId: ProjectionThreadSubagentRepositoryShape["listByThreadId"] = (input) =>
    listRows(input).pipe(
      Effect.map((rows) => rows.map(toProjectionThreadSubagent)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSubagentRepository.listByThreadId:query"),
      ),
    );

  const replaceByThreadId: ProjectionThreadSubagentRepositoryShape["replaceByThreadId"] = (
    threadId,
    rows,
  ) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_thread_subagents WHERE thread_id = ${threadId}`;
      if (rows.length === 0) return;
      yield* sql`
        INSERT INTO projection_thread_subagents ${sql.insert(
          rows.map((row: OrchestrationSubagent) => ({
            thread_id: threadId,
            subagent_id: row.id,
            agent_thread_id: row.agentThreadId,
            parent_agent_thread_id: row.parentAgentThreadId,
            spawn_call_id: row.spawnCallId,
            transcript_agent_id: row.transcriptAgentId,
            turn_id: row.turnId,
            agent_path: row.agentPath,
            parent_agent_path: row.parentAgentPath,
            tree_depth: row.treeDepth,
            is_backgrounded: subagentBackgroundedColumn(row),
            nickname: row.nickname,
            role: row.role,
            objective: row.objective,
            status: row.status,
            requested_model: row.requestedModel,
            resolved_model: row.resolvedModel,
            reasoning_effort: row.reasoningEffort,
            model_provenance: row.modelProvenance,
            reasoning_effort_provenance: row.reasoningEffortProvenance,
            result_body: row.resultBody,
            result_event_sequence: row.resultEventSequence ?? null,
            live_event_sequence: row.liveEventSequence ?? null,
            result_created_at: row.resultCreatedAt,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
          })),
        )}
      `;
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSubagentRepository.replaceByThreadId:query"),
      ),
    );

  return { listByThreadId, replaceByThreadId } satisfies ProjectionThreadSubagentRepositoryShape;
});

export const ProjectionThreadSubagentRepositoryLive = Layer.effect(
  ProjectionThreadSubagentRepository,
  makeProjectionThreadSubagentRepository,
);
