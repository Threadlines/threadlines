import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  SideTurnId,
  ChatAttachmentListLenient,
  ChatSkillReferenceList,
  MessageAgentModel,
  NonNegativeInt,
  RoomAgentMessageKind,
  RoomAgentRef,
  RoomAgentRequestId,
  RoomAgentInvite,
  ThreadMessageOrigin,
  RoomAgentRequestOutcome,
  RoomReviewInput,
  ThreadParticipantId,
  TrimmedNonEmptyString,
} from "@threadlines/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionThreadMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    eventSequence: Schema.NullOr(NonNegativeInt),
    attachments: Schema.NullOr(Schema.fromJsonString(ChatAttachmentListLenient)),
    skills: Schema.NullOr(Schema.fromJsonString(ChatSkillReferenceList)),
    participantId: Schema.NullOr(ThreadParticipantId),
    sideTurnId: Schema.NullOr(SideTurnId),
    fromAgent: Schema.NullOr(Schema.fromJsonString(RoomAgentRef)),
    requestId: Schema.NullOr(RoomAgentRequestId),
    requestKind: Schema.NullOr(RoomAgentMessageKind),
    requestOutcome: Schema.NullOr(RoomAgentRequestOutcome),
    requestError: Schema.NullOr(TrimmedNonEmptyString),
    reviewInput: Schema.NullOr(Schema.fromJsonString(RoomReviewInput)),
    invite: Schema.NullOr(Schema.fromJsonString(RoomAgentInvite)),
    fromThread: Schema.NullOr(Schema.fromJsonString(ThreadMessageOrigin)),
    agentModels: Schema.NullOr(
      Schema.fromJsonString(Schema.Record(Schema.String, MessageAgentModel)),
    ),
  }),
);

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    ...(row.eventSequence !== null ? { eventSequence: row.eventSequence } : {}),
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.participantId !== null ? { participantId: row.participantId } : {}),
    ...(row.sideTurnId !== null ? { sideTurnId: row.sideTurnId } : {}),
    ...(row.fromAgent !== null ? { fromAgent: row.fromAgent } : {}),
    ...(row.requestId !== null ? { requestId: row.requestId } : {}),
    ...(row.requestKind !== null ? { requestKind: row.requestKind } : {}),
    ...(row.requestOutcome !== null ? { requestOutcome: row.requestOutcome } : {}),
    ...(row.requestError !== null ? { requestError: row.requestError } : {}),
    ...(row.reviewInput !== null ? { reviewInput: row.reviewInput } : {}),
    ...(row.invite !== null ? { invite: row.invite } : {}),
    ...(row.fromThread !== null ? { fromThread: row.fromThread } : {}),
    ...(row.agentModels !== null ? { agentModels: row.agentModels } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextSkillsJson = row.skills !== undefined ? JSON.stringify(row.skills) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          event_sequence,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          skills_json,
          participant_id,
          side_turn_id,
          from_agent,
          from_thread,
          request_id,
          request_kind,
          request_outcome,
          request_error,
          review_input,
          invite,
          agent_models,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.eventSequence ?? null},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextSkillsJson},
            (
              SELECT skills_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.participantId ?? null},
          ${row.sideTurnId ?? null},
          ${row.fromAgent !== undefined ? JSON.stringify(row.fromAgent) : null},
          ${row.fromThread !== undefined ? JSON.stringify(row.fromThread) : null},
          ${row.requestId ?? null},
          ${row.requestKind ?? null},
          ${row.requestOutcome ?? null},
          ${row.requestError ?? null},
          ${row.reviewInput !== undefined ? JSON.stringify(row.reviewInput) : null},
          ${row.invite !== undefined ? JSON.stringify(row.invite) : null},
          ${row.agentModels !== undefined ? JSON.stringify(row.agentModels) : null},
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          skills_json = COALESCE(
            excluded.skills_json,
            projection_thread_messages.skills_json
          ),
          -- participant_id and side_turn_id are left alone: a message's author
          -- and lane are fixed by the write that created it. The room request
          -- fields are kept when a later write leaves them out.
          from_agent = COALESCE(excluded.from_agent, projection_thread_messages.from_agent),
          from_thread = COALESCE(excluded.from_thread, projection_thread_messages.from_thread),
          request_id = COALESCE(excluded.request_id, projection_thread_messages.request_id),
          request_kind = COALESCE(excluded.request_kind, projection_thread_messages.request_kind),
          request_outcome = COALESCE(
            excluded.request_outcome,
            projection_thread_messages.request_outcome
          ),
          request_error = COALESCE(excluded.request_error, projection_thread_messages.request_error),
          review_input = COALESCE(excluded.review_input, projection_thread_messages.review_input),
          invite = COALESCE(excluded.invite, projection_thread_messages.invite),
          -- The model stamps belong to the write that created the message.
          agent_models = COALESCE(projection_thread_messages.agent_models, excluded.agent_models),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          participant_id AS "participantId",
          side_turn_id AS "sideTurnId",
          from_agent AS "fromAgent",
          from_thread AS "fromThread",
          request_id AS "requestId",
          request_kind AS "requestKind",
          request_outcome AS "requestOutcome",
          request_error AS "requestError",
          review_input AS "reviewInput",
          invite,
          agent_models AS "agentModels",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          participant_id AS "participantId",
          side_turn_id AS "sideTurnId",
          from_agent AS "fromAgent",
          from_thread AS "fromThread",
          request_id AS "requestId",
          request_kind AS "requestKind",
          request_outcome AS "requestOutcome",
          request_error AS "requestError",
          review_input AS "reviewInput",
          invite,
          agent_models AS "agentModels",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY event_sequence ASC, created_at ASC, message_id ASC
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
