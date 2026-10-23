import {
  IsoDateTime,
  OutsideAgentAccess,
  OutsideAgentConnectionId,
  type OutsideAgentGrant,
  ProjectId,
  RuntimeMode,
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
 * Outside agents' approved sign-ins (`outside_agent_connections`, migration
 * 087; docs/design/outside-agents.md). A row is the one authority every
 * `/mcp/connect` call is checked against: its grant is read again on each
 * call, and a removed row refuses every token.
 */

/** Why a connection stopped: the user removed it, a new approval for the same agent replaced it, or 90 days unused. */
export const OutsideAgentRemovedReason = Schema.Literals(["removed", "replaced", "unused"]);
export type OutsideAgentRemovedReason = typeof OutsideAgentRemovedReason.Type;

export const OutsideAgentConnectionRow = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  /** sha256 of the client id: the registration, so "the same agent" is the same hash. */
  clientIdHash: Schema.String,
  clientName: Schema.String,
  softwareId: Schema.NullOr(Schema.String),
  /** The exact callback the approval went back to. */
  redirectUri: Schema.String,
  /** The resource its tokens are bound to (`<origin>/mcp/connect`). */
  resource: Schema.String,
  access: OutsideAgentAccess,
  maxRuntimeMode: RuntimeMode,
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
  tokenGeneration: Schema.Int,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  removedAt: Schema.NullOr(IsoDateTime),
  removedReason: Schema.NullOr(OutsideAgentRemovedReason),
});
export type OutsideAgentConnectionRow = typeof OutsideAgentConnectionRow.Type;

const OutsideAgentConnectionDbRow = Schema.Struct({
  ...OutsideAgentConnectionRow.fields,
  projectIds: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProjectId))),
});

export class OutsideAgentConnectionRepositoryError extends Data.TaggedError(
  "OutsideAgentConnectionRepositoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface OutsideAgentConnectionRepositoryShape {
  readonly get: (
    connectionId: OutsideAgentConnectionId,
  ) => Effect.Effect<
    Option.Option<OutsideAgentConnectionRow>,
    OutsideAgentConnectionRepositoryError
  >;
  /** Connections that aren't removed, newest first. */
  readonly listLive: Effect.Effect<
    ReadonlyArray<OutsideAgentConnectionRow>,
    OutsideAgentConnectionRepositoryError
  >;
  /**
   * Saves a new connection, in one transaction with removing (reason
   * `replaced`) every live one from the same registration. Returns the ids
   * it replaced.
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
  /** Removes a live connection; false when it was already removed or is unknown. */
  readonly markRemoved: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly reason: OutsideAgentRemovedReason;
    readonly now: string;
  }) => Effect.Effect<boolean, OutsideAgentConnectionRepositoryError>;
  readonly touch: (input: {
    readonly connectionId: OutsideAgentConnectionId;
    readonly now: string;
  }) => Effect.Effect<void, OutsideAgentConnectionRepositoryError>;
}

export class OutsideAgentConnectionRepository extends Context.Service<
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryShape
>()("threadlines/outsideAgents/OutsideAgentConnectionRepository") {}

const projectIdsJson = (projectIds: OutsideAgentGrant["projectIds"]) =>
  projectIds === null ? null : JSON.stringify(projectIds);

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
      client_id_hash AS "clientIdHash",
      client_name AS "clientName",
      software_id AS "softwareId",
      redirect_uri AS "redirectUri",
      resource AS "resource",
      access AS "access",
      max_runtime_mode AS "maxRuntimeMode",
      project_ids_json AS "projectIds",
      token_generation AS "tokenGeneration",
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
    findOne(connectionId).pipe(wrap("get"));

  const listLive: OutsideAgentConnectionRepositoryShape["listLive"] = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OutsideAgentConnectionDbRow,
    execute: () =>
      sql.unsafe(
        `${selectRow} WHERE removed_at IS NULL ORDER BY created_at DESC, connection_id DESC`,
      ),
  })(undefined).pipe(wrap("listLive"));

  const insertReplacing: OutsideAgentConnectionRepositoryShape["insertReplacing"] = (row) =>
    Effect.gen(function* () {
      const replaced = yield* sql<{ readonly connectionId: OutsideAgentConnectionId }>`
        UPDATE outside_agent_connections
        SET removed_at = ${row.createdAt}, removed_reason = 'replaced'
        WHERE client_id_hash = ${row.clientIdHash} AND removed_at IS NULL
        RETURNING connection_id AS "connectionId"
      `;
      yield* sql`
        INSERT INTO outside_agent_connections (
          connection_id, client_id_hash, client_name, software_id, redirect_uri, resource,
          access, max_runtime_mode, project_ids_json, token_generation,
          created_at, last_used_at, removed_at, removed_reason
        ) VALUES (
          ${row.connectionId}, ${row.clientIdHash}, ${row.clientName}, ${row.softwareId},
          ${row.redirectUri}, ${row.resource}, ${row.access}, ${row.maxRuntimeMode},
          ${projectIdsJson(row.projectIds)}, ${row.tokenGeneration},
          ${row.createdAt}, ${row.lastUsedAt}, ${row.removedAt}, ${row.removedReason}
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
      return yield* findOne(input.connectionId);
    }).pipe(wrap("setGrant"));

  const markRemoved: OutsideAgentConnectionRepositoryShape["markRemoved"] = (input) =>
    sql<{ readonly connectionId: string }>`
      UPDATE outside_agent_connections
      SET removed_at = ${input.now}, removed_reason = ${input.reason}
      WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
      RETURNING connection_id AS "connectionId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      wrap("markRemoved"),
    );

  const touch: OutsideAgentConnectionRepositoryShape["touch"] = (input) =>
    sql`
      UPDATE outside_agent_connections SET last_used_at = ${input.now}
      WHERE connection_id = ${input.connectionId} AND removed_at IS NULL
    `.pipe(Effect.asVoid, wrap("touch"));

  return OutsideAgentConnectionRepository.of({
    get,
    listLive,
    insertReplacing,
    setGrant,
    markRemoved,
    touch,
  });
});

export const OutsideAgentConnectionRepositoryLive = Layer.effect(
  OutsideAgentConnectionRepository,
  make,
);
