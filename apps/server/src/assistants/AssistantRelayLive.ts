/**
 * AssistantRelay over this computer's relay registration (RelayHostLink) and
 * the relay's host-secret routes (relayApi.ts), with the same base URL and
 * timeouts as the rest of `relay/`.
 *
 * The assistant socket authenticates as the control socket and device pipes
 * do: the host secret as a `threadlines-token.` subprotocol. It sends the
 * relay's heartbeat ping every 20 s; once a pong has come back on a socket,
 * 45 s with no frame at all closes it and connects again. A socket refused
 * before it opened asks the relay (at most once a minute) whether it still
 * knows this computer, so a forgotten host registers again on the next call
 * that needs one.
 *
 * Frames are never logged: a request frame carries a credential.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { Buffer } from "node:buffer";

import {
  RELAY_ASSISTANT_FRAME_MAX_BYTES,
  RELAY_HEARTBEAT_PING_FRAME,
  RELAY_HEARTBEAT_PONG_FRAME,
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_WEBSOCKET_PROTOCOL,
  RelayAssistantRelayFrame,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  isRelayHostGone,
  isTransientRelayError,
  type RelayApiError,
  relayApi,
  relaySocketUrl,
} from "../relay/relayApi.ts";
import { type RelayHostCredentials, RelayHostLink } from "../relay/RelayHostLink.ts";
import {
  AssistantRelay,
  AssistantRelayError,
  type AssistantRelayEvent,
  type AssistantRelayShape,
} from "./AssistantRelay.ts";

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const PING_INTERVAL_MS = 20_000;
const SILENCE_TIMEOUT_MS = 45_000;
const HOST_CHECK_INTERVAL_MS = 60_000;
const ONLINE_REASON = "assistants";

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(RelayAssistantRelayFrame));

const relayOff = new AssistantRelayError({
  reason: "off",
  detail: "Assistants are off: this computer's relay is turned off.",
});

/** A relay error as the door reports it. */
const fromApiError = (error: RelayApiError): AssistantRelayError => {
  if (isTransientRelayError(error)) {
    return new AssistantRelayError({
      reason: "unreachable",
      detail:
        "Threadlines couldn't reach the relay. Check this computer's connection and try again.",
    });
  }
  if ((error.status === 404 && error.code === undefined) || error.code === "assistants-off") {
    return new AssistantRelayError({
      reason: "off",
      detail: "The relay isn't taking assistants right now.",
    });
  }
  return new AssistantRelayError({ reason: "refused", detail: error.detail });
};

export const makeAssistantRelay = Effect.gen(function* () {
  const link = yield* RelayHostLink;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const origin = link.relayOrigin;
  const events = yield* Queue.unbounded<AssistantRelayEvent>();

  let wanted = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lastHostCheckAt = 0;

  /** Runs a call with this computer's credentials; a host the relay forgot is dropped. */
  const withHost = <A>(
    register: boolean,
    call: (origin: string, creds: RelayHostCredentials) => Effect.Effect<A, RelayApiError>,
  ): Effect.Effect<A | null, AssistantRelayError> =>
    Effect.gen(function* () {
      if (origin === null) return yield* relayOff;
      const stored = yield* link.credentials;
      const creds =
        stored ??
        (register
          ? yield* link.register.pipe(
              Effect.mapError(
                (error) =>
                  new AssistantRelayError({
                    reason: error.transient ? "unreachable" : "refused",
                    detail: error.detail,
                  }),
              ),
            )
          : null);
      if (creds === null) return null;
      return yield* call(origin, creds).pipe(
        Effect.catchIf(isRelayHostGone, (error) =>
          link.forgetHost(creds.hostId).pipe(Effect.andThen(Effect.fail(error))),
        ),
        Effect.mapError(fromApiError),
      );
    });

  /** withHost for calls that always register first. */
  const registered = <A>(
    call: (origin: string, creds: RelayHostCredentials) => Effect.Effect<A, RelayApiError>,
  ): Effect.Effect<A, AssistantRelayError> =>
    withHost(true, call).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(
              new AssistantRelayError({
                reason: "unreachable",
                detail: "This computer isn't registered with the relay yet.",
              }),
            )
          : Effect.succeed(value),
      ),
    );

  // ----- the socket ------------------------------------------------------------

  const clearTimers = () => {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
  };

  const closeSocket = (reason: string) => {
    clearTimers();
    const current = socket;
    socket = null;
    if (current !== null && current.readyState <= WebSocket.OPEN) {
      try {
        current.close(1000, reason);
      } catch {
        // Already closing.
      }
    }
  };

  const scheduleReconnect = () => {
    if (!wanted || reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      runFork(connect);
    }, delay);
  };

  /** Refused before it opened: does the relay still know this computer? (`info` forgets it if not.) */
  const checkHost = Effect.suspend(() => {
    const now = Date.now();
    if (now - lastHostCheckAt < HOST_CHECK_INTERVAL_MS) return Effect.void;
    lastHostCheckAt = now;
    return withHost(false, (relay, creds) =>
      relayApi.assistantInfo(relay, creds.hostId, creds.hostSecret),
    ).pipe(Effect.ignore);
  });

  const connect: Effect.Effect<void> = Effect.gen(function* () {
    if (!wanted || socket !== null || origin === null) return;
    const creds = yield* link.credentials;
    if (creds === null) {
      // Not registered (again) yet: look again, as a reconnect would.
      scheduleReconnect();
      return;
    }
    const opened = new WebSocket(
      relaySocketUrl(origin, `/v2/hosts/${creds.hostId}/assistants/socket`),
      [RELAY_WEBSOCKET_PROTOCOL, `${RELAY_TOKEN_PROTOCOL_PREFIX}${creds.hostSecret}`],
    );
    socket = opened;
    let isOpen = false;
    let lastFrameAt = Date.now();
    let pongSeen = false;

    opened.addEventListener("open", () => {
      if (socket !== opened) return;
      isOpen = true;
      attempt = 0;
      lastFrameAt = Date.now();
      Queue.offerUnsafe(events, { type: "open" });
      pingTimer = setInterval(() => {
        if (socket !== opened) return;
        if (pongSeen && Date.now() - lastFrameAt > SILENCE_TIMEOUT_MS) {
          // The network went quiet without a close: start over.
          onGone();
          return;
        }
        if (opened.readyState === WebSocket.OPEN) opened.send(RELAY_HEARTBEAT_PING_FRAME);
      }, PING_INTERVAL_MS);
    });
    opened.addEventListener("message", (event: MessageEvent) => {
      if (socket !== opened || typeof event.data !== "string") return;
      lastFrameAt = Date.now();
      if (event.data === RELAY_HEARTBEAT_PONG_FRAME) {
        pongSeen = true;
        return;
      }
      if (Buffer.byteLength(event.data, "utf8") > RELAY_ASSISTANT_FRAME_MAX_BYTES) return;
      const frame = decodeFrame(event.data);
      if (Option.isSome(frame)) Queue.offerUnsafe(events, { type: "frame", frame: frame.value });
    });
    const onGone = () => {
      if (socket !== opened) return;
      closeSocket("Reconnecting.");
      if (isOpen) Queue.offerUnsafe(events, { type: "closed" });
      else runFork(checkHost);
      scheduleReconnect();
    };
    opened.addEventListener("close", onGone);
    opened.addEventListener("error", onGone);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("assistants.socket.connect-failed", { cause }).pipe(
        Effect.andThen(Effect.sync(scheduleReconnect)),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      wanted = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      closeSocket("Server stopping.");
    }),
  );

  const setWanted: AssistantRelayShape["setWanted"] = (next) =>
    Effect.gen(function* () {
      if (origin === null || next === wanted) return;
      wanted = next;
      yield* link.keepOnline(ONLINE_REASON, next);
      if (next) {
        attempt = 0;
        yield* connect;
        return;
      }
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket !== null) {
        closeSocket("Nothing for the assistant socket to do.");
        Queue.offerUnsafe(events, { type: "closed" });
      }
    });

  const send: AssistantRelayShape["send"] = (frame) =>
    Effect.sync(() => {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
      const text = JSON.stringify(frame);
      if (Buffer.byteLength(text, "utf8") > RELAY_ASSISTANT_FRAME_MAX_BYTES) return false;
      socket.send(text);
      return true;
    });

  return AssistantRelay.of({
    available: origin !== null,
    hostId: link.credentials.pipe(Effect.map((creds) => creds?.hostId ?? null)),
    info: ({ register }) =>
      withHost(register, (relay, creds) =>
        relayApi.assistantInfo(relay, creds.hostId, creds.hostSecret),
      ),
    createCode: registered((relay, creds) =>
      relayApi.createAssistantCode(relay, creds.hostId, creds.hostSecret),
    ),
    cancelCode: withHost(false, (relay, creds) =>
      relayApi.cancelAssistantCode(relay, creds.hostId, creds.hostSecret),
    ).pipe(Effect.asVoid),
    routeTag: (connectionId) =>
      registered((relay, creds) =>
        relayApi
          .assistantRouteTag(relay, creds.hostId, creds.hostSecret, connectionId)
          .pipe(Effect.map(({ routeTag }) => ({ hostId: creds.hostId, routeTag }))),
      ),
    revoke: ({ hostId, connectionIds }) =>
      withHost(false, (relay, creds) =>
        creds.hostId !== hostId
          ? Effect.void
          : relayApi.revokeAssistants(relay, creds.hostId, creds.hostSecret, {
              connectionIds: [...connectionIds],
            }),
      ).pipe(Effect.asVoid),
    setWanted,
    events: Stream.fromQueue(events),
    send,
  });
});

/** AssistantRelay over RelayHostLink (from RelayHostLive). */
export const AssistantRelayLive = Layer.effect(AssistantRelay, makeAssistantRelay);
