import {
  ComputerLinkId,
  ComputerLinkState,
  EnvironmentId,
  IsoDateTime,
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
 * This server's own links to other computers (docs/design/fleet.md, Part 1):
 * where each computer is, and how this server signs in there as a `peer`
 * device. The device's keys live in the server secret store, never here.
 */
export const ComputerLinkRow = Schema.Struct({
  linkId: ComputerLinkId,
  remoteEnvironmentId: EnvironmentId,
  remoteLabel: Schema.String,
  remotePlatform: Schema.NullOr(Schema.String),
  relayOrigin: Schema.String,
  hostId: Schema.String,
  deviceId: Schema.String,
  hostPublicKey: Schema.String,
  directRoutes: Schema.Array(Schema.String),
  state: ComputerLinkState,
  createdAt: IsoDateTime,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type ComputerLinkRow = typeof ComputerLinkRow.Type;

const ComputerLinkDbRow = Schema.Struct({
  ...ComputerLinkRow.fields,
  directRoutes: Schema.fromJsonString(Schema.Array(Schema.String)),
});

export class ComputerLinkRepositoryError extends Data.TaggedError("ComputerLinkRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ComputerLinkRepositoryShape {
  readonly list: Effect.Effect<ReadonlyArray<ComputerLinkRow>, ComputerLinkRepositoryError>;
  readonly get: (
    linkId: ComputerLinkId,
  ) => Effect.Effect<Option.Option<ComputerLinkRow>, ComputerLinkRepositoryError>;
  /** The newest link to that computer that isn't revoked, if any. */
  readonly getByEnvironment: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<ComputerLinkRow>, ComputerLinkRepositoryError>;
  readonly insert: (row: ComputerLinkRow) => Effect.Effect<void, ComputerLinkRepositoryError>;
  readonly update: (input: {
    readonly linkId: ComputerLinkId;
    readonly state?: ComputerLinkRow["state"];
    readonly remoteLabel?: string;
    readonly remotePlatform?: string | null;
    readonly directRoutes?: ReadonlyArray<string>;
    readonly lastConnectedAt?: string;
    readonly lastError?: string | null;
  }) => Effect.Effect<void, ComputerLinkRepositoryError>;
  readonly remove: (linkId: ComputerLinkId) => Effect.Effect<void, ComputerLinkRepositoryError>;
}

export class ComputerLinkRepository extends Context.Service<
  ComputerLinkRepository,
  ComputerLinkRepositoryShape
>()("threadlines/links/ComputerLinkRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ComputerLinkRepositoryError({ operation, cause })),
      );

  const select = `
    SELECT
      link_id AS "linkId",
      remote_environment_id AS "remoteEnvironmentId",
      remote_label AS "remoteLabel",
      remote_platform AS "remotePlatform",
      relay_origin AS "relayOrigin",
      host_id AS "hostId",
      device_id AS "deviceId",
      host_public_key AS "hostPublicKey",
      direct_routes_json AS "directRoutes",
      state AS "state",
      created_at AS "createdAt",
      last_connected_at AS "lastConnectedAt",
      last_error AS "lastError"
    FROM computer_links
  `;

  const list: ComputerLinkRepositoryShape["list"] = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ComputerLinkDbRow,
    execute: () => sql.unsafe(`${select} ORDER BY created_at`),
  })(undefined).pipe(wrap("list"));

  const get: ComputerLinkRepositoryShape["get"] = (linkId) =>
    SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ComputerLinkDbRow,
      execute: (id) => sql.unsafe(`${select} WHERE link_id = ?`, [id]),
    })(linkId).pipe(wrap("get"));

  const getByEnvironment: ComputerLinkRepositoryShape["getByEnvironment"] = (environmentId) =>
    SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ComputerLinkDbRow,
      execute: (id) =>
        sql.unsafe(
          `${select} WHERE remote_environment_id = ? AND state != 'revoked'
           ORDER BY created_at DESC LIMIT 1`,
          [id],
        ),
    })(environmentId).pipe(wrap("getByEnvironment"));

  const encodeRoutes = (routes: ReadonlyArray<string>) => JSON.stringify(routes);

  const insert: ComputerLinkRepositoryShape["insert"] = (row) =>
    sql`
      INSERT INTO computer_links (
        link_id, remote_environment_id, remote_label, remote_platform, relay_origin, host_id,
        device_id, host_public_key, direct_routes_json, state, created_at, last_connected_at,
        last_error
      ) VALUES (
        ${row.linkId}, ${row.remoteEnvironmentId}, ${row.remoteLabel}, ${row.remotePlatform},
        ${row.relayOrigin}, ${row.hostId}, ${row.deviceId}, ${row.hostPublicKey},
        ${encodeRoutes(row.directRoutes)}, ${row.state}, ${row.createdAt},
        ${row.lastConnectedAt}, ${row.lastError}
      )
      ON CONFLICT(link_id) DO NOTHING
    `.pipe(Effect.asVoid, wrap("insert"));

  const update: ComputerLinkRepositoryShape["update"] = (input) =>
    Effect.gen(function* () {
      const sets: Array<string> = [];
      const values: Array<string | null> = [];
      const set = (column: string, value: string | null) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (input.state !== undefined) set("state", input.state);
      if (input.remoteLabel !== undefined) set("remote_label", input.remoteLabel);
      if (input.remotePlatform !== undefined) set("remote_platform", input.remotePlatform);
      if (input.directRoutes !== undefined) {
        set("direct_routes_json", encodeRoutes(input.directRoutes));
      }
      if (input.lastConnectedAt !== undefined) set("last_connected_at", input.lastConnectedAt);
      if (input.lastError !== undefined) set("last_error", input.lastError);
      if (sets.length === 0) return;
      yield* sql.unsafe(`UPDATE computer_links SET ${sets.join(", ")} WHERE link_id = ?`, [
        ...values,
        input.linkId,
      ]);
    }).pipe(wrap("update"));

  const remove: ComputerLinkRepositoryShape["remove"] = (linkId) =>
    sql`DELETE FROM computer_links WHERE link_id = ${linkId}`.pipe(Effect.asVoid, wrap("remove"));

  return ComputerLinkRepository.of({ list, get, getByEnvironment, insert, update, remove });
});

export const ComputerLinkRepositoryLive = Layer.effect(ComputerLinkRepository, make);
