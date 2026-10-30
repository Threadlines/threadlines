import {
  IsoDateTime,
  OutsideAgentAccess,
  OutsideAgentConnectionId,
  OutsideAgentConnectionKind,
  type OutsideAgentGrant,
  OutsideAgentIdentity,
  OutsideAgentSignInMethod,
  ProjectId,
  RuntimeMode,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * Outside agents' and assistants' approved connections
 * (`outside_agent_connections`, migrations 089 and 092;
 * docs/design/outside-agents.md, docs/design/assistants.md). A row is the one
 * authority every call is checked against: its grant is read again on each
 * call, and a removed row refuses every credential.
 *
 * Assistant rows also keep their relay routing (host, route tag), their
 * rotating refresh token's state or their key's hash, and whether the relay
 * still has to be told they were removed (`relay_revoke_pending`, set in the
 * same statement that removes an assistant row).
 */

/**
 * Why a connection stopped: the user removed it, a new approval for the same
 * agent replaced it, 90 days unused, or (assistants) a refresh token came back
 * after it was replaced: a theft signal.
 */
export const OutsideAgentRemovedReason = Schema.Literals([
  "removed",
  "replaced",
  "unused",
  "refresh-reuse",
]);
export type OutsideAgentRemovedReason = typeof OutsideAgentRemovedReason.Type;

/** A rotating refresh token's state: the newest generation issued, when, and the newest seen in use. */
export const OutsideAgentRefreshState = Schema.Struct({
  generation: Schema.Int,
  rotatedAt: IsoDateTime,
  /** -1: no access token of any generation was used yet. */
  seenGeneration: Schema.Int,
});
export type OutsideAgentRefreshState = typeof OutsideAgentRefreshState.Type;

export const OutsideAgentConnectionRow = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  kind: OutsideAgentConnectionKind,
  signIn: OutsideAgentSignInMethod,
  /**
   * sha256 of the client id: the registration, so "the same agent" is the
   * same hash. A key's is its own, so nothing replaces it.
   */
  clientIdHash: Schema.String,
  clientName: Schema.String,
  softwareId: Schema.NullOr(Schema.String),
  /** The exact callback the approval went back to; empty for a key. */
  redirectUri: Schema.String,
  /** The resource its credentials are bound to (`<origin>/mcp/connect`, or the assistants door's `<origin>/mcp`). */
  resource: Schema.String,
  access: OutsideAgentAccess,
  maxRuntimeMode: RuntimeMode,
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
  /** Local agents' token generation (`tlc1`); unused for assistants. */
  tokenGeneration: Schema.Int,
  /** Assistants signed in with OAuth. */
  identity: Schema.NullOr(OutsideAgentIdentity),
  /** Assistants: the relay host its credentials name, and their route tag. */
  hostId: Schema.NullOr(Schema.String),
  routeTag: Schema.NullOr(Schema.String),
  /** Assistants signed in with OAuth. */
  refresh: Schema.NullOr(OutsideAgentRefreshState),
  /** Assistants with a key. */
  keyHash: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  removedAt: Schema.NullOr(IsoDateTime),
  removedReason: Schema.NullOr(OutsideAgentRemovedReason),
});
export type OutsideAgentConnectionRow = typeof OutsideAgentConnectionRow.Type;

/** The row as stored: flat columns, SQLite's integers for booleans. */
const OutsideAgentConnectionDbRow = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  kind: OutsideAgentConnectionKind,
  signIn: OutsideAgentSignInMethod,
  clientIdHash: Schema.String,
  clientName: Schema.String,
  softwareId: Schema.NullOr(Schema.String),
  redirectUri: Schema.String,
  resource: Schema.String,
  access: OutsideAgentAccess,
  maxRuntimeMode: RuntimeMode,
  projectIds: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProjectId))),
  tokenGeneration: Schema.Int,
  identityHost: Schema.NullOr(Schema.String),
  identityVerified: Schema.NullOr(Schema.Number),
  identityKnown: Schema.NullOr(Schema.Number),
  hostId: Schema.NullOr(Schema.String),
  routeTag: Schema.NullOr(Schema.String),
  refreshGeneration: Schema.NullOr(Schema.Int),
  refreshRotatedAt: Schema.NullOr(IsoDateTime),
  refreshSeenGeneration: Schema.NullOr(Schema.Int),
  keyHash: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  removedAt: Schema.NullOr(IsoDateTime),
  removedReason: Schema.NullOr(OutsideAgentRemovedReason),
});
type OutsideAgentConnectionDbRow = typeof OutsideAgentConnectionDbRow.Type;

const fromDb = (row: OutsideAgentConnectionDbRow): OutsideAgentConnectionRow => ({
  connectionId: row.connectionId,
  kind: row.kind,
  signIn: row.signIn,
  clientIdHash: row.clientIdHash,
  clientName: row.clientName,
  softwareId: row.softwareId,
  redirectUri: row.redirectUri,
  resource: row.resource,
  access: row.access,
  maxRuntimeMode: row.maxRuntimeMode,
  projectIds: row.projectIds,
  tokenGeneration: row.tokenGeneration,
  identity:
    row.identityHost === null
      ? null
      : {
          host: row.identityHost,
          verified: row.identityVerified === 1,
          known: row.identityKnown === 1,
        },
  hostId: row.hostId,
  routeTag: row.routeTag,
  refresh:
    row.refreshGeneration === null || row.refreshRotatedAt === null
      ? null
      : {
          generation: row.refreshGeneration,
          rotatedAt: row.refreshRotatedAt,
          seenGeneration: row.refreshSeenGeneration ?? -1,
        },
  keyHash: row.keyHash,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  removedAt: row.removedAt,
  removedReason: row.removedReason,
});

export class OutsideAgentConnectionRepositoryError extends Data.TaggedError(
  "OutsideAgentConnectionRepositoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** A removed assistant connection the relay still has to be told about. */
export interface PendingRelayRevocation {
  readonly connectionId: OutsideAgentConnectionId;
  /** The relay host it was routed under. */
  readonly hostId: string | null;
}

export interface OutsideAgentConnectionRepositoryShape {
  readonly get: (
    connectionId: OutsideAgentConnectionId,
  ) => Effect.Effect<
    Option.Option<OutsideAgentConnectionRow>,
    OutsideAgentConnectionRepositoryError
  >;
  /** Connections of both kinds that aren't removed, newest first. */
  readonly listLive: Effect.Effect<
    ReadonlyArray<OutsideAgentConnectionRow>,
    OutsideAgentConnectionRepositoryError
  >;
  /** How many live connections of `kind` there are. */
  readonly countLive: (
    kind: OutsideAgentConnectionRow["kind"],
  ) => Effect.Effect<number, OutsideAgentConnectionRepositoryError>;
  /**
   * Saves a new connection, in one transaction with removing (reason
   * `replaced`) every live one of the same kind from the same registration.
   * Returns the ids it replaced; replaced assistant rows wait to be revoked
   * at the relay.
   */
  readonly insertReplacing: (
    row: OutsideAgentConnectionRow,
  ) => Effect.Effect<
    ReadonlyArray<OutsideAgentConnectionId>,
    OutsideAgentConnectionRepositoryError
  >;
  /** Changes a live connection's grant; none when it is removed or unknown. */
  readonly setGrant: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly grant: OutsideAgentGrant;
  }) => Effect.Effect<
    Option.Option<OutsideAgentConnectionRow>,
    OutsideAgentConnectionRepositoryError
  >;
  /**
   * Removes a live connection; false when it was already removed or is
   * unknown. A removed assistant row waits to be revoked at the relay.
   */
  readonly markRemoved: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly reason: OutsideAgentRemovedReason;
    readonly now: string;
  }) => Effect.Effect<boolean, OutsideAgentConnectionRepositoryError>;
  /** Removes (`unused`) live connections of `kind` unused since `before`; their ids. */
  readonly removeUnusedSince: (input: {
    readonly kind: OutsideAgentConnectionRow["kind"];
    readonly before: string;
    readonly now: string;
  }) => Effect.Effect<
    ReadonlyArray<OutsideAgentConnectionId>,
    OutsideAgentConnectionRepositoryError
  >;
  readonly touch: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly now: string;
  }) => Effect.Effect<void, OutsideAgentConnectionRepositoryError>;
  /** A live assistant's refresh token rotated (or was answered again): its new state. */
  readonly setRefresh: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly generation: number;
    readonly rotatedAt: string;
  }) => Effect.Effect<void, OutsideAgentConnectionRepositoryError>;
  /** An access token of `generation` was used: the newest generation seen in use moves up to it. */
  readonly markSeen: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly generation: number;
  }) => Effect.Effect<void, OutsideAgentConnectionRepositoryError>;
  /** Removed assistant connections the relay hasn't been told about, at most `limit`. */
  readonly pendingRevocations: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PendingRelayRevocation>, OutsideAgentConnectionRepositoryError>;
  /** The relay was told: these are no longer pending. */
  readonly clearRevocations: (
    connectionIds: ReadonlyArray<OutsideAgentConnectionId>,
  ) => Effect.Effect<void, OutsideAgentConnectionRepositoryError>;
  /** Runs `effect` in one transaction (the refresh rules read and write together). */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OutsideAgentConnectionRepositoryError, R>;
}

export class OutsideAgentConnectionRepository extends Context.Service<
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryShape
>()("threadlines/outsideAgents/OutsideAgentConnectionRepository") {}

const projectIdsJson = (projectIds: OutsideAgentGrant["projectIds"]) =>
  projectIds === null ? null : JSON.stringify(projectIds);

const flag = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new OutsideAgentConnectionRepositoryError({ operation, cause })),
      );

  const selectRow = `
    SELECT
      connection_id AS "connectionId",
      kind AS "kind",
      sign_in AS "signIn",
      client_id_hash AS "clientIdHash",
      client_name AS "clientName",
      software_id AS "softwareId",
      redirect_uri AS "redirectUri",
      resource AS "resource",
      access AS "access",
      max_runtime_mode AS "maxRuntimeMode",
      project_ids_json AS "projectIds",
      token_generation AS "tokenGeneration",
      identity_host AS "identityHost",
      identity_verified AS "identityVerified",
      identity_known AS "identityKnown",
      host_id AS "hostId",
      route_tag AS "routeTag",
      refresh_generation AS "refreshGeneration",
      refresh_rotated_at AS "refreshRotatedAt",
      refresh_seen_generation AS "refreshSeenGeneration",
      key_hash AS "keyHash",
      created_at AS "createdAt",
      last_used_at AS "lastUsedAt",
      removed_at AS "removedAt",
      removed_reason AS "removedReason"
    FROM outside_agent_connections
  `;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: OutsideAgentConnectionDbRow,
    execute: (connectionId) => sql.unsafe(`${selectRow} WHERE connection_id = ?`, [connectionId]),
  });

  const get: OutsideAgentConnectionRepositoryShape["get"] = (connectionId) =>
    findOne(connectionId).pipe(Effect.map(Option.map(fromDb)), wrap("get"));

  const listLive: OutsideAgentConnectionRepositoryShape["listLive"] = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OutsideAgentConnectionDbRow,
    execute: () =>
      sql.unsafe(
        `${selectRow} WHERE removed_at IS NULL ORDER BY created_at DESC, connection_id DESC`,
      ),
  })(undefined).pipe(
    Effect.map((rows) => rows.map(fromDb)),
    wrap("listLive"),
  );

  const countLive: OutsideAgentConnectionRepositoryShape["countLive"] = (kind) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM outside_agent_connections
      WHERE kind = ${kind} AND removed_at IS NULL
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      wrap("countLive"),
    );

  const insertReplacing: OutsideAgentConnectionRepositoryShape["insertReplacing"] = (row) =>
    Effect.gen(function* () {
      const replaced = yield* sql<{ readonly connectionId: OutsideAgentConnectionId }>`
        UPDATE outside_agent_connections
        SET
          removed_at = ${row.createdAt},
          removed_reason = 'replaced',
          relay_revoke_pending = CASE WHEN kind = 'assistant' THEN 1 ELSE 0 END
        WHERE client_id_hash = ${row.clientIdHash} AND kind = ${row.kind} AND removed_at IS NULL
        RETURNING connection_id AS "connectionId"
      `;
      yield* sql`
        INSERT INTO outside_agent_connections (
          connection_id, kind, sign_in, client_id_hash, client_name, software_id, redirect_uri,
          resource, access, max_runtime_mode, project_ids_json, token_generation,
          identity_host, identity_verified, identity_known, host_id, route_tag,
          refresh_generation, refresh_rotated_at, refresh_seen_generation, key_hash,
          created_at, last_used_at, removed_at, removed_reason, relay_revoke_pending
        ) VALUES (
          ${row.connectionId}, ${row.kind}, ${row.signIn}, ${row.clientIdHash}, ${row.clientName},
          ${row.softwareId}, ${row.redirectUri}, ${row.resource}, ${row.access},
          ${row.maxRuntimeMode}, ${projectIdsJson(row.projectIds)}, ${row.tokenGeneration},
          ${row.identity?.host ?? null}, ${flag(row.identity?.verified)},
          ${flag(row.identity?.known)}, ${row.hostId}, ${row.routeTag},
          ${row.refresh?.generation ?? null}, ${row.refresh?.rotatedAt ?? null},
          ${row.refresh?.seenGeneration ?? null}, ${row.keyHash},
          ${row.createdAt}, ${row.lastUsedAt}, ${row.removedAt}, ${row.removedReason}, 0
        )
      `;
      return replaced.map((entry) => entry.connectionId);
    }).pipe(sql.withTransaction, wrap("insertReplacing"));

  const setGrant: OutsideAgentConnectionRepositoryShape["setGrant"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* sql<{ readonly connectionId: string }>`
        UPDATE outside_agent_connections
        SET
          access = ${input.grant.access},
          max_runtime_mode = ${input.grant.maxRuntimeMode},
          project_ids_json = ${projectIdsJson(input.grant.projectIds)}
        WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
        RETURNING connection_id AS "connectionId"
      `;
      if (updated.length === 0) return Option.none<OutsideAgentConnectionRow>();
      return Option.map(yield* findOne(input.connectionId), fromDb);
    }).pipe(wrap("setGrant"));

  const markRemoved: OutsideAgentConnectionRepositoryShape["markRemoved"] = (input) =>
    sql<{ readonly connectionId: string }>`
      UPDATE outside_agent_connections
      SET
        removed_at = ${input.now},
        removed_reason = ${input.reason},
        relay_revoke_pending = CASE WHEN kind = 'assistant' THEN 1 ELSE 0 END
      WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
      RETURNING connection_id AS "connectionId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("markRemoved"),
    );

  const removeUnusedSince: OutsideAgentConnectionRepositoryShape["removeUnusedSince"] = (input) =>
    sql<{ readonly connectionId: OutsideAgentConnectionId }>`
      UPDATE outside_agent_connections
      SET
        removed_at = ${input.now},
        removed_reason = 'unused',
        relay_revoke_pending = CASE WHEN kind = 'assistant' THEN 1 ELSE 0 END
      WHERE kind = ${input.kind}
        AND removed_at IS NULL
        AND COALESCE(last_used_at, created_at) < ${input.before}
      RETURNING connection_id AS "connectionId"
    `.pipe(
      Effect.map((rows) => rows.map((entry) => entry.connectionId)),
      wrap("removeUnusedSince"),
    );

  const touch: OutsideAgentConnectionRepositoryShape["touch"] = (input) =>
    sql`
      UPDATE outside_agent_connections SET last_used_at = ${input.now}
      WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
    `.pipe(Effect.asVoid, wrap("touch"));

  const setRefresh: OutsideAgentConnectionRepositoryShape["setRefresh"] = (input) =>
    sql`
      UPDATE outside_agent_connections
      SET refresh_generation = ${input.generation}, refresh_rotated_at = ${input.rotatedAt}
      WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
    `.pipe(Effect.asVoid, wrap("setRefresh"));

  const markSeen: OutsideAgentConnectionRepositoryShape["markSeen"] = (input) =>
    sql`
      UPDATE outside_agent_connections
      SET refresh_seen_generation = MAX(COALESCE(refresh_seen_generation, -1), ${input.generation})
      WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
    `.pipe(Effect.asVoid, wrap("markSeen"));

  const pendingRevocations: OutsideAgentConnectionRepositoryShape["pendingRevocations"] = (limit) =>
    sql<{ readonly connectionId: OutsideAgentConnectionId; readonly hostId: string | null }>`
      SELECT connection_id AS "connectionId", host_id AS "hostId"
      FROM outside_agent_connections
      WHERE relay_revoke_pending = 1
      ORDER BY removed_at, connection_id
      LIMIT ${limit}
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ connectionId: row.connectionId, hostId: row.hostId })),
      ),
      wrap("pendingRevocations"),
    );

  const clearRevocations: OutsideAgentConnectionRepositoryShape["clearRevocations"] = (
    connectionIds,
  ) =>
    connectionIds.length === 0
      ? Effect.void
      : sql`
          UPDATE outside_agent_connections SET relay_revoke_pending = 0
          WHERE connection_id IN ${sql.in(connectionIds)}
        `.pipe(Effect.asVoid, wrap("clearRevocations"));

  const transaction: OutsideAgentConnectionRepositoryShape["transaction"] = (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(
            new OutsideAgentConnectionRepositoryError({ operation: "transaction", cause }),
          ),
        ),
      );

  return OutsideAgentConnectionRepository.of({
    get,
    listLive,
    countLive,
    insertReplacing,
    setGrant,
    markRemoved,
    removeUnusedSince,
    touch,
    setRefresh,
    markSeen,
    pendingRevocations,
    clearRevocations,
    transaction,
  });
});

export const OutsideAgentConnectionRepositoryLive = Layer.effect(
  OutsideAgentConnectionRepository,
  make,
);
