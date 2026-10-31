/**
 * Storage for the assistants' event record (migration 094,
 * docs/design/assistants.md "The event record"): the rows and the record's
 * one state row. Times are ISO strings (UTC), so they compare as text.
 *
 * Every write that moves a row on runs in one transaction with whatever it
 * depends on: actions with the event-log cursor they came from, a `seq` with
 * the row that takes it.
 */
import { ProjectId, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import {
  type AssistantEvent,
  type AssistantEventAction,
  type AssistantEventName,
  AssistantEventNameSchema,
  assistantEventNameOf,
} from "./AssistantEvents.ts";

export class AssistantEventRepositoryError extends Data.TaggedError(
  "AssistantEventRepositoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The record's own state (assistant_event_state). */
export interface AssistantEventState {
  /** Names this record in cursors, so one from elsewhere (or a reset database) is told apart. */
  readonly recordId: string;
  /** How far through the event log it read; null while the record is off. */
  readonly cursor: number | null;
  /** The last `seq` given out. */
  readonly lastSeq: number;
  /** The highest `seq` pruned: a cursor below it missed events. */
  readonly prunedThroughSeq: number;
  /** When the record last turned on. */
  readonly startedAt: string | null;
}

export const SettlingAssistantEventRow = Schema.Struct({
  subjectKey: Schema.String,
  name: AssistantEventNameSchema,
  reason: Schema.String,
  threadId: ThreadId,
  occurredAt: Schema.String,
  /** When the row came in. */
  addedAt: Schema.String,
  settleUntil: Schema.String,
});
export type SettlingAssistantEventRow = typeof SettlingAssistantEventRow.Type;

const RecordedRow = Schema.Struct({
  eventId: Schema.String,
  seq: Schema.Number,
  name: AssistantEventNameSchema,
  reason: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  occurredAt: Schema.String,
  recordedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  resolvedReason: Schema.NullOr(Schema.String),
});

const StateRow = Schema.Struct({
  recordId: Schema.String,
  cursor: Schema.NullOr(Schema.Number),
  lastSeq: Schema.Number,
  prunedThroughSeq: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
});

/** What making a settling row final came to (AssistantEventRepositoryShape.record). */
export type RecordOutcome = "recorded" | "cancelled" | "stale";

export interface AssistantEventRepositoryShape {
  readonly getState: Effect.Effect<AssistantEventState, AssistantEventRepositoryError>;
  /** The newest orchestration event's sequence: where the record starts, so history is never recorded. */
  readonly latestEventSequence: Effect.Effect<number, AssistantEventRepositoryError>;
  /** The record turns on, reading the event log after `cursor`. */
  readonly begin: (input: {
    readonly cursor: number;
    readonly startedAt: string;
  }) => Effect.Effect<void, AssistantEventRepositoryError>;
  /**
   * The record turns off: what happens until it turns on again is never read,
   * and rows still settling are dropped (`record_off`), so nothing becomes
   * final while nobody is connected.
   */
  readonly stop: (now: string) => Effect.Effect<void, AssistantEventRepositoryError>;
  /**
   * Applies what some events meant and, in the same transaction, moves the
   * cursor past them: a crash leaves both or neither.
   */
  readonly applyActions: (input: {
    readonly actions: ReadonlyArray<AssistantEventAction>;
    readonly cursor?: number;
    readonly now: number;
  }) => Effect.Effect<void, AssistantEventRepositoryError>;
  /** Settling rows due by `now`, soonest first. */
  readonly dueSettling: (
    now: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<SettlingAssistantEventRow>, AssistantEventRepositoryError>;
  /** The soonest settling row's due time. */
  readonly nextSettleAt: Effect.Effect<Option.Option<string>, AssistantEventRepositoryError>;
  readonly defer: (
    subjectKey: string,
    settleUntil: string,
  ) => Effect.Effect<void, AssistantEventRepositoryError>;
  /** A settling row that no longer holds. */
  readonly drop: (input: {
    readonly subjectKey: string;
    readonly why: string;
    readonly now: string;
  }) => Effect.Effect<void, AssistantEventRepositoryError>;
  /**
   * A settling row becomes final with the next `seq`. A resolution it
   * gathered while settling (a visit) stays.
   *
   * Only if nothing that could change the verdict reached the event log
   * after `judgedAt`, the cursor it was judged at: an event about its thread
   * (an interrupt, an answer, a new turn, a dismissed plan), read yet or not,
   * leaves the row settling to be judged again (`stale`). Other threads'
   * events don't hold it up. `cancelled`: the row was dropped meanwhile,
   * which is also what turning the record off does.
   */
  readonly record: (input: {
    readonly subjectKey: string;
    readonly threadId: ThreadId;
    readonly name: AssistantEventName;
    readonly reason: string;
    readonly projectId: ProjectId;
    readonly now: string;
    readonly judgedAt: number;
  }) => Effect.Effect<RecordOutcome, AssistantEventRepositoryError>;
  /**
   * A finished turn left a plan to review: its row is dropped and the plan's
   * `plan:<id>` row is recorded instead, with the next `seq`. The same
   * `judgedAt` rule as `record`.
   */
  readonly recordPlan: (input: {
    readonly fromSubjectKey: string;
    readonly planSubjectKey: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly occurredAt: string;
    readonly now: string;
    readonly judgedAt: number;
  }) => Effect.Effect<RecordOutcome, AssistantEventRepositoryError>;
  /**
   * Recorded events with `after < seq <= upTo`, oldest first, at most
   * `limit`; only these names and projects when given.
   */
  readonly since: (input: {
    readonly after: number;
    readonly upTo: number;
    readonly limit: number;
    readonly names?: ReadonlyArray<AssistantEventName>;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }) => Effect.Effect<ReadonlyArray<AssistantEvent>, AssistantEventRepositoryError>;
  /** The recorded event with this `seq`, with its subject key; none once pruned. */
  readonly recorded: (
    seq: number,
  ) => Effect.Effect<
    Option.Option<AssistantEvent & { readonly subjectKey: string }>,
    AssistantEventRepositoryError
  >;
  /** `schedule:` rows still standing (settling, or recorded and unresolved). */
  readonly standingScheduleKeys: Effect.Effect<
    ReadonlyArray<string>,
    AssistantEventRepositoryError
  >;
  /**
   * Forgets recorded events made final before `before`, and other rows that
   * happened before it, remembering the highest `seq` it forgot.
   */
  readonly prune: (before: string) => Effect.Effect<void, AssistantEventRepositoryError>;
}

export class AssistantEventRepository extends Context.Service<
  AssistantEventRepository,
  AssistantEventRepositoryShape
>()("threadlines/assistants/AssistantEventRepository") {}

const iso = (ms: number) => new Date(ms).toISOString();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new AssistantEventRepositoryError({ operation, cause })),
      );
  const decodeSettling = Schema.decodeUnknownEffect(Schema.Array(SettlingAssistantEventRow));
  const decodeRecorded = Schema.decodeUnknownEffect(Schema.Array(RecordedRow));
  const decodeState = Schema.decodeUnknownEffect(Schema.Array(StateRow));

  const readState = sql`
    SELECT record_id AS "recordId", event_sequence AS "cursor", last_seq AS "lastSeq",
      pruned_through_seq AS "prunedThroughSeq", started_at AS "startedAt"
    FROM assistant_event_state WHERE id = 1
  `.pipe(
    Effect.flatMap(decodeState),
    Effect.map((rows) => rows[0]),
  );

  /** The state row, made on first use. */
  const getState: AssistantEventRepositoryShape["getState"] = Effect.gen(function* () {
    const existing = yield* readState;
    if (existing !== undefined) return existing;
    yield* sql`
      INSERT INTO assistant_event_state (
        id, event_sequence, last_seq, pruned_through_seq, record_id, started_at
      ) VALUES (1, NULL, 0, 0, ${crypto.randomUUID()}, NULL)
      ON CONFLICT(id) DO NOTHING
    `;
    const made = yield* readState;
    if (made === undefined) return yield* Effect.die("assistant_event_state has no row");
    return made;
  }).pipe(wrap("getState"));

  const latestEventSequence: AssistantEventRepositoryShape["latestEventSequence"] = sql<{
    readonly sequence: number | null;
  }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
    wrap("latestEventSequence"),
  );

  const begin: AssistantEventRepositoryShape["begin"] = (input) =>
    getState.pipe(
      Effect.andThen(
        sql`
          UPDATE assistant_event_state
          SET event_sequence = ${input.cursor}, started_at = ${input.startedAt}
          WHERE id = 1
        `,
      ),
      Effect.asVoid,
      wrap("begin"),
    );

  const stop: AssistantEventRepositoryShape["stop"] = (now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE assistant_event_state SET event_sequence = NULL WHERE id = 1`;
          yield* sql`
            UPDATE assistant_events
            SET state = 'dropped', resolved_at = ${now}, resolved_reason = 'record_off'
            WHERE state = 'settling'
          `;
        }),
      )
      .pipe(Effect.asVoid, wrap("stop"));

  /**
   * Cancels: a row still settling is dropped, a recorded one is resolved
   * (once: the first reason stands). `where` picks the rows.
   */
  const cancelRows = (where: Statement.Fragment, why: string, now: string) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE assistant_events
        SET state = 'dropped', resolved_at = ${now}, resolved_reason = ${why}
        WHERE state = 'settling' AND ${where}
      `;
      yield* sql`
        UPDATE assistant_events SET resolved_at = ${now}, resolved_reason = ${why}
        WHERE state = 'recorded' AND resolved_at IS NULL AND ${where}
      `;
    });

  const applyAction = (action: AssistantEventAction, nowMs: number) => {
    const now = iso(nowMs);
    switch (action.type) {
      case "add": {
        const { intent } = action;
        return sql`
          INSERT INTO assistant_events (
            event_id, subject_key, state, settle_until, name, reason, thread_id, occurred_at,
            added_at
          ) VALUES (
            ${crypto.randomUUID()}, ${intent.alertId}, 'settling', ${iso(nowMs + intent.holdMs)},
            ${assistantEventNameOf(intent.kind)}, ${intent.reason}, ${intent.threadId},
            ${intent.occurredAt}, ${now}
          )
          ON CONFLICT(subject_key) DO NOTHING
        `.pipe(Effect.asVoid);
      }
      case "cancel":
        return cancelRows(sql`subject_key = ${action.subjectKey}`, action.why, now);
      case "cancel-thread": {
        const rows = sql`thread_id = ${action.threadId} AND name IN ${sql.in(action.names)}`;
        // A visit doesn't undo what happened: the rows still become final,
        // and say they were seen. Only what it saw: up to its stamp.
        return action.keepSettling
          ? sql`
              UPDATE assistant_events SET resolved_at = ${now}, resolved_reason = ${action.why}
              WHERE state IN ('settling', 'recorded') AND resolved_at IS NULL AND ${rows}
                ${action.seenAt !== undefined ? sql`AND occurred_at <= ${action.seenAt}` : sql``}
            `.pipe(Effect.asVoid)
          : cancelRows(rows, action.why, now);
      }
      case "suppress":
        // A dropped row stands in for the event, so a later "add" for it does nothing.
        return sql`
          INSERT INTO assistant_events (
            event_id, subject_key, state, settle_until, name, reason, thread_id, occurred_at,
            added_at, resolved_at, resolved_reason
          ) VALUES (
            ${crypto.randomUUID()}, ${action.subjectKey}, 'dropped', ${now}, 'thread.failed',
            'error', ${action.threadId}, ${now}, ${now}, ${now}, ${action.why}
          )
          ON CONFLICT(subject_key) DO NOTHING
        `.pipe(
          Effect.andThen(cancelRows(sql`subject_key = ${action.subjectKey}`, action.why, now)),
        );
      case "resolve-plans":
        return cancelRows(
          sql`thread_id = ${action.threadId} AND subject_key LIKE 'plan:%' AND subject_key != ${action.except}`,
          action.why,
          now,
        );
    }
  };

  const applyActions: AssistantEventRepositoryShape["applyActions"] = ({ actions, cursor, now }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const action of actions) yield* applyAction(action, now);
          if (cursor !== undefined) {
            yield* sql`UPDATE assistant_event_state SET event_sequence = ${cursor} WHERE id = 1`;
          }
        }),
      )
      .pipe(wrap("applyActions"));

  const dueSettling: AssistantEventRepositoryShape["dueSettling"] = (now, limit) =>
    sql`
      SELECT subject_key AS "subjectKey", name, reason, thread_id AS "threadId",
        occurred_at AS "occurredAt", added_at AS "addedAt", settle_until AS "settleUntil"
      FROM assistant_events
      WHERE state = 'settling' AND settle_until <= ${now}
      ORDER BY settle_until, subject_key
      LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeSettling), wrap("dueSettling"));

  const nextSettleAt: AssistantEventRepositoryShape["nextSettleAt"] = sql<{
    readonly at: string | null;
  }>`SELECT MIN(settle_until) AS at FROM assistant_events WHERE state = 'settling'`.pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.at)),
    wrap("nextSettleAt"),
  );

  const defer: AssistantEventRepositoryShape["defer"] = (subjectKey, settleUntil) =>
    sql`
      UPDATE assistant_events SET settle_until = ${settleUntil}
      WHERE subject_key = ${subjectKey} AND state = 'settling'
    `.pipe(Effect.asVoid, wrap("defer"));

  const drop: AssistantEventRepositoryShape["drop"] = (input) =>
    sql`
      UPDATE assistant_events
      SET state = 'dropped', resolved_at = ${input.now}, resolved_reason = ${input.why}
      WHERE subject_key = ${input.subjectKey} AND state = 'settling'
    `.pipe(Effect.asVoid, wrap("drop"));

  /** Takes the next `seq` (inside the caller's transaction). */
  const nextSeq = getState.pipe(
    Effect.andThen(
      sql<{ readonly seq: number }>`
        UPDATE assistant_event_state SET last_seq = last_seq + 1 WHERE id = 1
        RETURNING last_seq AS "seq"
      `,
    ),
    Effect.map((rows) => rows[0]?.seq ?? 0),
  );

  const isSettling = (subjectKey: string) =>
    sql<{ readonly state: string }>`
      SELECT state FROM assistant_events WHERE subject_key = ${subjectKey}
    `.pipe(Effect.map((rows) => rows[0]?.state === "settling"));

  /**
   * Whether an event that could change a verdict on `threadId` reached the
   * log after `judgedAt` (inside the caller's transaction). Every rule closes
   * rows of the event's own thread, except a child's result settling on its
   * parent, which closes the child's. Only the few events after the cursor
   * are scanned.
   */
  const threadMovedSince = (threadId: ThreadId, judgedAt: number) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_events
      WHERE sequence > ${judgedAt}
        AND ((aggregate_kind = 'thread' AND stream_id = ${threadId})
          OR (event_type = 'thread.child-request-settled'
            AND json_extract(payload_json, '$.childThreadId') = ${threadId}))
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  const record: AssistantEventRepositoryShape["record"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* isSettling(input.subjectKey))) return "cancelled" as const;
          if (yield* threadMovedSince(input.threadId, input.judgedAt)) return "stale" as const;
          const seq = yield* nextSeq;
          yield* sql`
            UPDATE assistant_events
            SET state = 'recorded', seq = ${seq}, name = ${input.name}, reason = ${input.reason},
              project_id = ${input.projectId}, recorded_at = ${input.now}
            WHERE subject_key = ${input.subjectKey}
          `;
          return "recorded" as const;
        }),
      )
      .pipe(wrap("record"));

  const recordPlan: AssistantEventRepositoryShape["recordPlan"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* isSettling(input.fromSubjectKey))) return "cancelled" as const;
          if (yield* threadMovedSince(input.threadId, input.judgedAt)) return "stale" as const;
          yield* sql`
            UPDATE assistant_events
            SET state = 'dropped', resolved_at = ${input.now}, resolved_reason = 'became_plan'
            WHERE subject_key = ${input.fromSubjectKey}
          `;
          const existing = yield* sql`
            SELECT 1 FROM assistant_events WHERE subject_key = ${input.planSubjectKey}
          `;
          if (existing.length > 0) return "recorded" as const;
          const seq = yield* nextSeq;
          yield* sql`
            INSERT INTO assistant_events (
              event_id, subject_key, state, settle_until, seq, name, reason, thread_id,
              project_id, occurred_at, added_at, recorded_at
            ) VALUES (
              ${crypto.randomUUID()}, ${input.planSubjectKey}, 'recorded', ${input.now}, ${seq},
              'thread.needs_you', 'plan', ${input.threadId}, ${input.projectId},
              ${input.occurredAt}, ${input.now}, ${input.now}
            )
          `;
          return "recorded" as const;
        }),
      )
      .pipe(wrap("recordPlan"));

  const since: AssistantEventRepositoryShape["since"] = (input) =>
    input.projectIds !== undefined && input.projectIds.length === 0
      ? Effect.succeed([])
      : sql`
          SELECT event_id AS "eventId", seq, name, reason, thread_id AS "threadId",
            project_id AS "projectId", occurred_at AS "occurredAt", recorded_at AS "recordedAt",
            resolved_at AS "resolvedAt", resolved_reason AS "resolvedReason"
          FROM assistant_events
          WHERE state = 'recorded' AND seq > ${input.after} AND seq <= ${input.upTo}
            ${input.names !== undefined ? sql`AND name IN ${sql.in(input.names)}` : sql``}
            ${input.projectIds !== undefined ? sql`AND project_id IN ${sql.in(input.projectIds)}` : sql``}
          ORDER BY seq
          LIMIT ${input.limit}
        `.pipe(Effect.flatMap(decodeRecorded), wrap("since"));

  const decodeRecordedWithKey = Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ ...RecordedRow.fields, subjectKey: Schema.String })),
  );

  const recorded: AssistantEventRepositoryShape["recorded"] = (seq) =>
    sql`
      SELECT event_id AS "eventId", seq, name, reason, thread_id AS "threadId",
        project_id AS "projectId", occurred_at AS "occurredAt", recorded_at AS "recordedAt",
        resolved_at AS "resolvedAt", resolved_reason AS "resolvedReason",
        subject_key AS "subjectKey"
      FROM assistant_events
      WHERE state = 'recorded' AND seq = ${seq}
    `.pipe(
      Effect.flatMap(decodeRecordedWithKey),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("recorded"),
    );

  const standingScheduleKeys: AssistantEventRepositoryShape["standingScheduleKeys"] = sql<{
    readonly subjectKey: string;
  }>`
    SELECT subject_key AS "subjectKey" FROM assistant_events
    WHERE subject_key LIKE 'schedule:%' AND state IN ('settling', 'recorded')
      AND resolved_at IS NULL
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.subjectKey)),
    wrap("standingScheduleKeys"),
  );

  const prune: AssistantEventRepositoryShape["prune"] = (before) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [forgotten] = yield* sql<{ readonly seq: number | null }>`
            SELECT MAX(seq) AS seq FROM assistant_events
            WHERE state = 'recorded' AND recorded_at < ${before}
          `;
          yield* sql`
            DELETE FROM assistant_events
            WHERE (state = 'recorded' AND recorded_at < ${before})
              OR (state != 'recorded' AND occurred_at < ${before} AND settle_until < ${before})
          `;
          if (forgotten?.seq !== null && forgotten?.seq !== undefined) {
            yield* sql`
              UPDATE assistant_event_state
              SET pruned_through_seq = MAX(pruned_through_seq, ${forgotten.seq})
              WHERE id = 1
            `;
          }
        }),
      )
      .pipe(wrap("prune"));

  return AssistantEventRepository.of({
    getState,
    latestEventSequence,
    begin,
    stop,
    applyActions,
    dueSettling,
    nextSettleAt,
    defer,
    drop,
    record,
    recordPlan,
    since,
    recorded,
    standingScheduleKeys,
    prune,
  });
});

export const AssistantEventRepositoryLive = Layer.effect(AssistantEventRepository, make);
