import {
  IsoDateTime,
  PeerMoveAbortCode,
  PeerMoveManifest,
  ThreadId,
  ThreadMoveId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * The receiving computer's record of threads linked computers move here
 * (docs/design/fleet.md, Part 3, "Import on B"): one row per (link, transfer
 * id), with the manifest as it arrived, the bytes received so far, how far
 * the import got (`stage`), and what it made that it owns until it commits or
 * is cleaned up (the branch and worktree). The thread id is fixed when the
 * row is made, from the link and transfer: the thread existing is the
 * commit.
 */

/**
 * Where a move stands here, as recorded. `awaiting_approval` with
 * `stagedApproval` takes its bytes while it waits; the asking computer reads
 * it as `receiving`, then `staged_awaiting_approval` once every byte is here.
 */
export const LinkMoveStatus = Schema.Literals([
  "awaiting_approval",
  "receiving",
  "importing",
  "committed",
  "aborted",
]);
export type LinkMoveStatus = typeof LinkMoveStatus.Type;

/**
 * How far an import got; each stage is recorded before the next starts. A
 * thread with a checkout goes fetched, worktree, applied; a General Chats
 * thread goes folder, applied. `arrived`, on a committed move: its arrival
 * was sent (the queue's head), so a restart doesn't send it again.
 */
export const LinkMoveStage = Schema.Literals([
  "fetched",
  "worktree",
  "folder",
  "applied",
  "arrived",
]);
export type LinkMoveStage = typeof LinkMoveStage.Type;

export const LinkMoveRow = Schema.Struct({
  linkDeviceId: Schema.String,
  transferId: ThreadMoveId,
  /** hash(link, transfer): every resource the move makes here is named from it. */
  transferKey: Schema.String,
  status: LinkMoveStatus,
  /**
   * The asking computer sends the bytes before this computer's user allows
   * the move (docs/design/fleet.md, Part 3c): under Ask first it is received
   * into staging while it waits, and Allow imports it at once.
   */
  stagedApproval: Schema.Boolean,
  stage: Schema.NullOr(LinkMoveStage),
  manifest: PeerMoveManifest,
  bytesReceived: Schema.Number,
  threadId: ThreadId,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  /** The repository the move's git work happens in (its temp ref, branch, worktree), once known. */
  repoRoot: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  /** An aborted move held for this computer's user: Don't allow, or nobody allowed it in time. */
  abortCode: Schema.NullOr(PeerMoveAbortCode),
  /** An aborted move's clean-up is done. Null on an aborted row: still owed. */
  cleanedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LinkMoveRow = typeof LinkMoveRow.Type;

const LinkMoveDbRow = Schema.Struct({
  ...LinkMoveRow.fields,
  stagedApproval: Schema.BooleanFromBit,
  manifest: Schema.fromJsonString(PeerMoveManifest),
});
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(PeerMoveManifest));

export class LinkMoveRepositoryError extends Data.TaggedError("LinkMoveRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface LinkMoveRepositoryShape {
  /** Inserts the move unless (link, transfer id) exists; returns the stored row. */
  readonly insert: (input: {
    readonly linkDeviceId: string;
    readonly transferId: ThreadMoveId;
    readonly transferKey: string;
    readonly status: LinkMoveStatus;
    readonly stagedApproval: boolean;
    readonly manifest: PeerMoveManifest;
    readonly threadId: ThreadId;
    readonly reason?: string;
    readonly now: string;
  }) => Effect.Effect<LinkMoveRow, LinkMoveRepositoryError>;
  readonly get: (
    linkDeviceId: string,
    transferId: string,
  ) => Effect.Effect<Option.Option<LinkMoveRow>, LinkMoveRepositoryError>;
  /** Moves not committed or aborted, oldest first. */
  readonly listOpen: Effect.Effect<ReadonlyArray<LinkMoveRow>, LinkMoveRepositoryError>;
  /** Aborted moves whose clean-up is still owed, oldest first. */
  readonly listCleanupOwed: Effect.Effect<ReadonlyArray<LinkMoveRow>, LinkMoveRepositoryError>;
  /** Committed or cleaned-up moves last changed before `before`: their staging can go. */
  readonly listSettledBefore: (
    before: string,
  ) => Effect.Effect<ReadonlyArray<LinkMoveRow>, LinkMoveRepositoryError>;
  /** Changes what `patch` names; nothing once the row is committed or aborted. */
  readonly update: (input: {
    readonly linkDeviceId: string;
    readonly transferId: string;
    readonly patch: Partial<
      Pick<
        LinkMoveRow,
        "status" | "stage" | "bytesReceived" | "branch" | "worktreePath" | "repoRoot" | "reason"
      >
    >;
    readonly now: string;
  }) => Effect.Effect<boolean, LinkMoveRepositoryError>;
  /** The terminal word: `committed`, or `aborted` with a reason. Once only. */
  readonly settle: (input: {
    readonly linkDeviceId: string;
    readonly transferId: string;
    readonly status: "committed" | "aborted";
    readonly reason?: string;
    /** With `aborted`: see LinkMoveRow.abortCode. */
    readonly abortCode?: PeerMoveAbortCode;
    readonly now: string;
  }) => Effect.Effect<boolean, LinkMoveRepositoryError>;
  readonly markCleaned: (input: {
    readonly linkDeviceId: string;
    readonly transferId: string;
    readonly now: string;
  }) => Effect.Effect<void, LinkMoveRepositoryError>;
  /** A committed move's arrival was sent (stage `arrived`). */
  readonly markArrived: (input: {
    readonly linkDeviceId: string;
    readonly transferId: string;
    readonly now: string;
  }) => Effect.Effect<void, LinkMoveRepositoryError>;
  /** Committed moves whose arrival may not have been sent yet, oldest first. */
  readonly listUnarrived: Effect.Effect<ReadonlyArray<LinkMoveRow>, LinkMoveRepositoryError>;
}

export class LinkMoveRepository extends Context.Service<
  LinkMoveRepository,
  LinkMoveRepositoryShape
>()("threadlines/links/LinkMoveRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new LinkMoveRepositoryError({ operation, cause })));

  const select = `
    SELECT
      link_device_id AS "linkDeviceId",
      transfer_id AS "transferId",
      transfer_key AS "transferKey",
      status AS "status",
      staged_approval AS "stagedApproval",
      stage AS "stage",
      manifest_json AS "manifest",
      bytes_received AS "bytesReceived",
      thread_id AS "threadId",
      branch AS "branch",
      worktree_path AS "worktreePath",
      repo_root AS "repoRoot",
      reason AS "reason",
      abort_code AS "abortCode",
      cleaned_at AS "cleanedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM link_moves
  `;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.Struct({ linkDeviceId: Schema.String, transferId: Schema.String }),
    Result: LinkMoveDbRow,
    execute: ({ linkDeviceId, transferId }) =>
      sql.unsafe(`${select} WHERE link_device_id = ? AND transfer_id = ?`, [
        linkDeviceId,
        transferId,
      ]),
  });
  const findMany = (where: string, values: ReadonlyArray<string>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: LinkMoveDbRow,
      execute: () =>
        sql.unsafe(`${select} WHERE ${where} ORDER BY created_at, transfer_id`, values),
    })(undefined);

  const get: LinkMoveRepositoryShape["get"] = (linkDeviceId, transferId) =>
    findOne({ linkDeviceId, transferId }).pipe(wrap("get"));

  const insert: LinkMoveRepositoryShape["insert"] = (input) =>
    Effect.gen(function* () {
      const manifest = yield* encodeManifest(input.manifest);
      yield* sql`
        INSERT INTO link_moves (
          link_device_id, transfer_id, transfer_key, status, staged_approval, manifest_json,
          bytes_received, thread_id, reason, created_at, updated_at
        ) VALUES (
          ${input.linkDeviceId}, ${input.transferId}, ${input.transferKey}, ${input.status},
          ${input.stagedApproval ? 1 : 0}, ${manifest}, 0, ${input.threadId},
          ${input.reason ?? null}, ${input.now}, ${input.now}
        )
        ON CONFLICT(link_device_id, transfer_id) DO NOTHING
      `;
      const row = yield* findOne({
        linkDeviceId: input.linkDeviceId,
        transferId: input.transferId,
      });
      return Option.getOrThrow(row);
    }).pipe(wrap("insert"));

  const listOpen: LinkMoveRepositoryShape["listOpen"] = findMany(
    `status NOT IN ('committed', 'aborted')`,
    [],
  ).pipe(wrap("listOpen"));

  const listCleanupOwed: LinkMoveRepositoryShape["listCleanupOwed"] = findMany(
    `status = 'aborted' AND cleaned_at IS NULL`,
    [],
  ).pipe(wrap("listCleanupOwed"));

  const listSettledBefore: LinkMoveRepositoryShape["listSettledBefore"] = (before) =>
    findMany(
      `(status = 'committed' OR (status = 'aborted' AND cleaned_at IS NOT NULL)) AND updated_at < ?`,
      [before],
    ).pipe(wrap("listSettledBefore"));

  const update: LinkMoveRepositoryShape["update"] = (input) =>
    Effect.gen(function* () {
      const { patch } = input;
      const rows = yield* sql<{ readonly changed: number }>`
        UPDATE link_moves SET
          status = COALESCE(${patch.status ?? null}, status),
          stage = CASE WHEN ${patch.stage === undefined ? 0 : 1} = 1 THEN ${patch.stage ?? null} ELSE stage END,
          bytes_received = COALESCE(${patch.bytesReceived ?? null}, bytes_received),
          branch = COALESCE(${patch.branch ?? null}, branch),
          worktree_path = COALESCE(${patch.worktreePath ?? null}, worktree_path),
          repo_root = COALESCE(${patch.repoRoot ?? null}, repo_root),
          reason = COALESCE(${patch.reason ?? null}, reason),
          updated_at = ${input.now}
        WHERE link_device_id = ${input.linkDeviceId}
          AND transfer_id = ${input.transferId}
          AND status NOT IN ('committed', 'aborted')
        RETURNING 1 AS changed
      `;
      return rows.length > 0;
    }).pipe(wrap("update"));

  const settle: LinkMoveRepositoryShape["settle"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly changed: number }>`
        UPDATE link_moves SET
          status = ${input.status},
          reason = COALESCE(${input.reason ?? null}, reason),
          abort_code = ${input.abortCode ?? null},
          updated_at = ${input.now}
        WHERE link_device_id = ${input.linkDeviceId}
          AND transfer_id = ${input.transferId}
          AND status NOT IN ('committed', 'aborted')
        RETURNING 1 AS changed
      `;
      return rows.length > 0;
    }).pipe(wrap("settle"));

  const markCleaned: LinkMoveRepositoryShape["markCleaned"] = (input) =>
    sql`
      UPDATE link_moves SET cleaned_at = ${input.now}, updated_at = ${input.now}
      WHERE link_device_id = ${input.linkDeviceId} AND transfer_id = ${input.transferId}
    `.pipe(Effect.asVoid, wrap("markCleaned"));

  const markArrived: LinkMoveRepositoryShape["markArrived"] = (input) =>
    sql`
      UPDATE link_moves SET stage = 'arrived', updated_at = ${input.now}
      WHERE link_device_id = ${input.linkDeviceId} AND transfer_id = ${input.transferId}
        AND status = 'committed'
    `.pipe(Effect.asVoid, wrap("markArrived"));

  const listUnarrived: LinkMoveRepositoryShape["listUnarrived"] = findMany(
    `status = 'committed' AND (stage IS NULL OR stage <> 'arrived')`,
    [],
  ).pipe(wrap("listUnarrived"));

  return LinkMoveRepository.of({
    markArrived,
    listUnarrived,
    insert,

    get,
    listOpen,
    listCleanupOwed,
    listSettledBefore,
    update,
    settle,
    markCleaned,
  });
});

export const LinkMoveRepositoryLive = Layer.effect(LinkMoveRepository, make);
