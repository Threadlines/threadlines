/**
 * Storage for alerts to a web address (migration 096, docs/design/assistants.md
 * "Build plan: step 4"): the targets and one delivery row per event that
 * matched one. Times are ISO strings (UTC), so they compare as text.
 *
 * Every write that moves a delivery on moves its target's watermark in the
 * same transaction: the highest `seq` at or below which every event is final
 * for the target, so an event still retrying is never skipped.
 */
import {
  AssistantAlertTargetId,
  IsoDateTime,
  ProjectId,
  type ProjectId as ProjectIdType,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { type AssistantEventName, AssistantEventNameSchema } from "./AssistantEvents.ts";

export class AssistantAlertRepositoryError extends Data.TaggedError(
  "AssistantAlertRepositoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export const AlertTargetState = Schema.Literals(["on", "off", "gone", "deleting"]);
export type AlertTargetState = typeof AlertTargetState.Type;

const AlertTargetDbRow = Schema.Struct({
  targetId: AssistantAlertTargetId,
  url: Schema.String,
  names: Schema.fromJsonString(Schema.Array(AssistantEventNameSchema)),
  projectIds: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProjectId))),
  skipViewed: Schema.Number,
  authorizationSecret: Schema.NullOr(Schema.String),
  state: AlertTargetState,
  scannedSeq: Schema.Number,
  watermark: Schema.Number,
  refusedStreak: Schema.Number,
  refusedSince: Schema.NullOr(IsoDateTime),
  lastSentAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  retrying: Schema.Number,
});

export interface AlertTargetRow {
  readonly targetId: AssistantAlertTargetId;
  readonly url: string;
  readonly names: ReadonlyArray<AssistantEventName>;
  /** Null: every project. */
  readonly projectIds: ReadonlyArray<ProjectIdType> | null;
  readonly skipViewed: boolean;
  /** The secret store entry holding its Authorization value; null: none. */
  readonly authorizationSecret: string | null;
  readonly state: AlertTargetState;
  /** How far through the record it looked for events. */
  readonly scannedSeq: number;
  /** Every event at or below this `seq` is final for it. */
  readonly watermark: number;
  readonly refusedStreak: number;
  readonly refusedSince: string | null;
  readonly lastSentAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  /** Deliveries waiting for another try. */
  readonly retrying: number;
}

const DeliveryDbRow = Schema.Struct({
  targetId: AssistantAlertTargetId,
  seq: Schema.Number,
  eventId: Schema.String,
  attempts: Schema.Number,
  queuedAt: IsoDateTime,
  nextAttemptAt: IsoDateTime,
});
export type AlertDeliveryRow = typeof DeliveryDbRow.Type;

/** How one delivery ended, or that it waits for another try. */
export type DeliveryOutcome =
  | { readonly state: "sent" | "dropped" | "failed" }
  | { readonly state: "pending"; readonly nextAttemptAt: string };

/** What a send says about the target itself. */
export type TargetNote =
  | { readonly type: "sent"; readonly at: string }
  | {
      readonly type: "error";
      readonly detail: string;
      /** A 401 or 403: one more in a row. */
      readonly refused: boolean;
      readonly at: string;
    }
  | { readonly type: "none" };

/** 401 or 403 this many times in a row shows as refused by the receiver. */
export const REFUSED_STREAK = 3;

export interface AssistantAlertRepositoryShape {
  /** Every target, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<AlertTargetRow>, AssistantAlertRepositoryError>;
  readonly get: (
    targetId: AssistantAlertTargetId,
  ) => Effect.Effect<Option.Option<AlertTargetRow>, AssistantAlertRepositoryError>;
  /** Targets that are on: while there is one, the record runs. */
  readonly countOn: Effect.Effect<number, AssistantAlertRepositoryError>;
  readonly insert: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly url: string;
    readonly names: ReadonlyArray<AssistantEventName>;
    readonly projectIds: ReadonlyArray<ProjectIdType> | null;
    readonly skipViewed: boolean;
    readonly authorizationSecret: string | null;
    /** The record's last `seq` when it was made: nothing before it is sent. */
    readonly startSeq: number;
    readonly now: string;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /** Edit. `newCredentials` (a new address or Authorization) forgets the receiver's refusals. */
  readonly update: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly url: string;
    readonly names: ReadonlyArray<AssistantEventName>;
    readonly projectIds: ReadonlyArray<ProjectIdType> | null;
    readonly skipViewed: boolean;
    /** The entry its Authorization value is in now; left out: as it is. */
    readonly authorizationSecret?: string | null;
    readonly newCredentials: boolean;
    readonly now: string;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /**
   * On from `startSeq` (nothing it missed is sent), or off. Either way its
   * open deliveries are dropped, so turning it on again never replays.
   */
  readonly setState: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly state: "on" | "off" | "gone" | "deleting";
    readonly startSeq?: number;
    readonly now: string;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /** Forgets the target and its deliveries. */
  readonly delete: (
    targetId: AssistantAlertTargetId,
  ) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /**
   * Adds a pending delivery per event (an event already queued keeps its
   * row) and records that the target looked through `scannedSeq`.
   */
  readonly queue: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly events: ReadonlyArray<{ readonly seq: number; readonly eventId: string }>;
    readonly scannedSeq: number;
    readonly now: string;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /** A target's pending deliveries due by `now`, oldest event first. */
  readonly due: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<AlertDeliveryRow>, AssistantAlertRepositoryError>;
  /** The soonest retry of a target that's on. */
  readonly nextDueAt: Effect.Effect<Option.Option<string>, AssistantAlertRepositoryError>;
  /**
   * Written before the call: one more attempt, `in_flight`. If this process
   * dies before the answer, the delivery ends `failed`, never sent twice.
   */
  readonly beginAttempt: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly seq: number;
    readonly now: string;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /** A delivery moves on, the target's note and watermark with it. */
  readonly settle: (input: {
    readonly targetId: AssistantAlertTargetId;
    readonly seq: number;
    readonly outcome: DeliveryOutcome;
    readonly note: TargetNote;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /** Notes a send outside the deliveries (a test). */
  readonly note: (
    targetId: AssistantAlertTargetId,
    note: TargetNote,
  ) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /**
   * Deliveries left `in_flight` (by a crash, or a write that failed after the
   * call) may have arrived, so they end `failed`, and their targets say so.
   * Every target's at start; one target's under its lock.
   */
  readonly failInFlight: (input: {
    readonly targetId?: AssistantAlertTargetId;
    readonly detail: string;
    readonly now: string;
  }) => Effect.Effect<void, AssistantAlertRepositoryError>;
  /** Forgets final deliveries queued before `before`. */
  readonly prune: (before: string) => Effect.Effect<void, AssistantAlertRepositoryError>;
}

export class AssistantAlertRepository extends Context.Service<
  AssistantAlertRepository,
  AssistantAlertRepositoryShape
>()("threadlines/assistants/AssistantAlertRepository") {}

const fromDb = (row: typeof AlertTargetDbRow.Type): AlertTargetRow => ({
  ...row,
  skipViewed: row.skipViewed !== 0,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new AssistantAlertRepositoryError({ operation, cause })),
      );

  const selectTarget = `
    SELECT
      t.target_id AS "targetId",
      t.url AS "url",
      t.names_json AS "names",
      t.project_ids_json AS "projectIds",
      t.skip_viewed AS "skipViewed",
      t.authorization_secret AS "authorizationSecret",
      t.state AS "state",
      t.scanned_seq AS "scannedSeq",
      t.watermark AS "watermark",
      t.refused_streak AS "refusedStreak",
      t.refused_since AS "refusedSince",
      t.last_sent_at AS "lastSentAt",
      t.last_error AS "lastError",
      t.created_at AS "createdAt",
      (SELECT COUNT(*) FROM assistant_deliveries d
        WHERE d.target_id = t.target_id AND d.state = 'pending' AND d.attempts > 0) AS "retrying"
    FROM assistant_targets t
    WHERE t.kind = 'webhook'
  `;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AlertTargetDbRow,
    execute: () => sql.unsafe(`${selectTarget} ORDER BY t.created_at, t.target_id`),
  });
  const findRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AlertTargetDbRow,
    execute: (targetId) => sql.unsafe(`${selectTarget} AND t.target_id = ?`, [targetId]),
  });

  const list: AssistantAlertRepositoryShape["list"] = listRows(undefined).pipe(
    Effect.map((rows) => rows.map(fromDb)),
    wrap("list"),
  );

  const get: AssistantAlertRepositoryShape["get"] = (targetId) =>
    findRow(targetId).pipe(Effect.map(Option.map(fromDb)), wrap("get"));

  const countOn: AssistantAlertRepositoryShape["countOn"] = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM assistant_targets WHERE state = 'on'
  `.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    wrap("countOn"),
  );

  const projectIdsJson = (projectIds: ReadonlyArray<ProjectIdType> | null) =>
    projectIds === null ? null : JSON.stringify(projectIds);

  const insert: AssistantAlertRepositoryShape["insert"] = (input) =>
    sql`
      INSERT INTO assistant_targets (
        target_id, kind, connection_id, url, names_json, project_ids_json, skip_viewed,
        authorization_secret, state, scanned_seq, watermark, created_at, updated_at
      ) VALUES (
        ${input.targetId}, 'webhook', NULL, ${input.url}, ${JSON.stringify(input.names)},
        ${projectIdsJson(input.projectIds)}, ${input.skipViewed ? 1 : 0},
        ${input.authorizationSecret}, 'on', ${input.startSeq}, ${input.startSeq},
        ${input.now}, ${input.now}
      )
    `.pipe(Effect.asVoid, wrap("insert"));

  const update: AssistantAlertRepositoryShape["update"] = (input) =>
    sql`
      UPDATE assistant_targets
      SET url = ${input.url}, names_json = ${JSON.stringify(input.names)},
        project_ids_json = ${projectIdsJson(input.projectIds)},
        skip_viewed = ${input.skipViewed ? 1 : 0}, updated_at = ${input.now}
        ${
          input.authorizationSecret !== undefined
            ? sql`, authorization_secret = ${input.authorizationSecret}`
            : sql``
        }
        ${input.newCredentials ? sql`, refused_streak = 0, refused_since = NULL` : sql``}
      WHERE target_id = ${input.targetId}
    `.pipe(Effect.asVoid, wrap("update"));

  /** Moves the watermark to just below the oldest open delivery, or to how far it looked (in the caller's transaction). */
  const moveWatermark = (targetId: AssistantAlertTargetId) => sql`
    UPDATE assistant_targets
    SET watermark = MAX(watermark, COALESCE(
      (SELECT MIN(seq) - 1 FROM assistant_deliveries
        WHERE target_id = ${targetId} AND state IN ('pending', 'in_flight')),
      scanned_seq
    ))
    WHERE target_id = ${targetId}
  `;

  const setState: AssistantAlertRepositoryShape["setState"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE assistant_deliveries SET state = 'dropped'
            WHERE target_id = ${input.targetId} AND state IN ('pending', 'in_flight')
          `;
          yield* sql`
            UPDATE assistant_targets
            SET state = ${input.state}, updated_at = ${input.now}
              ${
                input.startSeq !== undefined
                  ? sql`, scanned_seq = ${input.startSeq}, watermark = ${input.startSeq}`
                  : sql``
              }
            WHERE target_id = ${input.targetId}
          `;
          yield* moveWatermark(input.targetId);
        }),
      )
      .pipe(Effect.asVoid, wrap("setState"));

  const deleteTarget: AssistantAlertRepositoryShape["delete"] = (targetId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM assistant_deliveries WHERE target_id = ${targetId}`;
          yield* sql`DELETE FROM assistant_targets WHERE target_id = ${targetId}`;
        }),
      )
      .pipe(Effect.asVoid, wrap("delete"));

  const queue: AssistantAlertRepositoryShape["queue"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const event of input.events) {
            yield* sql`
              INSERT INTO assistant_deliveries (
                target_id, seq, event_id, state, attempts, queued_at, next_attempt_at
              ) VALUES (
                ${input.targetId}, ${event.seq}, ${event.eventId}, 'pending', 0,
                ${input.now}, ${input.now}
              )
              ON CONFLICT (target_id, seq) DO NOTHING
            `;
          }
          yield* sql`
            UPDATE assistant_targets SET scanned_seq = MAX(scanned_seq, ${input.scannedSeq})
            WHERE target_id = ${input.targetId}
          `;
          yield* moveWatermark(input.targetId);
        }),
      )
      .pipe(Effect.asVoid, wrap("queue"));

  const dueRows = SqlSchema.findAll({
    Request: Schema.Struct({ targetId: Schema.String, now: Schema.String, limit: Schema.Number }),
    Result: DeliveryDbRow,
    execute: (request) => sql`
      SELECT target_id AS "targetId", seq, event_id AS "eventId", attempts,
        queued_at AS "queuedAt", next_attempt_at AS "nextAttemptAt"
      FROM assistant_deliveries
      WHERE target_id = ${request.targetId} AND state = 'pending'
        AND next_attempt_at <= ${request.now}
      ORDER BY seq
      LIMIT ${request.limit}
    `,
  });

  const due: AssistantAlertRepositoryShape["due"] = (input) => dueRows(input).pipe(wrap("due"));

  const nextDueAt: AssistantAlertRepositoryShape["nextDueAt"] = sql<{
    readonly at: string | null;
  }>`
    SELECT MIN(d.next_attempt_at) AS at
    FROM assistant_deliveries d JOIN assistant_targets t ON t.target_id = d.target_id
    WHERE d.state = 'pending' AND t.state = 'on'
  `.pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.at)),
    wrap("nextDueAt"),
  );

  const beginAttempt: AssistantAlertRepositoryShape["beginAttempt"] = (input) =>
    sql`
      UPDATE assistant_deliveries
      SET state = 'in_flight', attempts = attempts + 1,
        first_attempt_at = COALESCE(first_attempt_at, ${input.now})
      WHERE target_id = ${input.targetId} AND seq = ${input.seq} AND state = 'pending'
    `.pipe(Effect.asVoid, wrap("beginAttempt"));

  /** The target's note (in the caller's transaction). */
  const writeNote = (targetId: AssistantAlertTargetId, note: TargetNote) => {
    switch (note.type) {
      case "none":
        return Effect.void;
      case "sent":
        return sql`
          UPDATE assistant_targets
          SET last_sent_at = ${note.at}, last_error = NULL, refused_streak = 0, refused_since = NULL
          WHERE target_id = ${targetId}
        `.pipe(Effect.asVoid);
      case "error":
        return note.refused
          ? sql`
              UPDATE assistant_targets
              SET last_error = ${note.detail}, refused_streak = refused_streak + 1,
                refused_since = CASE
                  WHEN refused_streak + 1 >= ${REFUSED_STREAK} THEN COALESCE(refused_since, ${note.at})
                  ELSE refused_since
                END
              WHERE target_id = ${targetId}
            `.pipe(Effect.asVoid)
          : sql`
              UPDATE assistant_targets SET last_error = ${note.detail}
              WHERE target_id = ${targetId}
            `.pipe(Effect.asVoid);
    }
  };

  const settle: AssistantAlertRepositoryShape["settle"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* input.outcome.state === "pending"
            ? sql`
                UPDATE assistant_deliveries
                SET state = 'pending', next_attempt_at = ${input.outcome.nextAttemptAt}
                WHERE target_id = ${input.targetId} AND seq = ${input.seq}
                  AND state IN ('pending', 'in_flight')
              `
            : sql`
                UPDATE assistant_deliveries SET state = ${input.outcome.state}
                WHERE target_id = ${input.targetId} AND seq = ${input.seq}
                  AND state IN ('pending', 'in_flight')
              `;
          yield* writeNote(input.targetId, input.note);
          yield* moveWatermark(input.targetId);
        }),
      )
      .pipe(Effect.asVoid, wrap("settle"));

  const note: AssistantAlertRepositoryShape["note"] = (targetId, value) =>
    writeNote(targetId, value).pipe(wrap("note"));

  const failInFlight: AssistantAlertRepositoryShape["failInFlight"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const only =
            input.targetId !== undefined ? sql`AND target_id = ${input.targetId}` : sql``;
          const targets = yield* sql<{ readonly targetId: AssistantAlertTargetId }>`
            SELECT DISTINCT target_id AS "targetId" FROM assistant_deliveries
            WHERE state = 'in_flight' ${only}
          `;
          if (targets.length === 0) return;
          yield* sql`UPDATE assistant_deliveries SET state = 'failed' WHERE state = 'in_flight' ${only}`;
          for (const { targetId } of targets) {
            yield* sql`
              UPDATE assistant_targets SET last_error = ${input.detail}, updated_at = ${input.now}
              WHERE target_id = ${targetId}
            `;
            yield* moveWatermark(targetId);
          }
        }),
      )
      .pipe(Effect.asVoid, wrap("failInFlight"));

  const prune: AssistantAlertRepositoryShape["prune"] = (before) =>
    sql`
      DELETE FROM assistant_deliveries
      WHERE state IN ('sent', 'dropped', 'failed') AND queued_at < ${before}
    `.pipe(Effect.asVoid, wrap("prune"));

  return AssistantAlertRepository.of({
    list,
    get,
    countOn,
    insert,
    update,
    setState,
    delete: deleteTarget,
    queue,
    due,
    nextDueAt,
    beginAttempt,
    settle,
    note,
    failInFlight,
    prune,
  });
});

export const AssistantAlertRepositoryLive = Layer.effect(AssistantAlertRepository, make);
