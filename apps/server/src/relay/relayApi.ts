import {
  type RelayCreateInviteInput,
  RelayCreateInviteResult,
  RelayDecisionResult,
  type RelayDeviceAlertInput,
  RelayDeviceAlertResult,
  RELAY_ERROR_BAD_HOST_SECRET,
  RELAY_ERROR_UNKNOWN_HOST,
  RelayHookDelivery,
  type RelayHookMintInput,
  RelayHookMintResult,
  type RelayHookStateInput,
  RelayHookStateResult,
  RelayHookStatusResult,
  type RelayHostNonce,
  RelayErrorResponse,
  type RelayJoinInput,
  RelayJoinResult,
  RelayRegisterHostResult,
  RelayRequestStatusResult,
  RelayAssistantCodeResult,
  RelayAssistantInfo,
  type RelayAssistantRevokeRequest,
  RelayAssistantRouteTagResult,
} from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The default public relay; `THREADLINES_RELAY_URL` overrides it. */
export const DEFAULT_RELAY_URL = "https://threadlines-relay.threadlines.workers.dev";

export class RelayApiError extends Data.TaggedError("RelayApiError")<{
  /** HTTP status, or null when the relay could not be reached. */
  readonly status: number | null;
  readonly code?: string;
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

const decodeErrorResponse = Schema.decodeUnknownOption(RelayErrorResponse);
const decodeRelayRegisterHostResult = Schema.decodeUnknownEffect(RelayRegisterHostResult);
const decodeRelayCreateInviteResult = Schema.decodeUnknownEffect(RelayCreateInviteResult);
const decodeRelayDecisionResult = Schema.decodeUnknownEffect(RelayDecisionResult);
const decodeRelayJoinResult = Schema.decodeUnknownEffect(RelayJoinResult);
const decodeRelayRequestStatusResult = Schema.decodeUnknownEffect(RelayRequestStatusResult);
const decodeRelayHookMintResult = Schema.decodeUnknownEffect(RelayHookMintResult);
const decodeRelayDeviceAlertResult = Schema.decodeUnknownEffect(RelayDeviceAlertResult);
const decodeRelayHookStateResult = Schema.decodeUnknownEffect(RelayHookStateResult);
const decodeRelayHookStatusResult = Schema.decodeUnknownEffect(RelayHookStatusResult);
const decodeRelayHookDelivery = Schema.decodeUnknownEffect(RelayHookDelivery);
const decodeRelayAssistantInfo = Schema.decodeUnknownEffect(RelayAssistantInfo);
const decodeRelayAssistantCodeResult = Schema.decodeUnknownEffect(RelayAssistantCodeResult);
const decodeRelayAssistantRouteTagResult = Schema.decodeUnknownEffect(RelayAssistantRouteTagResult);

/** A failure that may pass by itself: the relay couldn't be reached, was busy, or failed. */
export function isTransientRelayError(error: RelayApiError): boolean {
  return error.status === null || error.status === 429 || error.status >= 500;
}

/**
 * The relay answered that it no longer knows this computer (its host is gone
 * or the secret doesn't match): not a network error, so registering again is
 * the only way back.
 */
export function isRelayHostGone(error: RelayApiError): boolean {
  return (
    (error.status === 404 && error.code === RELAY_ERROR_UNKNOWN_HOST) ||
    (error.status === 401 && error.code === RELAY_ERROR_BAD_HOST_SECRET)
  );
}

/** Normalizes a relay URL to its origin (`https://host[:port]`). */
export function relayOriginFrom(url: string): string {
  return new URL(url).origin;
}

function request<A>(input: {
  readonly origin: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly bearer?: string;
  readonly body?: unknown;
  readonly decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>;
}): Effect.Effect<A, RelayApiError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(new URL(input.path, input.origin), {
          method: input.method,
          headers: {
            ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          signal: AbortSignal.timeout(15_000),
        }),
      catch: (cause) =>
        new RelayApiError({
          status: null,
          detail: `Couldn't reach the relay: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () =>
        new RelayApiError({ status: response.status, detail: "The relay's answer was cut off." }),
    });
    let json: unknown = null;
    try {
      json = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = decodeErrorResponse(json);
      return yield* new RelayApiError({
        status: response.status,
        ...(parsed._tag === "Some" && parsed.value.code ? { code: parsed.value.code } : {}),
        detail:
          parsed._tag === "Some"
            ? parsed.value.error
            : `The relay answered with HTTP ${response.status}.`,
      });
    }
    return yield* input.decode(json).pipe(
      Effect.mapError(
        () =>
          new RelayApiError({
            status: response.status,
            detail: "The relay sent an unexpected answer.",
          }),
      ),
    );
  });
}

const ignoreBody = () => Effect.void;

export const relayApi = {
  registerHost: (
    origin: string,
    body: { readonly label: string; readonly environmentId: string },
  ) =>
    request({
      origin,
      method: "POST",
      path: "/v2/hosts",
      body,
      decode: (value) => decodeRelayRegisterHostResult(value),
    }),

  createInvite: (
    origin: string,
    hostId: string,
    hostSecret: string,
    body: RelayCreateInviteInput,
  ) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/invites`,
      bearer: hostSecret,
      body,
      decode: (value) => decodeRelayCreateInviteResult(value),
    }),

  /** Sends this server's half of a code join's match number. */
  setHostNonce: (
    origin: string,
    hostId: string,
    hostSecret: string,
    requestId: string,
    body: RelayHostNonce,
  ) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/requests/${requestId}/host-nonce`,
      bearer: hostSecret,
      body,
      decode: (value) => decodeRelayRequestStatusResult(value),
    }),

  cancelInvite: (origin: string, hostId: string, hostSecret: string, inviteId: string) =>
    request({
      origin,
      method: "DELETE",
      path: `/v2/hosts/${hostId}/invites/${inviteId}`,
      bearer: hostSecret,
      decode: ignoreBody,
    }),

  decide: (
    origin: string,
    hostId: string,
    hostSecret: string,
    requestId: string,
    decision: "approve" | "deny",
    deviceLabel?: string,
  ) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/requests/${requestId}/${decision}`,
      bearer: hostSecret,
      body: deviceLabel ? { deviceLabel } : {},
      decode: (value) => decodeRelayDecisionResult(value),
    }),

  revokeDevice: (origin: string, hostId: string, hostSecret: string, deviceId: string) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/devices/${deviceId}/revoke`,
      bearer: hostSecret,
      decode: ignoreBody,
    }),

  /** Asks the relay to send an alert sealed for one of this computer's paired devices. */
  sendDeviceAlert: (
    origin: string,
    hostId: string,
    hostSecret: string,
    deviceId: string,
    body: RelayDeviceAlertInput,
  ) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/devices/${encodeURIComponent(deviceId)}/alert`,
      bearer: hostSecret,
      body,
      decode: (value) => decodeRelayDeviceAlertResult(value),
    }),

  /** Mints an event task hook; its full public address comes back. */
  mintHook: (origin: string, hostId: string, hostSecret: string, body: RelayHookMintInput) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/hooks`,
      bearer: hostSecret,
      body,
      decode: (value) => decodeRelayHookMintResult(value),
    }),

  /** Sends the whole wanted hook state; applied only if its revision is newer. */
  setHooks: (origin: string, hostId: string, hostSecret: string, body: RelayHookStateInput) =>
    request({
      origin,
      method: "PUT",
      path: `/v2/hosts/${hostId}/hooks`,
      bearer: hostSecret,
      body,
      decode: (value) => decodeRelayHookStateResult(value),
    }),

  /** The relay's last applied hook revision; also tells whether it still knows this computer. */
  hookStatus: (origin: string, hostId: string, hostSecret: string) =>
    request({
      origin,
      method: "GET",
      path: `/v2/hosts/${hostId}/hooks`,
      bearer: hostSecret,
      decode: (value) => decodeRelayHookStatusResult(value),
    }),

  /** A delivery announced as too large for the control socket. */
  hookDelivery: (origin: string, hostId: string, hostSecret: string, deliveryId: string) =>
    request({
      origin,
      method: "GET",
      path: `/v2/hosts/${hostId}/hooks/deliveries/${encodeURIComponent(deliveryId)}`,
      bearer: hostSecret,
      decode: (value) => decodeRelayHookDelivery(value),
    }),

  /** The assistants door (docs/design/assistants.md): its public address, and whether it is on. */
  /** The same answer without a host: the door's address is the same for every computer. */
  publicAssistantInfo: (origin: string) =>
    request({
      origin,
      method: "GET",
      path: "/v2/assistants",
      decode: (value) => decodeRelayAssistantInfo(value),
    }),

  assistantInfo: (origin: string, hostId: string, hostSecret: string) =>
    request({
      origin,
      method: "GET",
      path: `/v2/hosts/${hostId}/assistants`,
      bearer: hostSecret,
      decode: (value) => decodeRelayAssistantInfo(value),
    }),

  /** A new sign-in code for an assistant's page; replaces this computer's last one. */
  createAssistantCode: (origin: string, hostId: string, hostSecret: string) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/assistants/code`,
      bearer: hostSecret,
      body: {},
      decode: (value) => decodeRelayAssistantCodeResult(value),
    }),

  /** Forgets this computer's sign-in code. */
  cancelAssistantCode: (origin: string, hostId: string, hostSecret: string) =>
    request({
      origin,
      method: "DELETE",
      path: `/v2/hosts/${hostId}/assistants/code`,
      bearer: hostSecret,
      decode: ignoreBody,
    }),

  /** The route tag every credential of a new assistant connection carries. */
  assistantRouteTag: (origin: string, hostId: string, hostSecret: string, connectionId: string) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/assistants/route-tags`,
      bearer: hostSecret,
      body: { connectionId },
      decode: (value) => decodeRelayAssistantRouteTagResult(value),
    }),

  /** Removed assistant connections: the relay refuses them from now on, even while this computer sleeps. */
  revokeAssistants: (
    origin: string,
    hostId: string,
    hostSecret: string,
    body: RelayAssistantRevokeRequest,
  ) =>
    request({
      origin,
      method: "POST",
      path: `/v2/hosts/${hostId}/assistants/revocations`,
      bearer: hostSecret,
      body,
      decode: ignoreBody,
    }),

  join: (origin: string, body: RelayJoinInput) =>
    request({
      origin,
      method: "POST",
      path: "/v2/join",
      body,
      decode: (value) => decodeRelayJoinResult(value),
    }),
};

export function relaySocketUrl(origin: string, path: string): string {
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
