import * as Schema from "effect/Schema";

import {
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

/** An outbound link's standing: `revoked` once the other computer removed it. */
export const ComputerLinkState = Schema.Literals(["active", "revoked", "failed"]);
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
  /**
   * `environmentId` was fixed when this computer made the invite (the app
   * that asked for it named the computer it was for), so the other computer
   * can't pass itself off as a different one. False or missing: it is only
   * what that computer said about itself.
   */
  environmentPinned: Schema.optional(Schema.Boolean),
  label: TrimmedNonEmptyString,
  platform: Schema.NullOr(TrimmedNonEmptyString),
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

/**
 * The computer that will claim the invite, as the app that asks for it knows
 * it. This computer records the link as that computer's from the start, and
 * refuses the link when it later says it is a different one.
 */
export const LinksCreateInviteInput = Schema.Struct({ joinerEnvironmentId: EnvironmentId });
export type LinksCreateInviteInput = typeof LinksCreateInviteInput.Type;

export const LinksAcceptInput = Schema.Struct({ invite: ComputerLinkInvite });
export type LinksAcceptInput = typeof LinksAcceptInput.Type;

export const LinksSetAccessInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  access: Schema.optional(ComputerLinkAccess),
  maxRuntimeMode: Schema.optional(RuntimeMode),
});
export type LinksSetAccessInput = typeof LinksSetAccessInput.Type;

export const LinksRemoveInput = Schema.Union([
  Schema.Struct({ direction: Schema.Literal("outbound"), linkId: ComputerLinkId }),
  Schema.Struct({ direction: Schema.Literal("inbound"), deviceId: TrimmedNonEmptyString }),
]);
export type LinksRemoveInput = typeof LinksRemoveInput.Type;

export const LinksRespondRequestInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  requestId: ChildRequestId,
  allow: Schema.Boolean,
});
export type LinksRespondRequestInput = typeof LinksRespondRequestInput.Type;
