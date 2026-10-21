import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  ChildRequestId,
  EnvironmentId,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";
import { RelayHostId, RelayInviteId } from "./relay.ts";

/**
 * Computer links (docs/design/fleet.md, Part 1). A link A → B makes A's
 * server a paired device of B's server with the `peer` role, so agents on A
 * can start and steer threads on B under B's per-link access setting. Links
 * are directional; the client's one "Link" action makes both directions.
 */

export const ComputerLinkId = TrimmedNonEmptyString.pipe(Schema.brand("ComputerLinkId"));
export type ComputerLinkId = typeof ComputerLinkId.Type;

/**
 * An outbound link's standing: `revoked` once the other computer removed it;
 * `unlinking` once this computer removed it while the other one couldn't be
 * reached. Nothing new goes over an unlinking link, and the other computer is
 * told when it is next reached; then the link is gone.
 */
export const ComputerLinkState = Schema.Literals(["active", "revoked", "failed", "unlinking"]);
export type ComputerLinkState = typeof ComputerLinkState.Type;

/** Whether this server is connected to the other computer right now. */
export const ComputerLinkConnection = Schema.Literals([
  "connected",
  "connecting",
  "reconnecting",
  "idle",
  "offline",
]);
export type ComputerLinkConnection = typeof ComputerLinkConnection.Type;

/**
 * What an inbound link may do here: `off` refuses everything, `ask` waits for
 * this computer's user to allow each new thread, `allowed` starts them.
 */
export const ComputerLinkAccess = Schema.Literals(["off", "ask", "allowed"]);
export type ComputerLinkAccess = typeof ComputerLinkAccess.Type;
export const DEFAULT_COMPUTER_LINK_ACCESS: ComputerLinkAccess = "ask";

/** This server's link to another computer. */
export const OutboundComputerLink = Schema.Struct({
  linkId: ComputerLinkId,
  remoteEnvironmentId: EnvironmentId,
  remoteLabel: TrimmedNonEmptyString,
  remotePlatform: Schema.NullOr(TrimmedNonEmptyString),
  state: ComputerLinkState,
  connection: ComputerLinkConnection,
  /** How the open connection reaches it. */
  route: Schema.NullOr(Schema.Literals(["direct", "relay"])),
  createdAt: IsoDateTime,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type OutboundComputerLink = typeof OutboundComputerLink.Type;

/** Another computer's link to this server: a `peer` device. */
export const InboundComputerLink = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  /** The other computer, once it introduced itself. */
  environmentId: Schema.NullOr(EnvironmentId),
  label: TrimmedNonEmptyString,
  platform: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Its session here, as Settings › Connections lists it among the devices
   * with access: the stable way to tell which device row is this link (two
   * computers can share a name). Null while it is still being approved.
   */
  sessionId: Schema.NullOr(AuthSessionId),
  access: ComputerLinkAccess,
  /** The most access a thread it starts here gets. */
  maxRuntimeMode: RuntimeMode,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type InboundComputerLink = typeof InboundComputerLink.Type;

/** A thread another computer asked to start here, waiting for this computer's user. */
export const ComputerLinkPendingRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  requestId: ChildRequestId,
  /** The asking computer's name. */
  fromLabel: TrimmedNonEmptyString,
  parentThreadTitle: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  prompt: Schema.String,
  projectName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ComputerLinkPendingRequest = typeof ComputerLinkPendingRequest.Type;

export const ComputerLinksSnapshot = Schema.Struct({
  outbound: Schema.Array(OutboundComputerLink),
  inbound: Schema.Array(InboundComputerLink),
  pending: Schema.Array(ComputerLinkPendingRequest),
});
export type ComputerLinksSnapshot = typeof ComputerLinksSnapshot.Type;

/**
 * A single-use invite (10 minutes) for another computer's server to link to
 * this one. The other server claims it as a device; this server approves the
 * claim on its own and grants it the `peer` role.
 */
export const ComputerLinkInvite = Schema.Struct({
  hostId: RelayHostId,
  relayOrigin: TrimmedNonEmptyString,
  inviteId: RelayInviteId,
  inviteSecret: TrimmedNonEmptyString,
  hostPublicKey: TrimmedNonEmptyString,
  /**
   * Where this server listens without the relay (`ws://address:port`,
   * Tailscale `wss://`). The joiner adds its device's direct path.
   */
  directOrigins: Schema.Array(TrimmedNonEmptyString),
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ComputerLinkInvite = typeof ComputerLinkInvite.Type;

export class ComputerLinkError extends Schema.TaggedError<ComputerLinkError>()(
  "ComputerLinkError",
  {
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const LinksAcceptInput = Schema.Struct({ invite: ComputerLinkInvite });
export type LinksAcceptInput = typeof LinksAcceptInput.Type;

export const LinksSetAccessInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  access: Schema.optional(ComputerLinkAccess),
  maxRuntimeMode: Schema.optional(RuntimeMode),
});
export type LinksSetAccessInput = typeof LinksSetAccessInput.Type;

/**
 * Removes one half of a link: the asking computer's link (outbound) or the
 * working computer's access for it (inbound). Unlinking two computers removes
 * every half the app can reach, each on the computer that holds it
 * (docs/design/fleet.md, Rev 4 "Unlink"). Removing an outbound link is always
 * an unlink: the other computer, when told, stops what this one's link started
 * there and forgets its own link back to this one.
 */
export const LinksRemoveInput = Schema.Union([
  Schema.Struct({
    direction: Schema.Literal("outbound"),
    linkId: ComputerLinkId,
    /**
     * The app already removed the other computer's halves, so there is
     * nothing to tell it.
     */
    otherHalfRemoved: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    direction: Schema.Literal("inbound"),
    deviceId: TrimmedNonEmptyString,
    /** Also stop the threads this link started here that are still running. */
    stopRunning: Schema.optional(Schema.Boolean),
  }),
]);
export type LinksRemoveInput = typeof LinksRemoveInput.Type;

/**
 * Whether the other computer has done its half. `pending`: it couldn't be
 * reached, so this computer keeps the link as `unlinking` and finishes when it
 * next reaches it. A half that wasn't confirmed is never reported done.
 * `not_asked`: an inbound removal, which is this computer's alone.
 */
export const LinksRemoveResult = Schema.Struct({
  otherComputer: Schema.Literals(["confirmed", "pending", "not_asked"]),
});
export type LinksRemoveResult = typeof LinksRemoveResult.Type;

export const LinksRespondRequestInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  requestId: ChildRequestId,
  allow: Schema.Boolean,
});
export type LinksRespondRequestInput = typeof LinksRespondRequestInput.Type;
