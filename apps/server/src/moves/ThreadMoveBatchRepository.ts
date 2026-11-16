/**
 * Threads queued to move together (`moves.queueMany`, docs/design/fleet.md,
 * Part 3c): one row per batch, with every thread asked for and the queued
 * move each got, and the refusals given at queue time. `moves.batchStatus`
 * reads it with each thread's own move state; nothing else changes it.
 */
import {
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  ThreadMoveBatchId,
  ThreadMoveRequestId,
  TrimmedNonEmptyString,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** One thread asked for, and the queued move named for it before it was queued. */
export const ThreadMoveBatchMemberRow = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.optional(ThreadMoveRequestId),
});
export type ThreadMoveBatchMemberRow = typeof ThreadMoveBatchMemberRow.Type;

export const ThreadMoveBatchRefusalRow = Schema.Struct({
  threadId: ThreadId,
  words: TrimmedNonEmptyString,
});
export type ThreadMoveBatchRefusalRow = typeof ThreadMoveBatchRefusalRow.Type;

export const ThreadMoveBatchRow = Schema.Struct({
  batchId: ThreadMoveBatchId,
  targetEnvironmentId: EnvironmentId,
  targetLabel: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  members: Schema.Array(ThreadMoveBatchMemberRow),
  refused: Schema.Array(ThreadMoveBatchRefusalRow),
});
export type ThreadMoveBatchRow = typeof ThreadMoveBatchRow.Type;

const ThreadMoveBatchDbRow = Schema.Struct({
  ...ThreadMoveBatchRow.fields,
  members: Schema.fromJsonString(Schema.Array(ThreadMoveBatchMemberRow)),
  refused: Schema.fromJsonString(Schema.Array(ThreadMoveBatchRefusalRow)),
});
const encodeRow = Schema.encodeEffect(ThreadMoveBatchDbRow);

export class ThreadMoveBatchRepositoryError extends Data.TaggedError(
  "ThreadMoveBatchRepositoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ThreadMoveBatchRepositoryShape {
  /** Records the batch, or replaces what it says (its members' queued moves, its refusals). */
  readonly upsert: (row: ThreadMoveBatchRow) => Effect.Effect<void, ThreadMoveBatchRepositoryError>;
  readonly get: (
    batchId: ThreadMoveBatchId,
  ) => Effect.Effect<Option.Option<ThreadMoveBatchRow>, ThreadMoveBatchRepositoryError>;
}

export class ThreadMoveBatchRepository extends Context.Service<
  ThreadMoveBatchRepository,
  ThreadMoveBatchRepositoryShape
>()("threadlines/moves/ThreadMoveBatchRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ThreadMoveBatchRepositoryError({ operation, cause })),
      );

  const upsert: ThreadMoveBatchRepositoryShape["upsert"] = (row) =>
    Effect.gen(function* () {
      const encoded = yield* encodeRow(row);
      yield* sql`
        INSERT INTO thread_move_batches (
          batch_id, target_environment_id, target_label, created_at, members_json, refused_json
        ) VALUES (
          ${encoded.batchId}, ${encoded.targetEnvironmentId}, ${encoded.targetLabel},
          ${encoded.createdAt}, ${encoded.members}, ${encoded.refused}
        )
        ON CONFLICT(batch_id) DO UPDATE SET
          members_json = excluded.members_json,
          refused_json = excluded.refused_json
      `;
    }).pipe(wrap("upsert"));

  const findOne = SqlSchema.findOneOption({
    Request: ThreadMoveBatchId,
    Result: ThreadMoveBatchDbRow,
    execute: (batchId) => sql`
      SELECT
        batch_id AS "batchId",
        target_environment_id AS "targetEnvironmentId",
        target_label AS "targetLabel",
        created_at AS "createdAt",
        members_json AS "members",
        refused_json AS "refused"
      FROM thread_move_batches
      WHERE batch_id = ${batchId}
    `,
  });

  const get: ThreadMoveBatchRepositoryShape["get"] = (batchId) =>
    findOne(batchId).pipe(wrap("get"));

  return ThreadMoveBatchRepository.of({ upsert, get });
});

export const ThreadMoveBatchRepositoryLive = Layer.effect(ThreadMoveBatchRepository, make);
