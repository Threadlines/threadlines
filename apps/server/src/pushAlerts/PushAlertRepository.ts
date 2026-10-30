/**
 * Storage for phone alerts (migration 088): each paired phone's sealing keys,
 * how far through the event log alerts were looked for, the alerts, and their
 * deliveries. Times are ISO strings (UTC), so they compare as text.
 */
import { type PushAlertKind, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ALERT_LIFETIME_MS, type PushAlertAction, type PushAlertReason } from "./pushAlertRules.ts";

export class PushAlertRepositoryError extends Data.TaggedError("PushAlertRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export const PushRegistrationRow = Schema.Struct({
  deviceId: Schema.String,
  registrationId: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  keyId: Schema.String,
  appOrigin: Schema.String,
});
export type PushRegistrationRow = typeof PushRegistrationRow.Type;

const AlertKindSchema = Schema.Literals(["needs_you", "finished", "failed"]);

export const PushAlertRow = Schema.Struct({
  alertId: Schema.String,
  threadId: ThreadId,
  kind: AlertKindSchema,
  reason: Schema.String,
  subjectId: Schema.String,
  detail: Schema.NullOr(Schema.String),
  /** When the thing it is about happened. */
  occurredAt: Schema.String,
  dueAt: Schema.String,
  expiresAt: Schema.String,
});
export type PushAlertRow = typeof PushAlertRow.Type;

export const PushDeliveryRow = Schema.Struct({
  deviceId: Schema.String,
  registrationId: Schema.String,
  state: Schema.Literals(["pending", "sent", "dropped"]),
  attempts: Schema.Number,
  nextAttemptAt: Schema.String,
});
export type PushDeliveryRow = typeof PushDeliveryRow.Type;

export interface PushAlertRepositoryShape {
  readonly saveRegistration: (
    row: PushRegistrationRow & { readonly now: string },
  ) => Effect.Effect<void, PushAlertRepositoryError>;
  /** Forgets a phone's keys; with `registrationId`, only if they are still that registration's. */
  readonly deleteRegistration: (
    deviceId: string,
    registrationId?: string,
  ) => Effect.Effect<void, PushAlertRepositoryError>;
  readonly getRegistration: (
    deviceId: string,
  ) => Effect.Effect<Option.Option<PushRegistrationRow>, PushAlertRepositoryError>;
  readonly listRegistrations: Effect.Effect<
    ReadonlyArray<PushRegistrationRow>,
    PushAlertRepositoryError
  >;
  /** Where reading the event log stopped; none before the first read. */
  readonly getCursor: Effect.Effect<Option.Option<number>, PushAlertRepositoryError>;
  /** The newest event's sequence: where a first read starts, so history never alerts. */
  readonly latestEventSequence: Effect.Effect<number, PushAlertRepositoryError>;
  /**
   * Applies what some events meant for alerts and, in the same transaction,
   * moves the cursor past them: a crash leaves both or neither.
   */
  readonly applyActions: (input: {
    readonly actions: ReadonlyArray<PushAlertAction>;
    readonly cursor?: number;
    readonly now: number;
  }) => Effect.Effect<void, PushAlertRepositoryError>;
  /** Pending alerts due by `now`, oldest first, after dropping the ones that expired. */
  readonly dueAlerts: (
    now: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PushAlertRow>, PushAlertRepositoryError>;
  /** The soonest pending alert's due time (a delivery waiting to retry defers its alert to then). */
  readonly nextWakeAt: Effect.Effect<Option.Option<string>, PushAlertRepositoryError>;
  /** Whether the alert still waits to go out (not sent, cancelled or expired). */
  readonly isPending: (alertId: string) => Effect.Effect<boolean, PushAlertRepositoryError>;
  readonly finishAlert: (
    alertId: string,
    state: "delivered" | "dropped",
  ) => Effect.Effect<void, PushAlertRepositoryError>;
  readonly deferAlert: (
    alertId: string,
    dueAt: string,
  ) => Effect.Effect<void, PushAlertRepositoryError>;
  /** A finished turn that left a plan to review goes out as "needs you". */
  readonly retypeAlert: (
    alertId: string,
    kind: PushAlertKind,
    reason: PushAlertReason,
  ) => Effect.Effect<void, PushAlertRepositoryError>;
  /** One delivery per phone registered now; existing ones are kept. */
  readonly ensureDeliveries: (input: {
    readonly alertId: string;
    readonly registrations: ReadonlyArray<PushRegistrationRow>;
    readonly now: string;
  }) => Effect.Effect<ReadonlyArray<PushDeliveryRow>, PushAlertRepositoryError>;
  readonly updateDelivery: (input: {
    readonly alertId: string;
    readonly deviceId: string;
    readonly state: PushDeliveryRow["state"];
    readonly attempts: number;
    readonly nextAttemptAt: string;
  }) => Effect.Effect<void, PushAlertRepositoryError>;
  /** Drops finished alerts and their deliveries older than `before`. */
  readonly prune: (before: string) => Effect.Effect<void, PushAlertRepositoryError>;
}

export class PushAlertRepository extends Context.Service<
  PushAlertRepository,
  PushAlertRepositoryShape
>()("threadlines/pushAlerts/PushAlertRepository") {}

const iso = (ms: number) => new Date(ms).toISOString();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new PushAlertRepositoryError({ operation, cause })));
  const decodeRegistrations = Schema.decodeUnknownEffect(Schema.Array(PushRegistrationRow));
  const decodeAlerts = Schema.decodeUnknownEffect(Schema.Array(PushAlertRow));
  const decodeDeliveries = Schema.decodeUnknownEffect(Schema.Array(PushDeliveryRow));

  const registrationColumns = sql`
    device_id AS "deviceId", registration_id AS "registrationId", p256dh, auth,
    key_id AS "keyId", app_origin AS "appOrigin"
  `;

  const saveRegistration: PushAlertRepositoryShape["saveRegistration"] = (row) =>
    sql`
      INSERT INTO push_registrations (
        device_id, registration_id, p256dh, auth, key_id, app_origin, updated_at
      ) VALUES (
        ${row.deviceId}, ${row.registrationId}, ${row.p256dh}, ${row.auth}, ${row.keyId},
        ${row.appOrigin}, ${row.now}
      )
      ON CONFLICT(device_id) DO UPDATE SET
        registration_id = excluded.registration_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        key_id = excluded.key_id,
        app_origin = excluded.app_origin,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, wrap("saveRegistration"));

  const deleteRegistration: PushAlertRepositoryShape["deleteRegistration"] = (
    deviceId,
    registrationId,
  ) =>
    (registrationId === undefined
      ? sql`DELETE FROM push_registrations WHERE device_id = ${deviceId}`
      : sql`
          DELETE FROM push_registrations
          WHERE device_id = ${deviceId} AND registration_id = ${registrationId}
        `
    ).pipe(Effect.asVoid, wrap("deleteRegistration"));

  const getRegistration: PushAlertRepositoryShape["getRegistration"] = (deviceId) =>
    sql`SELECT ${registrationColumns} FROM push_registrations WHERE device_id = ${deviceId}`.pipe(
      Effect.flatMap(decodeRegistrations),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      wrap("getRegistration"),
    );

  const listRegistrations: PushAlertRepositoryShape["listRegistrations"] = sql`
    SELECT ${registrationColumns} FROM push_registrations ORDER BY device_id
  `.pipe(Effect.flatMap(decodeRegistrations), wrap("listRegistrations"));

  const getCursor: PushAlertRepositoryShape["getCursor"] = sql<{ readonly sequence: number }>`
    SELECT sequence FROM push_alert_cursor WHERE id = 1
  `.pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.sequence)),
    wrap("getCursor"),
  );

  const latestEventSequence: PushAlertRepositoryShape["latestEventSequence"] = sql<{
    readonly sequence: number | null;
  }>`SELECT MAX(sequence) AS sequence FROM orchestration_events`.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
    wrap("latestEventSequence"),
  );

  const applyAction = (action: PushAlertAction, now: number) => {
    switch (action.type) {
      case "add": {
        const { intent } = action;
        return sql`
          INSERT INTO push_alerts (
            alert_id, thread_id, kind, reason, subject_id, detail, state, occurred_at, due_at,
            expires_at
          ) VALUES (
            ${intent.alertId}, ${intent.threadId}, ${intent.kind}, ${intent.reason},
            ${intent.subjectId}, ${intent.detail}, 'pending', ${intent.occurredAt},
            ${iso(now + intent.holdMs)}, ${iso(now + ALERT_LIFETIME_MS[intent.kind])}
          )
          ON CONFLICT(alert_id) DO NOTHING
        `;
      }
      case "cancel":
        return sql`
          UPDATE push_alerts SET state = 'dropped'
          WHERE alert_id = ${action.alertId} AND state = 'pending'
        `;
      case "cancel-thread":
        return sql`
          UPDATE push_alerts SET state = 'dropped'
          WHERE thread_id = ${action.threadId} AND state = 'pending'
            AND kind IN ${sql.in(action.kinds)}
        `;
      case "suppress":
        // A dropped row stands in for the alert, so a later "add" for it does nothing.
        return sql`
          INSERT INTO push_alerts (
            alert_id, thread_id, kind, reason, subject_id, detail, state, occurred_at, due_at,
            expires_at
          ) VALUES (
            ${action.alertId}, ${action.threadId}, 'failed', 'error', ${action.alertId}, NULL,
            'dropped', ${iso(now)}, ${iso(now)}, ${iso(now)}
          )
          ON CONFLICT(alert_id) DO UPDATE SET state = 'dropped' WHERE state = 'pending'
        `;
    }
  };

  const applyActions: PushAlertRepositoryShape["applyActions"] = ({ actions, cursor, now }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const action of actions) yield* applyAction(action, now);
          if (cursor !== undefined) {
            yield* sql`
              INSERT INTO push_alert_cursor (id, sequence) VALUES (1, ${cursor})
              ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence
            `;
          }
        }),
      )
      .pipe(wrap("applyActions"));

  const alertColumns = sql`
    alert_id AS "alertId", thread_id AS "threadId", kind, reason, subject_id AS "subjectId",
    detail, occurred_at AS "occurredAt", due_at AS "dueAt", expires_at AS "expiresAt"
  `;

  const dueAlerts: PushAlertRepositoryShape["dueAlerts"] = (now, limit) =>
    Effect.gen(function* () {
      const at = iso(now);
      yield* sql`
        UPDATE push_alerts SET state = 'dropped'
        WHERE state = 'pending' AND expires_at <= ${at}
      `;
      const rows = yield* sql`
        SELECT ${alertColumns} FROM push_alerts
        WHERE state = 'pending' AND due_at <= ${at}
        ORDER BY due_at, alert_id
        LIMIT ${limit}
      `;
      return yield* decodeAlerts(rows);
    }).pipe(wrap("dueAlerts"));

  const nextWakeAt: PushAlertRepositoryShape["nextWakeAt"] = sql<{
    readonly at: string | null;
  }>`
    SELECT MIN(due_at) AS at FROM push_alerts WHERE state = 'pending'
  `.pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.at)),
    wrap("nextWakeAt"),
  );

  const isPending: PushAlertRepositoryShape["isPending"] = (alertId) =>
    sql<{ readonly state: string }>`
      SELECT state FROM push_alerts WHERE alert_id = ${alertId}
    `.pipe(
      Effect.map((rows) => rows[0]?.state === "pending"),
      wrap("isPending"),
    );

  const finishAlert: PushAlertRepositoryShape["finishAlert"] = (alertId, state) =>
    sql`
      UPDATE push_alerts SET state = ${state} WHERE alert_id = ${alertId} AND state = 'pending'
    `.pipe(Effect.asVoid, wrap("finishAlert"));

  const deferAlert: PushAlertRepositoryShape["deferAlert"] = (alertId, dueAt) =>
    sql`
      UPDATE push_alerts SET due_at = ${dueAt} WHERE alert_id = ${alertId} AND state = 'pending'
    `.pipe(Effect.asVoid, wrap("deferAlert"));

  const retypeAlert: PushAlertRepositoryShape["retypeAlert"] = (alertId, kind, reason) =>
    sql`
      UPDATE push_alerts SET kind = ${kind}, reason = ${reason}
      WHERE alert_id = ${alertId} AND state = 'pending'
    `.pipe(Effect.asVoid, wrap("retypeAlert"));

  const deliveryColumns = sql`
    device_id AS "deviceId", registration_id AS "registrationId", state, attempts,
    next_attempt_at AS "nextAttemptAt"
  `;

  const ensureDeliveries: PushAlertRepositoryShape["ensureDeliveries"] = (input) =>
    Effect.gen(function* () {
      for (const registration of input.registrations) {
        yield* sql`
          INSERT INTO push_alert_deliveries (
            alert_id, device_id, registration_id, state, attempts, next_attempt_at
          ) VALUES (
            ${input.alertId}, ${registration.deviceId}, ${registration.registrationId},
            'pending', 0, ${input.now}
          )
          ON CONFLICT(alert_id, device_id) DO NOTHING
        `;
      }
      const rows = yield* sql`
        SELECT ${deliveryColumns} FROM push_alert_deliveries WHERE alert_id = ${input.alertId}
      `;
      return yield* decodeDeliveries(rows);
    }).pipe(wrap("ensureDeliveries"));

  const updateDelivery: PushAlertRepositoryShape["updateDelivery"] = (input) =>
    sql`
      UPDATE push_alert_deliveries
      SET state = ${input.state}, attempts = ${input.attempts},
        next_attempt_at = ${input.nextAttemptAt}
      WHERE alert_id = ${input.alertId} AND device_id = ${input.deviceId}
    `.pipe(Effect.asVoid, wrap("updateDelivery"));

  const prune: PushAlertRepositoryShape["prune"] = (before) =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM push_alerts WHERE state != 'pending' AND occurred_at < ${before}
      `;
      yield* sql`
        DELETE FROM push_alert_deliveries
        WHERE alert_id NOT IN (SELECT alert_id FROM push_alerts)
      `;
    }).pipe(wrap("prune"));

  return PushAlertRepository.of({
    saveRegistration,
    deleteRegistration,
    getRegistration,
    listRegistrations,
    getCursor,
    latestEventSequence,
    applyActions,
    dueAlerts,
    nextWakeAt,
    isPending,
    finishAlert,
    deferAlert,
    retypeAlert,
    ensureDeliveries,
    updateDelivery,
    prune,
  });
});

export const PushAlertRepositoryLive = Layer.effect(PushAlertRepository, make);
