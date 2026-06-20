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
