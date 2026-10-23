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

/**
 * Event tasks' public addresses on the relay (docs/design/event-tasks.md).
 * The relay mints a hook for a host (`POST /v2/hosts/{h}/hooks`); its
 * address is `/v2/hooks/{hostId}/{hookId}/{mac}`, the mac checked at the edge
 * before any Durable Object is touched. A delivery is sealed to the host's
 * hook key at once, held until the host acknowledges it (24 hours at most),
 * and handed over on the control socket: whole when small (`hook.delivery`),
 * announced and fetched over HTTP when large (`hook.pending`).
 */
export const RelayHookId = TrimmedNonEmptyString.pipe(Schema.brand("RelayHookId"));
export type RelayHookId = typeof RelayHookId.Type;
export const RelayHookDeliveryId = TrimmedNonEmptyString.pipe(Schema.brand("RelayHookDeliveryId"));
export type RelayHookDeliveryId = typeof RelayHookDeliveryId.Type;

/** A body larger than this is refused (413). */
export const RELAY_HOOK_MAX_BODY_BYTES = 1024 * 1024;
/** Sealed deliveries up to this size travel on the control socket; larger ones are fetched. */
export const RELAY_HOOK_INLINE_SEALED_BYTES = 600 * 1024;
/** How long an unacknowledged delivery waits at the relay. */
export const RELAY_HOOK_HOLD_MS = 24 * 60 * 60 * 1000;

/** Header names a hook keeps besides the ones every hook keeps (lowercase). */
export const RelayHookKeptHeaders = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
).check(Schema.isMaxLength(32));
export type RelayHookKeptHeaders = typeof RelayHookKeptHeaders.Type;

/**
 * The host's key for hook deliveries: a P-256 public key, raw uncompressed
 * point, base64url. Deliveries are sealed to it (packages/shared
 * relayHookSeal.ts).
 */
export const RelayHookPublicKey = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/**
 * Every hook change carries the host's revision; the relay applies one only
 * if it is newer than the last it applied, so a late or reordered call can't
 * undo a newer one.
 */
export const RelayHookMintInput = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  publicKey: RelayHookPublicKey,
  keptHeaders: RelayHookKeptHeaders,
});
export type RelayHookMintInput = typeof RelayHookMintInput.Type;

export const RelayHookMintResult = Schema.Struct({
  hookId: RelayHookId,
  /** The full public address, mac included. */
  url: TrimmedNonEmptyString,
});
export type RelayHookMintResult = typeof RelayHookMintResult.Type;

/**
 * The host's whole wanted state: these hooks active with these kept headers,
 * every other hook of the host retired. Sent after every change and on every
 * reconnect.
 */
export const RelayHookStateInput = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  publicKey: RelayHookPublicKey,
  active: Schema.Array(Schema.Struct({ hookId: RelayHookId, keptHeaders: RelayHookKeptHeaders })),
});
export type RelayHookStateInput = typeof RelayHookStateInput.Type;

export const RelayHookStateResult = Schema.Struct({
  /** False when the relay had already applied a newer revision. */
  applied: Schema.Boolean,
  revision: Schema.Int,
});
export type RelayHookStateResult = typeof RelayHookStateResult.Type;

/**
 * `GET /v2/hosts/{h}/hooks`: the last revision the relay applied. The host
 * asks after its control socket was refused, to tell a relay that forgot it
 * (`unknown-host`, `bad-host-secret`) from one it can't reach.
 */
export const RelayHookStatusResult = Schema.Struct({
  revision: Schema.Int,
});
export type RelayHookStatusResult = typeof RelayHookStatusResult.Type;

/**
 * Error codes on host-secret routes. `unknown-host` and `bad-host-secret`
 * mean the relay no longer knows this computer: register again.
 */
export const RELAY_ERROR_UNKNOWN_HOST = "unknown-host" as const;
export const RELAY_ERROR_BAD_HOST_SECRET = "bad-host-secret" as const;
/** A hook call whose revision the relay has already passed. */
export const RELAY_ERROR_STALE_REVISION = "stale-revision" as const;
/** The relay has no hook path key, so it doesn't take events. */
export const RELAY_ERROR_HOOKS_OFF = "hooks-off" as const;
/** The host has as many hooks as the relay keeps for one computer. */
export const RELAY_ERROR_TOO_MANY_HOOKS = "too-many-hooks" as const;

/** One delivery as the relay holds it; `sealed` is relayHookSeal's envelope. */
export const RelayHookDelivery = Schema.Struct({
  deliveryId: RelayHookDeliveryId,
  hookId: RelayHookId,
  receivedAt: IsoDateTime,
  sealed: TrimmedNonEmptyString,
});
export type RelayHookDelivery = typeof RelayHookDelivery.Type;

// ----- Push alerts ------------------------------------------------------------
//
// A phone's alerts (docs/design/push-alerts.md). The phone registers its push
// subscription's endpoint with each computer's relay host itself (device
// secret), so a computer never learns it; the computer gets only the keys it
// seals alerts with, over the end-to-end channel, and asks the relay to send.

/** The alerts a phone can switch on or off. */
export const PushAlertKind = Schema.Literals(["needs_you", "finished", "failed"]);
export type PushAlertKind = typeof PushAlertKind.Type;

/** Which alerts a phone wants. Each computer's relay host keeps them and enforces them. */
export const PushAlertKinds = Schema.Struct({
  needs_you: Schema.Boolean,
  finished: Schema.Boolean,
  failed: Schema.Boolean,
});
export type PushAlertKinds = typeof PushAlertKinds.Type;

const Base64UrlText = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/**
 * Names one push subscription: a hash of its endpoint, its keys and the VAPID
 * key it was made with. Registering the same subscription again keeps it;
 * a new subscription is a new generation. Every alert names the generation it
 * was sealed for, so one sealed for a replaced subscription is refused.
 */
export const PushRegistrationId = Base64UrlText.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(64),
);
export type PushRegistrationId = typeof PushRegistrationId.Type;

/** Names one of the relay's VAPID keys. */
export const PushVapidKeyId = Base64UrlText.check(Schema.isMaxLength(32));
export type PushVapidKeyId = typeof PushVapidKeyId.Type;

/** `GET /v2/push/key?channel=<stable|nightly>`: the key a phone subscribes with. */
export const RelayPushKeyResult = Schema.Struct({
  keyId: PushVapidKeyId,
  /** Uncompressed P-256 point, base64url (the `applicationServerKey`). */
  publicKey: Base64UrlText.check(Schema.isMaxLength(100)),
});
export type RelayPushKeyResult = typeof RelayPushKeyResult.Type;

/** `PUT /v2/hosts/{h}/devices/{d}/push`, with the device's secret. */
export const RelayDevicePushInput = Schema.Struct({
  registrationId: PushRegistrationId,
  endpoint: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  keyId: PushVapidKeyId,
  kinds: PushAlertKinds,
  /**
   * Rises with every change the phone makes (a PUT or a DELETE): the relay
   * ignores one older than the last it took, so a late request can't undo a
   * newer switch.
   */
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type RelayDevicePushInput = typeof RelayDevicePushInput.Type;

/** `DELETE /v2/hosts/{h}/devices/{d}/push`, with the device's secret. */
export const RelayDevicePushRemoveInput = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type RelayDevicePushRemoveInput = typeof RelayDevicePushRemoveInput.Type;

/** What a send may be: one of the three alerts, or the test alert from Settings. */
export const RelayAlertKind = Schema.Literals(["needs_you", "finished", "failed", "test"]);
export type RelayAlertKind = typeof RelayAlertKind.Type;

/** Most bytes a push service takes in one message (RFC 8030); base64url makes it 5462 characters. */
export const RELAY_PUSH_MAX_PAYLOAD_BYTES = 4096;
/** Alerts are worth little late: an hour at most. */
export const RELAY_PUSH_MAX_TTL_SECONDS = 60 * 60;

/** `POST /v2/hosts/{h}/devices/{d}/alert`, with the host's secret. */
export const RelayDeviceAlertInput = Schema.Struct({
  registrationId: PushRegistrationId,
  kind: RelayAlertKind,
  /** The RFC 8291 aes128gcm body, sealed for the phone, base64url. */
  payload: Base64UrlText.check(Schema.isMaxLength(5462)),
  ttlSeconds: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: RELAY_PUSH_MAX_TTL_SECONDS }),
  ),
  urgency: Schema.Literals(["very-low", "low", "normal", "high"]),
  /** Replaces an undelivered alert with the same topic (RFC 8030 §5.4). */
  topic: Schema.optional(Base64UrlText.check(Schema.isMaxLength(32))),
  /**
   * Names the alert (an opaque hash), so a retry of one the relay already
   * sent (its answer lost on the way back) is answered `sent` and not sent
   * again. The test alert has none.
   */
  alertKey: Schema.optional(Base64UrlText.check(Schema.isMaxLength(43))),
});
export type RelayDeviceAlertInput = typeof RelayDeviceAlertInput.Type;

/**
 * What became of one alert. `sent`: the push service took it (not proof the
 * phone showed it). `muted`: the phone switched that alert off. `stale`: the
 * phone has a newer subscription than the one this was sealed for. `gone`:
 * the subscription ended (the relay forgot it). `limited`: an allowance is
 * spent. `retry`: try again later. `rejected`: the push service refused this
 * message; resending it won't help. `unavailable`: no subscription, or the
 * relay doesn't send alerts.
 */
export const RelayDeviceAlertOutcome = Schema.Literals([
  "sent",
  "muted",
  "stale",
  "gone",
  "limited",
  "retry",
  "rejected",
  "unavailable",
]);
export type RelayDeviceAlertOutcome = typeof RelayDeviceAlertOutcome.Type;

export const RelayDeviceAlertResult = Schema.Struct({
  outcome: RelayDeviceAlertOutcome,
  retryAfterSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type RelayDeviceAlertResult = typeof RelayDeviceAlertResult.Type;

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
  /** Event task deliveries accepted today, and the daily cap ("Events today"). Newer relays only. */
  hooks: Schema.optionalKey(Schema.Number),
  hookLimit: Schema.optionalKey(Schema.Number),
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
/** A sealed hook delivery small enough to travel on the control socket. */
export const RelayControlHookDeliveryEvent = Schema.Struct({
  type: Schema.Literal("hook.delivery"),
  delivery: RelayHookDelivery,
});
/** A delivery too large for the socket: fetch it (`GET .../hooks/deliveries/{id}`). */
export const RelayControlHookPendingEvent = Schema.Struct({
  type: Schema.Literal("hook.pending"),
  deliveryId: RelayHookDeliveryId,
  hookId: RelayHookId,
  receivedAt: IsoDateTime,
  size: Schema.Int,
});
export const RelayControlEvent = Schema.Union([
  RelayControlSnapshotEvent,
  RelayControlJoinRequestedEvent,
  RelayControlRequestUpdatedEvent,
  RelayControlRequestRevealedEvent,
  RelayControlDeviceConnectingEvent,
  RelayControlUsageEvent,
  RelayControlHookDeliveryEvent,
  RelayControlHookPendingEvent,
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
/** The host has stored these deliveries; the relay forgets them. */
export const RelayControlHookAckMessage = Schema.Struct({
  type: Schema.Literal("hook.ack"),
  deliveryIds: Schema.Array(RelayHookDeliveryId).check(Schema.isMaxLength(100)),
});
export const RelayControlMessage = Schema.Union([
  RelayControlLeaseMessage,
  RelayControlRefusePipeMessage,
  RelayControlHookAckMessage,
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
