import {
  type RelayCreateInviteInput,
  RelayCreateInviteResult,
  RelayDecisionResult,
  type RelayHostNonce,
  RelayErrorResponse,
  type RelayJoinInput,
  RelayJoinResult,
  RelayRegisterHostResult,
  RelayRequestStatusResult,
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

/** Normalizes a relay URL to its origin (`https://host[:port]`). */
export function relayOriginFrom(url: string): string {
  return new URL(url).origin;
}

function request<A>(input: {
  readonly origin: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly bearer?: string;
  readonly body?: unknown;
  readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
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
