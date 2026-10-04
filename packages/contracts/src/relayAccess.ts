import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  RelayDeviceId,
  RelayDeviceKind,
  RelayHostId,
  RelayInviteId,
  RelayJoinerDescription,
  RelayJoinErrorCode,
  RelayRequestId,
  RelayRequestState,
  RelayUsageToday,
} from "./relay.ts";

/** Session subject for devices that joined with "Connect a device"; device lists label them. */
export const RELAY_DEVICE_SESSION_SUBJECT = "relay-device";

/**
 * Server-side "Connect a device" state, streamed to owner clients so the
 * Connections page can show the open code, live join requests (with the
 * number to match), and today's relay allowance.
 *
 * `status` describes the server's link to the relay:
 * - `idle`: nothing needs the relay right now (no relay devices, no invite)
 * - `connecting` / `online` / `offline`: control socket state
 * - `unsupported`: the configured relay has no v2 routes
 * - `disabled`: relay access is turned off for this server
 */
export const RelayHostStatus = Schema.Literals([
  "idle",
  "connecting",
  "online",
  "offline",
  "unsupported",
  "disabled",
]);
export type RelayHostStatus = typeof RelayHostStatus.Type;

/**
 * The open invite. Owner-only: the QR code carries `inviteSecret` and
 * `hostPublicKey` in its fragment, which no server sees.
 */
export const RelayOpenInvite = Schema.Struct({
  inviteId: RelayInviteId,
  hostId: RelayHostId,
  relayOrigin: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
  inviteSecret: TrimmedNonEmptyString,
  hostPublicKey: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type RelayOpenInvite = typeof RelayOpenInvite.Type;

export const RelayHostJoinRequest = Schema.Struct({
  requestId: RelayRequestId,
  inviteId: RelayInviteId,
  deviceId: RelayDeviceId,
  joiner: RelayJoinerDescription,
  /**
   * Code joins: set once the joiner revealed its nonce and the server checked
   * it against the joiner's commitment. Allow is only offered from then on.
   */
  matchNumber: Schema.optionalKey(TrimmedNonEmptyString),
  autoApprove: Schema.Boolean,
  state: RelayRequestState,
  expiresAt: IsoDateTime,
});
export type RelayHostJoinRequest = typeof RelayHostJoinRequest.Type;

export const RelayAccessSnapshot = Schema.Struct({
  status: RelayHostStatus,
  error: Schema.optionalKey(TrimmedNonEmptyString),
  hostLabel: TrimmedNonEmptyString,
  invite: Schema.NullOr(RelayOpenInvite),
  /** Pending requests, plus requests the joiner cancelled while the host was deciding. */
  requests: Schema.Array(RelayHostJoinRequest),
  usage: Schema.NullOr(RelayUsageToday),
});
export type RelayAccessSnapshot = typeof RelayAccessSnapshot.Type;

export const RelayCancelInviteInput = Schema.Struct({
  inviteId: RelayInviteId,
});
export type RelayCancelInviteInput = typeof RelayCancelInviteInput.Type;

export const RelayRespondToJoinRequestInput = Schema.Struct({
  requestId: RelayRequestId,
  allow: Schema.Boolean,
});
export type RelayRespondToJoinRequestInput = typeof RelayRespondToJoinRequestInput.Type;

export const RelayRespondToJoinRequestResult = Schema.Struct({
  requestId: RelayRequestId,
  /** The recorded outcome; may differ from the decision if the joiner cancelled first. */
  state: RelayRequestState,
});
export type RelayRespondToJoinRequestResult = typeof RelayRespondToJoinRequestResult.Type;

/**
 * Joiner side: sends a code join through the joiner's own server, so browsers
 * on any origin can join without the relay accepting their Origin. Only hashes
 * of the joiner's secrets travel; the server fills in its own name.
 */
export const RelaySubmitJoinInput = Schema.Struct({
  relayOrigin: Schema.optionalKey(TrimmedNonEmptyString),
  joinId: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
  deviceSecretHash: TrimmedNonEmptyString,
  requestSecretHash: TrimmedNonEmptyString,
  devicePublicKey: TrimmedNonEmptyString,
  commitment: TrimmedNonEmptyString,
  kind: RelayDeviceKind,
});
export type RelaySubmitJoinInput = typeof RelaySubmitJoinInput.Type;

export const RelaySubmitJoinResult = Schema.Struct({
  relayOrigin: TrimmedNonEmptyString,
  hostId: RelayHostId,
  hostEnvironmentId: TrimmedNonEmptyString,
  requestId: RelayRequestId,
  deviceId: RelayDeviceId,
  hostLabel: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type RelaySubmitJoinResult = typeof RelaySubmitJoinResult.Type;

/**
 * Where a device that joined with "Connect a device" can reach this computer
 * without the relay (same network or Tailscale). Answered only to those
 * devices, over their end-to-end encrypted connection.
 */
export const RelayDirectRoutesResult = Schema.Struct({
  routes: Schema.Array(TrimmedNonEmptyString),
});
export type RelayDirectRoutesResult = typeof RelayDirectRoutesResult.Type;

export class RelayAccessError extends Schema.TaggedError<RelayAccessError>()("RelayAccessError", {
  detail: TrimmedNonEmptyString,
  code: Schema.optionalKey(RelayJoinErrorCode),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Raised by owner-only WebSocket methods when a client-role session calls them. */
export class WsOwnerRequiredError extends Schema.TaggedError<WsOwnerRequiredError>()(
  "WsOwnerRequiredError",
  {
    method: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Only the computer's owner can use ${this.method}.`;
  }
}
