import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RelaySessionId = TrimmedNonEmptyString.pipe(Schema.brand("RelaySessionId"));
export type RelaySessionId = typeof RelaySessionId.Type;

export const RelayConnectionId = TrimmedNonEmptyString.pipe(Schema.brand("RelayConnectionId"));
export type RelayConnectionId = typeof RelayConnectionId.Type;

export const RelayConnectionRole = Schema.Literals(["desktop", "device"]);
export type RelayConnectionRole = typeof RelayConnectionRole.Type;

export const RelayForwardTarget = Schema.Literals(["desktop", "devices"]);
export type RelayForwardTarget = typeof RelayForwardTarget.Type;

export const RELAY_WEBSOCKET_PROTOCOL = "threadlines-relay" as const;
export const RELAY_TOKEN_PROTOCOL_PREFIX = "threadlines-token." as const;

// Raw-mode relay sockets carry opaque app frames, so relay control events are
// marked with a leading ASCII record separator that no JSON app frame can
// start with.
export const RELAY_RAW_CONTROL_PREFIX = "\u001E" as const;

export const RELAY_CLOSE_CODE_PEER_UNAVAILABLE = 1013;
export const RELAY_CLOSE_CODE_SESSION_EXPIRED = 4000;
export const RELAY_CLOSE_CODE_REPLACED = 4001;

export const RelayPeerSummary = Schema.Struct({
  desktopConnected: Schema.Boolean,
  deviceCount: Schema.Number,
});
export type RelayPeerSummary = typeof RelayPeerSummary.Type;

export const RelayCreateSessionRequest = Schema.Struct({
  deviceLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayCreateSessionRequest = typeof RelayCreateSessionRequest.Type;

export const RelayCreateSessionResult = Schema.Struct({
  sessionId: RelaySessionId,
  desktopToken: TrimmedNonEmptyString,
  deviceToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  desktopSocketUrl: TrimmedNonEmptyString,
  deviceSocketUrl: TrimmedNonEmptyString,
  pairingUrl: TrimmedNonEmptyString,
});
export type RelayCreateSessionResult = typeof RelayCreateSessionResult.Type;

export const RelayRenewSessionResult = Schema.Struct({
  expiresAt: IsoDateTime,
});
export type RelayRenewSessionResult = typeof RelayRenewSessionResult.Type;

export const RelaySessionStatusResult = Schema.Struct({
  exists: Schema.Boolean,
  expired: Schema.Boolean,
  desktopConnected: Schema.Boolean,
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type RelaySessionStatusResult = typeof RelaySessionStatusResult.Type;

export const RelayForwardMessage = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.forward"),
  target: RelayForwardTarget,
  payload: Schema.Unknown,
});
export type RelayForwardMessage = typeof RelayForwardMessage.Type;

export const RelayPingMessage = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.ping"),
});
export type RelayPingMessage = typeof RelayPingMessage.Type;

export const RelayClientMessage = Schema.Union([RelayForwardMessage, RelayPingMessage]);
export type RelayClientMessage = typeof RelayClientMessage.Type;

export const RelayReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.ready"),
  sessionId: RelaySessionId,
  connectionId: RelayConnectionId,
  role: RelayConnectionRole,
  peers: RelayPeerSummary,
});
export type RelayReadyEvent = typeof RelayReadyEvent.Type;

export const RelayForwardedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.forwarded"),
  from: RelayConnectionRole,
  connectionId: RelayConnectionId,
  payload: Schema.Unknown,
});
export type RelayForwardedEvent = typeof RelayForwardedEvent.Type;

export const RelayPeerJoinedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.peer-joined"),
  role: RelayConnectionRole,
  connectionId: RelayConnectionId,
  peers: RelayPeerSummary,
});
export type RelayPeerJoinedEvent = typeof RelayPeerJoinedEvent.Type;

export const RelayPeerLeftEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.peer-left"),
  role: RelayConnectionRole,
  connectionId: RelayConnectionId,
  peers: RelayPeerSummary,
});
export type RelayPeerLeftEvent = typeof RelayPeerLeftEvent.Type;

export const RelayPongEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.pong"),
});
export type RelayPongEvent = typeof RelayPongEvent.Type;

export const RelayErrorCode = Schema.Literals([
  "bad-message",
  "not-authenticated",
  "peer-unavailable",
  "session-expired",
]);
export type RelayErrorCode = typeof RelayErrorCode.Type;

export const RelayErrorEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.error"),
  code: RelayErrorCode,
  message: TrimmedNonEmptyString,
});
export type RelayErrorEvent = typeof RelayErrorEvent.Type;

export const RelayServerEvent = Schema.Union([
  RelayReadyEvent,
  RelayForwardedEvent,
  RelayPeerJoinedEvent,
  RelayPeerLeftEvent,
  RelayPongEvent,
  RelayErrorEvent,
]);
export type RelayServerEvent = typeof RelayServerEvent.Type;

// ---------------------------------------------------------------------------
// Relay v2: "Connect a device".
//
// One relay host per Threadlines server. Devices join with a short code (host
// approves after matching a number) or a QR invite secret (instant), and each
// device then holds its own relay credential and gets its own data pipe to
// the host. The relay only ever stores hashes of secrets; joiners generate
// their own device and request secrets, so nothing secret is delivered.
// ---------------------------------------------------------------------------

export const RelayHostId = TrimmedNonEmptyString.pipe(Schema.brand("RelayHostId"));
export type RelayHostId = typeof RelayHostId.Type;

export const RelayDeviceId = TrimmedNonEmptyString.pipe(Schema.brand("RelayDeviceId"));
export type RelayDeviceId = typeof RelayDeviceId.Type;

export const RelayRequestId = TrimmedNonEmptyString.pipe(Schema.brand("RelayRequestId"));
export type RelayRequestId = typeof RelayRequestId.Type;

export const RelayInviteId = TrimmedNonEmptyString.pipe(Schema.brand("RelayInviteId"));
export type RelayInviteId = typeof RelayInviteId.Type;

export const RelayPipeId = TrimmedNonEmptyString.pipe(Schema.brand("RelayPipeId"));
export type RelayPipeId = typeof RelayPipeId.Type;

/** Closes a device's sockets after the host removed its access. */
export const RELAY_CLOSE_CODE_ACCESS_REMOVED = 4003;
/** Closes a host's data sockets once its daily relay allowance is used up. */
export const RELAY_CLOSE_CODE_DAILY_LIMIT = 4004;
/** Refuses new data sockets while the relay-wide daily budget is nearly spent. */
export const RELAY_CLOSE_CODE_RELAY_BUSY = 4005;
/** The host is not reachable (no control socket or its lease lapsed). */
export const RELAY_CLOSE_CODE_HOST_OFFLINE = 4006;

/**
 * RPC heartbeat frames as they cross the relay. The relay answers the ping at
 * the edge (Durable Object auto-response) so idle connections never wake it.
 */
export const RELAY_HEARTBEAT_PING_FRAME = '{"_tag":"Ping"}' as const;
export const RELAY_HEARTBEAT_PONG_FRAME = '{"_tag":"Pong"}' as const;

/** How long a code or QR invite stays usable. */
export const RELAY_INVITE_TTL_SECONDS = 10 * 60;

export const RelayDeviceKind = Schema.Literals(["computer", "phone", "tablet", "browser"]);
export type RelayDeviceKind = typeof RelayDeviceKind.Type;

export const RelayRequestState = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "cancelled",
  "expired",
]);
export type RelayRequestState = typeof RelayRequestState.Type;

/** Who is joining, as the joiner describes itself. Shown to the host, never trusted for access. */
export const RelayJoinerDescription = Schema.Struct({
  label: TrimmedNonEmptyString,
  platform: Schema.optionalKey(TrimmedNonEmptyString),
  kind: RelayDeviceKind,
});
export type RelayJoinerDescription = typeof RelayJoinerDescription.Type;

export const RelayRegisterHostInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  /** The host server's environment id, returned to joiners so they can save the computer before approval. */
  environmentId: TrimmedNonEmptyString,
});
export type RelayRegisterHostInput = typeof RelayRegisterHostInput.Type;

export const RelayRegisterHostResult = Schema.Struct({
  hostId: RelayHostId,
  hostSecret: TrimmedNonEmptyString,
});
export type RelayRegisterHostResult = typeof RelayRegisterHostResult.Type;

/**
 * The host makes the QR invite secret itself and sends only the hash of the
 * claim token derived from it, so the relay can gate claims without ever
 * holding what the claim proof is made with.
 */
export const RelayCreateInviteInput = Schema.Struct({
  hostLabel: TrimmedNonEmptyString,
  claimTokenHash: TrimmedNonEmptyString,
});
export type RelayCreateInviteInput = typeof RelayCreateInviteInput.Type;

export const RelayCreateInviteResult = Schema.Struct({
  inviteId: RelayInviteId,
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type RelayCreateInviteResult = typeof RelayCreateInviteResult.Type;

const RelayJoinSecrets = {
  joinId: TrimmedNonEmptyString,
  deviceSecretHash: TrimmedNonEmptyString,
  requestSecretHash: TrimmedNonEmptyString,
  /** The joiner's static public key for end-to-end encryption (base64url P-256). */
  devicePublicKey: TrimmedNonEmptyString,
};

/**
 * Code join: the only relay route a guess can reach. The joiner commits to its
 * key and a nonce before it sees the host's nonce (see the match number in
 * `@threadlines/shared/relaySecure`).
 */
export const RelayJoinInput = Schema.Struct({
  ...RelayJoinSecrets,
  code: TrimmedNonEmptyString,
  commitment: TrimmedNonEmptyString,
  joiner: RelayJoinerDescription,
});
export type RelayJoinInput = typeof RelayJoinInput.Type;

/**
 * QR / link claim: the relay checks the claim token; the host checks the
 * claim proof (made with a key the relay never sees) before approving.
 */
export const RelayClaimInviteInput = Schema.Struct({
  ...RelayJoinSecrets,
  claimToken: TrimmedNonEmptyString,
  claimProof: TrimmedNonEmptyString,
  joiner: RelayJoinerDescription,
});
export type RelayClaimInviteInput = typeof RelayClaimInviteInput.Type;

export const RelayJoinResult = Schema.Struct({
  hostId: RelayHostId,
  hostEnvironmentId: TrimmedNonEmptyString,
  requestId: RelayRequestId,
  deviceId: RelayDeviceId,
  hostLabel: TrimmedNonEmptyString,
  autoApprove: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export type RelayJoinResult = typeof RelayJoinResult.Type;

export const RelayJoinErrorCode = Schema.Literals([
  "invalid-code",
  "invalid-invite",
  "expired",
  "busy",
  "too-many-devices",
  "rate-limited",
  "relay-unavailable",
]);
export type RelayJoinErrorCode = typeof RelayJoinErrorCode.Type;

export const RelayErrorResponse = Schema.Struct({
  error: TrimmedNonEmptyString,
  code: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayErrorResponse = typeof RelayErrorResponse.Type;

/** The host's half of a code join's match number, as the joiner receives it. */
export const RelayHostNonce = Schema.Struct({
  hostNonce: TrimmedNonEmptyString,
  hostPublicKey: TrimmedNonEmptyString,
});
export type RelayHostNonce = typeof RelayHostNonce.Type;

export const RelayRevealInput = Schema.Struct({
  deviceNonce: TrimmedNonEmptyString,
});
export type RelayRevealInput = typeof RelayRevealInput.Type;

export const RelayRequestStatusResult = Schema.Struct({
  requestId: RelayRequestId,
  state: RelayRequestState,
  deviceId: RelayDeviceId,
  hostNonce: Schema.optionalKey(RelayHostNonce),
});
export type RelayRequestStatusResult = typeof RelayRequestStatusResult.Type;

export const RelayApproveRequestInput = Schema.Struct({
  deviceLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayApproveRequestInput = typeof RelayApproveRequestInput.Type;

export const RelayDecisionResult = Schema.Struct({
  requestId: RelayRequestId,
  deviceId: RelayDeviceId,
  /** The recorded terminal state; may differ from the decision if another came first. */
  state: RelayRequestState,
});
export type RelayDecisionResult = typeof RelayDecisionResult.Type;

export const RelayUsageToday = Schema.Struct({
  messages: Schema.Number,
  awakeSeconds: Schema.Number,
  messageLimit: Schema.Number,
  awakeSecondsLimit: Schema.Number,
  limited: Schema.Boolean,
  resetsAt: IsoDateTime,
});
export type RelayUsageToday = typeof RelayUsageToday.Type;

export const RelayDeviceStatusResult = Schema.Struct({
  hostOnline: Schema.Boolean,
  revoked: Schema.Boolean,
  limited: Schema.Boolean,
  relayBusy: Schema.Boolean,
  resetsAt: Schema.optionalKey(IsoDateTime),
});
export type RelayDeviceStatusResult = typeof RelayDeviceStatusResult.Type;

/**
 * A join as the relay reports it to the host. Everything here came from the
 * joiner through the relay, so the host checks it (commitment, claim proof)
 * and keeps its own copy instead of trusting a later report.
 */
export const RelayJoinRequest = Schema.Struct({
  requestId: RelayRequestId,
  inviteId: RelayInviteId,
  joinId: TrimmedNonEmptyString,
  deviceId: RelayDeviceId,
  devicePublicKey: TrimmedNonEmptyString,
  joiner: RelayJoinerDescription,
  /** Code joins only. */
  commitment: Schema.optionalKey(TrimmedNonEmptyString),
  /** QR claims only. */
  claimProof: Schema.optionalKey(TrimmedNonEmptyString),
  hostNonce: Schema.optionalKey(TrimmedNonEmptyString),
  deviceNonce: Schema.optionalKey(TrimmedNonEmptyString),
  autoApprove: Schema.Boolean,
  state: RelayRequestState,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type RelayJoinRequest = typeof RelayJoinRequest.Type;

export const RelayDeviceRecordState = Schema.Literals(["active", "revoked"]);
export type RelayDeviceRecordState = typeof RelayDeviceRecordState.Type;

export const RelayDeviceRecord = Schema.Struct({
  deviceId: RelayDeviceId,
  state: RelayDeviceRecordState,
});
export type RelayDeviceRecord = typeof RelayDeviceRecord.Type;

/** Relay -> host control events. */
export const RelayControlSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  requests: Schema.Array(RelayJoinRequest),
  devices: Schema.Array(RelayDeviceRecord),
  usage: RelayUsageToday,
});
export const RelayControlJoinRequestedEvent = Schema.Struct({
  type: Schema.Literal("join.requested"),
  request: RelayJoinRequest,
});
export const RelayControlRequestUpdatedEvent = Schema.Struct({
  type: Schema.Literal("request.updated"),
  requestId: RelayRequestId,
  state: RelayRequestState,
});
export const RelayControlRequestRevealedEvent = Schema.Struct({
  type: Schema.Literal("request.revealed"),
  requestId: RelayRequestId,
  deviceNonce: TrimmedNonEmptyString,
});
export const RelayControlDeviceConnectingEvent = Schema.Struct({
  type: Schema.Literal("device.connecting"),
  deviceId: RelayDeviceId,
  pipeId: RelayPipeId,
});
export const RelayControlUsageEvent = Schema.Struct({
  type: Schema.Literal("usage"),
  usage: RelayUsageToday,
});
export const RelayControlEvent = Schema.Union([
  RelayControlSnapshotEvent,
  RelayControlJoinRequestedEvent,
  RelayControlRequestUpdatedEvent,
  RelayControlRequestRevealedEvent,
  RelayControlDeviceConnectingEvent,
  RelayControlUsageEvent,
]);
export type RelayControlEvent = typeof RelayControlEvent.Type;

/** Host -> relay control messages. `lease` keeps the host counted as online. */
export const RelayControlLeaseMessage = Schema.Struct({
  type: Schema.Literal("lease"),
  hostLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export const RelayControlRefusePipeMessage = Schema.Struct({
  type: Schema.Literal("pipe.refuse"),
  pipeId: RelayPipeId,
  reason: Schema.Literals(["not-yet", "revoked"]),
});
export const RelayControlMessage = Schema.Union([
  RelayControlLeaseMessage,
  RelayControlRefusePipeMessage,
]);
export type RelayControlMessage = typeof RelayControlMessage.Type;

/** Joiner watch-socket events. */
export const RelayWatchStateEvent = Schema.Struct({
  type: Schema.Literal("request.state"),
  state: RelayRequestState,
  deviceId: RelayDeviceId,
});
export const RelayWatchHostNonceEvent = Schema.Struct({
  type: Schema.Literal("request.host-nonce"),
  hostNonce: RelayHostNonce,
});
export const RelayWatchEvent = Schema.Union([RelayWatchStateEvent, RelayWatchHostNonceEvent]);
export type RelayWatchEvent = typeof RelayWatchEvent.Type;
