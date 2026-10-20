import {
  ChildRequestId,
  IsoDateTime,
  MessageId,
  PeerRequestOutcome,
  PeerRequestStatus,
  PeerSendInput,
  PeerStartInput,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * The child's computer's ledger of what linked computers asked of it
 * (docs/design/fleet.md, "Records on B"): one row per start or send, keyed by
 * the asking link and its request id, holding the whole request as it
 * arrived and the ids reserved for it. Inserting the row is the dedupe; a
 * cancel that arrives first leaves a `cancelled` tombstone, so a late start
 * or send is refused. A request's end (its status and its report) is written
 * in one statement, and its report is offered on the watch until acked.
 */

export const LinkRequestPayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("start"), input: PeerStartInput }),
  Schema.Struct({ kind: Schema.Literal("send"), input: PeerSendInput }),
]);
export type LinkRequestPayload = typeof LinkRequestPayload.Type;

export const LinkRequestRow = Schema.Struct({
  linkDeviceId: Schema.String,
  requestId: ChildRequestId,
  kind: Schema.Literals(["start", "send"]),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  /** The turn that answers it, once it started. */
  turnId: Schema.NullOr(TurnId),
  /** `awaiting_background`: the finished turn whose answer stands so far. */
  candidateTurnId: Schema.NullOr(TurnId),
  status: PeerRequestStatus,
  /** Null for a tombstone (a cancel that came before its request). */
  payload: Schema.NullOr(LinkRequestPayload),
  reason: Schema.NullOr(Schema.String),
  reportId: Schema.NullOr(Schema.String),
  reportOutcome: Schema.NullOr(PeerRequestOutcome),
  reportText: Schema.NullOr(Schema.String),
  reportTurnId: Schema.NullOr(Schema.String),
  reportError: Schema.NullOr(Schema.String),
  settledAt: Schema.NullOr(IsoDateTime),
  /** When the asking computer acked the report. */
  deliveredAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LinkRequestRow = typeof LinkRequestRow.Type;

const LinkRequestDbRow = Schema.Struct({
  ...LinkRequestRow.fields,
  payload: Schema.NullOr(Schema.fromJsonString(LinkRequestPayload)),
});
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(LinkRequestPayload));

export const TERMINAL_LINK_REQUEST_STATUSES: ReadonlySet<PeerRequestStatus> = new Set([
  "answered",
  "failed",
  "stopped",
  "cancelled",
  "denied",
  "expired",
]);

export const isTerminalLinkRequest = (row: Pick<LinkRequestRow, "status">) =>
  TERMINAL_LINK_REQUEST_STATUSES.has(row.status);

/** The id of a request's report, the same on every replay. */
export const linkReportId = (requestId: ChildRequestId) => `${requestId}:report`;

export class LinkRequestRepositoryError extends Data.TaggedError("LinkRequestRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface LinkRequestRepositoryShape {
  /** Inserts the request unless its (link, request id) exists; returns the stored row. */
  readonly insert: (input: {
    readonly linkDeviceId: string;
    readonly requestId: ChildRequestId;
    readonly status: PeerRequestStatus;
    readonly payload: LinkRequestPayload;
    readonly threadId: ThreadId | null;
    readonly messageId: MessageId | null;
    readonly now: string;
  }) => Effect.Effect<LinkRequestRow, LinkRequestRepositoryError>;
  readonly get: (
    linkDeviceId: string,
    requestId: ChildRequestId,
  ) => Effect.Effect<Option.Option<LinkRequestRow>, LinkRequestRepositoryError>;
  /** Every request not yet ended, oldest first. */
  readonly listOpen: Effect.Effect<ReadonlyArray<LinkRequestRow>, LinkRequestRepositoryError>;
  readonly listByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<LinkRequestRow>, LinkRequestRepositoryError>;
  /** A link's open requests and its ended ones whose report it hasn't acked. */
  readonly listForWatch: (
    linkDeviceId: string,
  ) => Effect.Effect<ReadonlyArray<LinkRequestRow>, LinkRequestRepositoryError>;
  /** Moves an open request on; false when it already ended. */
  readonly progress: (input: {
    readonly linkDeviceId: string;
    readonly requestId: ChildRequestId;
    readonly status: PeerRequestStatus;
    readonly threadId?: ThreadId;
    readonly messageId?: MessageId;
    readonly turnId?: TurnId | null;
    readonly candidateTurnId?: TurnId | null;
    readonly now: string;
  }) => Effect.Effect<boolean, LinkRequestRepositoryError>;
  /**
   * Ends an open request with its report, status and report in one
   * statement; false when it had already ended (the first end wins).
   */
  readonly settle: (input: {
    readonly linkDeviceId: string;
    readonly requestId: ChildRequestId;
    readonly outcome: PeerRequestOutcome;
    readonly text: string;
    readonly turnId: TurnId | null;
    readonly error?: string | undefined;
    readonly now: string;
  }) => Effect.Effect<boolean, LinkRequestRepositoryError>;
  /**
   * A cancel: ends the request `cancelled`, or, when it hasn't arrived yet,
   * leaves a tombstone so it is refused when it does. Returns the row as it
   * stands, and whether this call ended it.
   */
  readonly cancel: (input: {
    readonly linkDeviceId: string;
    readonly requestId: ChildRequestId;
    readonly text: string;
    readonly now: string;
  }) => Effect.Effect<
    { readonly row: LinkRequestRow; readonly cancelled: boolean },
    LinkRequestRepositoryError
  >;
  /** The asking computer recorded the report. */
  readonly markDelivered: (input: {
    readonly linkDeviceId: string;
    readonly reportId: string;
    readonly now: string;
  }) => Effect.Effect<void, LinkRequestRepositoryError>;
  /** Drops delivered rows older than `before` and every row of a removed link. */
  readonly prune: (input: {
    readonly deliveredBefore: string;
  }) => Effect.Effect<void, LinkRequestRepositoryError>;
}

export class LinkRequestRepository extends Context.Service<
  LinkRequestRepository,
  LinkRequestRepositoryShape
>()("threadlines/links/LinkRequestRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new LinkRequestRepositoryError({ operation, cause })));

  const select = `
    SELECT
      link_device_id AS "linkDeviceId",
      request_id AS "requestId",
      kind AS "kind",
      thread_id AS "threadId",
      message_id AS "messageId",
      turn_id AS "turnId",
      candidate_turn_id AS "candidateTurnId",
      status AS "status",
      payload_json AS "payload",
      reason AS "reason",
      report_id AS "reportId",
      report_outcome AS "reportOutcome",
      report_text AS "reportText",
      report_turn_id AS "reportTurnId",
      report_error AS "reportError",
      settled_at AS "settledAt",
      delivered_at AS "deliveredAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM link_requests
  `;
  const terminal = `('answered', 'failed', 'stopped', 'cancelled', 'denied', 'expired')`;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.Struct({ linkDeviceId: Schema.String, requestId: Schema.String }),
    Result: LinkRequestDbRow,
    execute: ({ linkDeviceId, requestId }) =>
      sql.unsafe(`${select} WHERE link_device_id = ? AND request_id = ?`, [
        linkDeviceId,
        requestId,
      ]),
  });
  const findMany = (where: string, values: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: LinkRequestDbRow,
      execute: () => sql.unsafe(`${select} WHERE ${where} ORDER BY created_at, request_id`, values),
    })(undefined);

  const get: LinkRequestRepositoryShape["get"] = (linkDeviceId, requestId) =>
    findOne({ linkDeviceId, requestId }).pipe(wrap("get"));

  const insert: LinkRequestRepositoryShape["insert"] = (input) =>
    Effect.gen(function* () {
      const payload = yield* encodePayload(input.payload);
      yield* sql`
        INSERT INTO link_requests (
          link_device_id, request_id, kind, thread_id, message_id, status, payload_json,
          created_at, updated_at
        ) VALUES (
          ${input.linkDeviceId}, ${input.requestId}, ${input.payload.kind}, ${input.threadId},
          ${input.messageId}, ${input.status}, ${payload}, ${input.now}, ${input.now}
        )
        ON CONFLICT(link_device_id, request_id) DO NOTHING
      `;
      const row = yield* findOne({ linkDeviceId: input.linkDeviceId, requestId: input.requestId });
      return Option.getOrThrow(row);
    }).pipe(wrap("insert"));

  const listOpen: LinkRequestRepositoryShape["listOpen"] = findMany(
    `status NOT IN ${terminal}`,
    [],
  ).pipe(wrap("listOpen"));

  const listByThread: LinkRequestRepositoryShape["listByThread"] = (threadId) =>
    findMany(`thread_id = ?`, [threadId]).pipe(wrap("listByThread"));

  const listForWatch: LinkRequestRepositoryShape["listForWatch"] = (linkDeviceId) =>
    findMany(
      `link_device_id = ? AND (status NOT IN ${terminal} OR (delivered_at IS NULL AND report_id IS NOT NULL))`,
      [linkDeviceId],
    ).pipe(wrap("listForWatch"));

  const progress: LinkRequestRepositoryShape["progress"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<{ readonly requestId: string }>(
        `UPDATE link_requests SET
           status = ?,
           thread_id = COALESCE(?, thread_id),
           message_id = COALESCE(?, message_id),
           turn_id = CASE WHEN ? THEN ? ELSE turn_id END,
           candidate_turn_id = CASE WHEN ? THEN ? ELSE candidate_turn_id END,
           updated_at = ?
         WHERE link_device_id = ? AND request_id = ? AND status NOT IN ${terminal}
         RETURNING request_id AS "requestId"`,
        [
          input.status,
          input.threadId ?? null,
          input.messageId ?? null,
          input.turnId !== undefined ? 1 : 0,
          input.turnId ?? null,
          input.candidateTurnId !== undefined ? 1 : 0,
          input.candidateTurnId ?? null,
          input.now,
          input.linkDeviceId,
          input.requestId,
        ],
      );
      return rows.length > 0;
    }).pipe(wrap("progress"));

  const settle: LinkRequestRepositoryShape["settle"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<{ readonly requestId: string }>(
        `UPDATE link_requests SET
           status = ?,
           report_id = ?,
           report_outcome = ?,
           report_text = ?,
           report_turn_id = ?,
           report_error = ?,
           settled_at = ?,
           updated_at = ?
         WHERE link_device_id = ? AND request_id = ? AND status NOT IN ${terminal}
         RETURNING request_id AS "requestId"`,
        [
          input.outcome,
          linkReportId(input.requestId),
          input.outcome,
          input.text,
          input.turnId,
          input.error ?? null,
          input.now,
          input.now,
          input.linkDeviceId,
          input.requestId,
        ],
      );
      return rows.length > 0;
    }).pipe(wrap("settle"));

  const cancel: LinkRequestRepositoryShape["cancel"] = (input) =>
    Effect.gen(function* () {
      // A tombstone first: a cancel that overtook its request.
      yield* sql`
        INSERT INTO link_requests (
          link_device_id, request_id, kind, status, payload_json, report_id, report_outcome,
          report_text, settled_at, created_at, updated_at
        ) VALUES (
          ${input.linkDeviceId}, ${input.requestId}, 'start', 'cancelled', NULL,
          ${linkReportId(input.requestId)}, 'cancelled', ${input.text}, ${input.now},
          ${input.now}, ${input.now}
        )
        ON CONFLICT(link_device_id, request_id) DO NOTHING
      `;
      const cancelled = yield* settle({
        linkDeviceId: input.linkDeviceId,
        requestId: input.requestId,
        outcome: "cancelled",
        text: input.text,
        turnId: null,
        now: input.now,
      });
      const row = Option.getOrThrow(
        yield* findOne({ linkDeviceId: input.linkDeviceId, requestId: input.requestId }),
      );
      return { row, cancelled };
    }).pipe(wrap("cancel"));

  const markDelivered: LinkRequestRepositoryShape["markDelivered"] = (input) =>
    sql`
      UPDATE link_requests SET delivered_at = ${input.now}
      WHERE link_device_id = ${input.linkDeviceId} AND report_id = ${input.reportId}
        AND delivered_at IS NULL
    `.pipe(Effect.asVoid, wrap("markDelivered"));

  const prune: LinkRequestRepositoryShape["prune"] = (input) =>
    sql`
      DELETE FROM link_requests
      WHERE (delivered_at IS NOT NULL AND delivered_at < ${input.deliveredBefore})
        OR link_device_id NOT IN (SELECT device_id FROM relay_devices)
    `.pipe(Effect.asVoid, wrap("prune"));

  return LinkRequestRepository.of({
    insert,
    get,
    listOpen,
    listByThread,
    listForWatch,
    progress,
    settle,
    cancel,
    markDelivered,
    prune,
  });
});

export const LinkRequestRepositoryLive = Layer.effect(LinkRequestRepository, make);
