import { AuthSessionId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * A relay device's place in the two-sided approve/revoke handshake:
 * - `approving`: the server issued a session and asked the relay to approve;
 *   the device may not open pipes until the relay confirms.
 * - `active`: both sides agree the device has access.
 * - `revoking`: access was removed here; the relay still has to be told.
 * - `revoked`: both sides agree it's gone (kept briefly for reconciliation).
 */
export const RelayDeviceState = Schema.Literals(["approving", "active", "revoking", "revoked"]);
export type RelayDeviceState = typeof RelayDeviceState.Type;

/**
 * The role a device's session gets: `client` for an app, `peer` for another
 * computer's server (a computer link). Set by this server from the invite the
 * device claimed, never from what the device says it is.
 */
export const RelayDeviceGrant = Schema.Literals(["client", "peer"]);
export type RelayDeviceGrant = typeof RelayDeviceGrant.Type;

/** Why this server made an invite; decides the grant of the device that claims it. */
export const RelayInvitePurpose = Schema.Literals(["device", "computer-link"]);
export type RelayInvitePurpose = typeof RelayInvitePurpose.Type;

export const grantForInvitePurpose = (purpose: RelayInvitePurpose): RelayDeviceGrant =>
  purpose === "computer-link" ? "peer" : "client";

export const RelayDeviceRow = Schema.Struct({
  deviceId: Schema.String,
  requestId: Schema.String,
  relayOrigin: Schema.String,
  sessionId: Schema.NullOr(AuthSessionId),
  state: RelayDeviceState,
  label: Schema.String,
  kind: Schema.String,
  platform: Schema.NullOr(Schema.String),
  /** End-to-end key pinned at approval (base64url P-256); every connection must prove it. */
  devicePublicKey: Schema.String,
  grant: RelayDeviceGrant,
  /** Inbound computer links only: see ComputerLinkAccess. Null: the default. */
  linkAccess: Schema.NullOr(Schema.Literals(["off", "ask", "allowed"])),
  linkMaxRuntimeMode: Schema.NullOr(
    Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  ),
  /** The linked computer's environment id, once it introduced itself. */
  linkEnvironmentId: Schema.NullOr(Schema.String),
  /**
   * `linkEnvironmentId` came from the invite this server made for that
   * computer, so it is fixed; otherwise it is only what the computer said.
   */
  linkEnvironmentPinned: Schema.BooleanFromBit,
  linkLastUsedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RelayDeviceRow = typeof RelayDeviceRow.Type;

/** An invite this server made, as it was persisted when made. */
export const RelayInviteRow = Schema.Struct({
  inviteId: Schema.String,
  purpose: RelayInvitePurpose,
  expiresAt: Schema.String,
  claimedBy: Schema.NullOr(Schema.String),
  approved: Schema.Boolean,
  /** Computer-link invites: the computer it was made for. */
  joinerEnvironmentId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type RelayInviteRow = typeof RelayInviteRow.Type;

/**
 * The server's own record of a code join, written before its nonce is sent.
 * One per invite: an invite gets one try, so a relay in the middle gets one
 * guess at the match number.
 */
export const RelayPairingRow = Schema.Struct({
  requestId: Schema.String,
  inviteId: Schema.String,
  joinId: Schema.String,
  deviceId: Schema.String,
  devicePublicKey: Schema.String,
  commitment: Schema.String,
  hostNonce: Schema.String,
  deviceNonce: Schema.NullOr(Schema.String),
  matchNumber: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type RelayPairingRow = typeof RelayPairingRow.Type;

export const RelayHostRow = Schema.Struct({
  hostId: Schema.String,
  relayOrigin: Schema.String,
  createdAt: Schema.String,
});
export type RelayHostRow = typeof RelayHostRow.Type;

export class RelayRepositoryError extends Data.TaggedError("RelayRepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface RelayDeviceRepositoryShape {
  readonly getHost: Effect.Effect<Option.Option<RelayHostRow>, RelayRepositoryError>;
  readonly saveHost: (host: RelayHostRow) => Effect.Effect<void, RelayRepositoryError>;
  readonly getDevice: (
    deviceId: string,
  ) => Effect.Effect<Option.Option<RelayDeviceRow>, RelayRepositoryError>;
  readonly getDeviceByRequest: (
    requestId: string,
  ) => Effect.Effect<Option.Option<RelayDeviceRow>, RelayRepositoryError>;
  readonly getDeviceBySession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<Option.Option<RelayDeviceRow>, RelayRepositoryError>;
  readonly listDevices: Effect.Effect<ReadonlyArray<RelayDeviceRow>, RelayRepositoryError>;
  /**
   * Inserts an `approving` row unless one exists for the request; returns the
   * stored row. `grant` comes from the verified invite, in the same insert,
   * before any session exists, and so does `linkEnvironmentId` (pinned) when
   * the invite named the computer it was for.
   */
  readonly insertApproving: (input: {
    readonly deviceId: string;
    readonly requestId: string;
    readonly relayOrigin: string;
    readonly label: string;
    readonly kind: string;
    readonly platform: string | null;
    readonly devicePublicKey: string;
    readonly grant: RelayDeviceGrant;
    readonly linkEnvironmentId?: string | null;
    readonly now: string;
  }) => Effect.Effect<RelayDeviceRow, RelayRepositoryError>;
  /** An inbound link's settings; only the fields given change. */
  readonly setLinkSettings: (input: {
    readonly deviceId: string;
    readonly access?: NonNullable<RelayDeviceRow["linkAccess"]>;
    readonly maxRuntimeMode?: NonNullable<RelayDeviceRow["linkMaxRuntimeMode"]>;
    readonly now: string;
  }) => Effect.Effect<void, RelayRepositoryError>;
  /**
   * What a linked computer said about itself (ignored once its id is
   * pinned), and when it last called.
   */
  readonly touchLink: (input: {
    readonly deviceId: string;
    readonly environmentId?: string;
    readonly now: string;
  }) => Effect.Effect<void, RelayRepositoryError>;
  readonly insertInvite: (row: RelayInviteRow) => Effect.Effect<void, RelayRepositoryError>;
  readonly getInvite: (
    inviteId: string,
  ) => Effect.Effect<Option.Option<RelayInviteRow>, RelayRepositoryError>;
  /** Records which request claimed an invite, and whether it was approved. */
  readonly updateInvite: (input: {
    readonly inviteId: string;
    readonly claimedBy: string | null;
    readonly approved: boolean;
  }) => Effect.Effect<void, RelayRepositoryError>;
  /** Forgets invites that expired before `before`. */
  readonly pruneInvites: (before: string) => Effect.Effect<void, RelayRepositoryError>;
  readonly setSession: (input: {
    readonly deviceId: string;
    readonly sessionId: AuthSessionId;
    readonly now: string;
  }) => Effect.Effect<void, RelayRepositoryError>;
  /** Moves a row between states only if it is currently in one of `from`. */
  readonly transition: (input: {
    readonly deviceId: string;
    readonly from: ReadonlyArray<RelayDeviceState>;
    readonly to: RelayDeviceState;
    readonly now: string;
  }) => Effect.Effect<boolean, RelayRepositoryError>;
  readonly deleteDevice: (deviceId: string) => Effect.Effect<void, RelayRepositoryError>;
  /**
   * Records a pairing unless its invite already has one. Returns the stored
   * row for the invite, which may belong to another request.
   */
  readonly insertPairing: (
    row: Omit<RelayPairingRow, "deviceNonce" | "matchNumber">,
  ) => Effect.Effect<RelayPairingRow, RelayRepositoryError>;
  readonly getPairing: (
    requestId: string,
  ) => Effect.Effect<Option.Option<RelayPairingRow>, RelayRepositoryError>;
  readonly getPairingByInvite: (
    inviteId: string,
  ) => Effect.Effect<Option.Option<RelayPairingRow>, RelayRepositoryError>;
  /** Stores the joiner's nonce and the resulting number, once. */
  readonly revealPairing: (input: {
    readonly requestId: string;
    readonly deviceNonce: string;
    readonly matchNumber: string;
  }) => Effect.Effect<void, RelayRepositoryError>;
  /** Forgets pairings older than `before` (their invites have long expired). */
  readonly prunePairings: (before: string) => Effect.Effect<void, RelayRepositoryError>;
  /** Forgets revoked devices last touched before `before`. */
  readonly pruneRevoked: (before: string) => Effect.Effect<void, RelayRepositoryError>;
}

export class RelayDeviceRepository extends Context.Service<
  RelayDeviceRepository,
  RelayDeviceRepositoryShape
>()("threadlines/relay/RelayDeviceRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new RelayRepositoryError({ operation, cause })));

  const selectDevice = `
    SELECT
      device_id AS "deviceId",
      request_id AS "requestId",
      relay_origin AS "relayOrigin",
      session_id AS "sessionId",
      state AS "state",
      label AS "label",
      kind AS "kind",
      platform AS "platform",
      device_public_key AS "devicePublicKey",
      access_grant AS "grant",
      link_access AS "linkAccess",
      link_max_runtime_mode AS "linkMaxRuntimeMode",
      link_environment_id AS "linkEnvironmentId",
      link_environment_pinned AS "linkEnvironmentPinned",
      link_last_used_at AS "linkLastUsedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM relay_devices
  `;

  const selectPairing = `
    SELECT
      request_id AS "requestId",
      invite_id AS "inviteId",
      join_id AS "joinId",
      device_id AS "deviceId",
      device_public_key AS "devicePublicKey",
      commitment AS "commitment",
      host_nonce AS "hostNonce",
      device_nonce AS "deviceNonce",
      match_number AS "matchNumber",
      created_at AS "createdAt"
    FROM relay_pairings
  `;

  const findPairing = SqlSchema.findOneOption({
    Request: Schema.Struct({
      column: Schema.Literals(["request_id", "invite_id"]),
      value: Schema.String,
    }),
    Result: RelayPairingRow,
    execute: ({ column, value }) => sql.unsafe(`${selectPairing} WHERE ${column} = ?`, [value]),
  });

  const findDevice = SqlSchema.findOneOption({
    Request: Schema.Struct({
      column: Schema.Literals(["device_id", "request_id", "session_id"]),
      value: Schema.String,
    }),
    Result: RelayDeviceRow,
    execute: ({ column, value }) => sql.unsafe(`${selectDevice} WHERE ${column} = ?`, [value]),
  });

  const getHost: RelayDeviceRepositoryShape["getHost"] = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: RelayHostRow,
    execute: () => sql`
      SELECT host_id AS "hostId", relay_origin AS "relayOrigin", created_at AS "createdAt"
      FROM relay_host WHERE id = 1
    `,
  })(undefined).pipe(wrap("getHost"));

  const saveHost: RelayDeviceRepositoryShape["saveHost"] = (host) =>
    sql`
      INSERT INTO relay_host (id, host_id, relay_origin, created_at)
      VALUES (1, ${host.hostId}, ${host.relayOrigin}, ${host.createdAt})
      ON CONFLICT(id) DO UPDATE SET
        host_id = excluded.host_id,
        relay_origin = excluded.relay_origin,
        created_at = excluded.created_at
    `.pipe(Effect.asVoid, wrap("saveHost"));

  const getDevice: RelayDeviceRepositoryShape["getDevice"] = (deviceId) =>
    findDevice({ column: "device_id", value: deviceId }).pipe(wrap("getDevice"));
  const getDeviceByRequest: RelayDeviceRepositoryShape["getDeviceByRequest"] = (requestId) =>
    findDevice({ column: "request_id", value: requestId }).pipe(wrap("getDeviceByRequest"));
  const getDeviceBySession: RelayDeviceRepositoryShape["getDeviceBySession"] = (sessionId) =>
    findDevice({ column: "session_id", value: sessionId }).pipe(wrap("getDeviceBySession"));

  const listDevices: RelayDeviceRepositoryShape["listDevices"] = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RelayDeviceRow,
    execute: () => sql.unsafe(`${selectDevice} ORDER BY created_at`),
  })(undefined).pipe(wrap("listDevices"));

  const insertApproving: RelayDeviceRepositoryShape["insertApproving"] = (input) =>
    Effect.gen(function* () {
      const pinned = input.linkEnvironmentId != null;
      yield* sql`
        INSERT INTO relay_devices (
          device_id, request_id, relay_origin, session_id, state, label, kind, platform,
          device_public_key, access_grant, link_environment_id, link_environment_pinned,
          created_at, updated_at
        ) VALUES (
          ${input.deviceId}, ${input.requestId}, ${input.relayOrigin}, NULL, 'approving',
          ${input.label}, ${input.kind}, ${input.platform}, ${input.devicePublicKey},
          ${input.grant}, ${input.linkEnvironmentId ?? null}, ${pinned ? 1 : 0},
          ${input.now}, ${input.now}
        )
        ON CONFLICT(request_id) DO NOTHING
      `;
      const row = yield* findDevice({ column: "request_id", value: input.requestId });
      return Option.getOrThrow(row);
    }).pipe(wrap("insertApproving"));

  const setLinkSettings: RelayDeviceRepositoryShape["setLinkSettings"] = (input) =>
    sql`
      UPDATE relay_devices SET
        link_access = COALESCE(${input.access ?? null}, link_access),
        link_max_runtime_mode = COALESCE(${input.maxRuntimeMode ?? null}, link_max_runtime_mode),
        updated_at = ${input.now}
      WHERE device_id = ${input.deviceId}
    `.pipe(Effect.asVoid, wrap("setLinkSettings"));

  const touchLink: RelayDeviceRepositoryShape["touchLink"] = (input) =>
    sql`
      UPDATE relay_devices SET
        link_environment_id = CASE
          WHEN link_environment_pinned = 1 THEN link_environment_id
          ELSE COALESCE(${input.environmentId ?? null}, link_environment_id)
        END,
        link_last_used_at = ${input.now}
      WHERE device_id = ${input.deviceId}
    `.pipe(Effect.asVoid, wrap("touchLink"));

  const insertInvite: RelayDeviceRepositoryShape["insertInvite"] = (row) =>
    sql`
      INSERT INTO relay_invites (
        invite_id, purpose, expires_at, claimed_by, approved, joiner_environment_id, created_at
      )
      VALUES (
        ${row.inviteId}, ${row.purpose}, ${row.expiresAt}, ${row.claimedBy},
        ${row.approved ? 1 : 0}, ${row.joinerEnvironmentId}, ${row.createdAt}
      )
      ON CONFLICT(invite_id) DO NOTHING
    `.pipe(Effect.asVoid, wrap("insertInvite"));

  const getInvite: RelayDeviceRepositoryShape["getInvite"] = (inviteId) =>
    SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ ...RelayInviteRow.fields, approved: Schema.Number }),
      execute: (id) => sql`
        SELECT
          invite_id AS "inviteId",
          purpose AS "purpose",
          expires_at AS "expiresAt",
          claimed_by AS "claimedBy",
          approved AS "approved",
          joiner_environment_id AS "joinerEnvironmentId",
          created_at AS "createdAt"
        FROM relay_invites WHERE invite_id = ${id}
      `,
    })(inviteId).pipe(
      Effect.map(Option.map((row) => ({ ...row, approved: row.approved !== 0 }))),
      wrap("getInvite"),
    );

  const updateInvite: RelayDeviceRepositoryShape["updateInvite"] = (input) =>
    sql`
      UPDATE relay_invites SET claimed_by = ${input.claimedBy}, approved = ${input.approved ? 1 : 0}
      WHERE invite_id = ${input.inviteId}
    `.pipe(Effect.asVoid, wrap("updateInvite"));

  const pruneInvites: RelayDeviceRepositoryShape["pruneInvites"] = (before) =>
    sql`DELETE FROM relay_invites WHERE expires_at < ${before}`.pipe(
      Effect.asVoid,
      wrap("pruneInvites"),
    );

  const setSession: RelayDeviceRepositoryShape["setSession"] = (input) =>
    sql`
      UPDATE relay_devices SET session_id = ${input.sessionId}, updated_at = ${input.now}
      WHERE device_id = ${input.deviceId}
    `.pipe(Effect.asVoid, wrap("setSession"));

  const transition: RelayDeviceRepositoryShape["transition"] = (input) =>
    Effect.gen(function* () {
      if (input.from.length === 0) return false;
      const placeholders = input.from.map(() => "?").join(", ");
      const rows = yield* sql.unsafe<{ readonly deviceId: string }>(
        `UPDATE relay_devices SET state = ?, updated_at = ?
         WHERE device_id = ? AND state IN (${placeholders})
         RETURNING device_id AS "deviceId"`,
        [input.to, input.now, input.deviceId, ...input.from],
      );
      return rows.length > 0;
    }).pipe(wrap("transition"));

  const deleteDevice: RelayDeviceRepositoryShape["deleteDevice"] = (deviceId) =>
    sql`DELETE FROM relay_devices WHERE device_id = ${deviceId}`.pipe(
      Effect.asVoid,
      wrap("deleteDevice"),
    );

  const insertPairing: RelayDeviceRepositoryShape["insertPairing"] = (row) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO relay_pairings (
          request_id, invite_id, join_id, device_id, device_public_key, commitment, host_nonce,
          device_nonce, match_number, created_at
        ) VALUES (
          ${row.requestId}, ${row.inviteId}, ${row.joinId}, ${row.deviceId},
          ${row.devicePublicKey}, ${row.commitment}, ${row.hostNonce}, NULL, NULL, ${row.createdAt}
        )
        ON CONFLICT DO NOTHING
      `;
      const stored = yield* findPairing({ column: "invite_id", value: row.inviteId });
      return Option.getOrThrow(stored);
    }).pipe(wrap("insertPairing"));

  const getPairing: RelayDeviceRepositoryShape["getPairing"] = (requestId) =>
    findPairing({ column: "request_id", value: requestId }).pipe(wrap("getPairing"));
  const getPairingByInvite: RelayDeviceRepositoryShape["getPairingByInvite"] = (inviteId) =>
    findPairing({ column: "invite_id", value: inviteId }).pipe(wrap("getPairingByInvite"));

  const revealPairing: RelayDeviceRepositoryShape["revealPairing"] = (input) =>
    sql`
      UPDATE relay_pairings
      SET device_nonce = ${input.deviceNonce}, match_number = ${input.matchNumber}
      WHERE request_id = ${input.requestId} AND device_nonce IS NULL
    `.pipe(Effect.asVoid, wrap("revealPairing"));

  const prunePairings: RelayDeviceRepositoryShape["prunePairings"] = (before) =>
    sql`DELETE FROM relay_pairings WHERE created_at < ${before}`.pipe(
      Effect.asVoid,
      wrap("prunePairings"),
    );

  const pruneRevoked: RelayDeviceRepositoryShape["pruneRevoked"] = (before) =>
    sql`DELETE FROM relay_devices WHERE state = 'revoked' AND updated_at < ${before}`.pipe(
      Effect.asVoid,
      wrap("pruneRevoked"),
    );

  return RelayDeviceRepository.of({
    pruneRevoked,
    insertPairing,
    getPairing,
    getPairingByInvite,
    revealPairing,
    prunePairings,
    getHost,
    saveHost,
    getDevice,
    getDeviceByRequest,
    getDeviceBySession,
    listDevices,
    insertApproving,
    setLinkSettings,
    touchLink,
    insertInvite,
    getInvite,
    updateInvite,
    pruneInvites,
    setSession,
    transition,
    deleteDevice,
  });
});

export const RelayDeviceRepositoryLive = Layer.effect(RelayDeviceRepository, make);
