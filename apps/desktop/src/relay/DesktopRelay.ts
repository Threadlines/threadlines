import {
  AuthBearerBootstrapResult,
  AuthWebSocketTokenResult,
  type DesktopRelayPairingSession,
} from "@threadlines/contracts";
import {
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_WEBSOCKET_PROTOCOL,
  RelayCreateSessionResult,
} from "@threadlines/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

export interface DesktopRelayShape {
  readonly getPairingSession: Effect.Effect<DesktopRelayPairingSession | null>;
  readonly createPairingSession: Effect.Effect<DesktopRelayPairingSession, DesktopRelayError>;
  readonly disconnectPairingSession: Effect.Effect<void>;
}

export class DesktopRelay extends Context.Service<DesktopRelay, DesktopRelayShape>()(
  "t3/desktop/Relay",
) {}

interface ActiveRelayBridge {
  session: DesktopRelayPairingSession;
  relayDesktopSocketUrl: string;
  relayDesktopToken: string;
  bridge: RelayBridgeHandle;
  intentionalClose: boolean;
  reconnectInFlight: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  status: DesktopRelayPairingSessionStatus;
  lastError: string | null;
}

interface RelayBridgeHandle {
  readonly close: () => void;
  readonly isClosed: () => boolean;
}

type DesktopRelayOperation =
  | "create-relay-session"
  | "bootstrap-bearer-session"
  | "issue-websocket-token"
  | "open-relay-bridge";

export class DesktopRelayError extends Data.TaggedError("DesktopRelayError")<{
  readonly operation: DesktopRelayOperation;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.reason;
  }
}

const BootstrapBearerRequestBody = Schema.Struct({
  credential: Schema.String,
});
const EmptyJsonRequestBody = Schema.Struct({});

const decodeRelayCreateSessionResult = Schema.decodeUnknownEffect(RelayCreateSessionResult);
const decodeAuthBearerBootstrapResult = Schema.decodeUnknownEffect(AuthBearerBootstrapResult);
const decodeAuthWebSocketTokenResult = Schema.decodeUnknownEffect(AuthWebSocketTokenResult);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeBootstrapBearerRequestBody = Schema.encodeEffect(
  Schema.fromJsonString(BootstrapBearerRequestBody),
);
const encodeEmptyJsonRequestBody = Schema.encodeEffect(Schema.fromJsonString(EmptyJsonRequestBody));

const { logInfo: logRelayInfo, logWarning: logRelayWarning } =
  DesktopObservability.makeComponentLogger("desktop-relay");

type DesktopRelayPairingSessionStatus = NonNullable<DesktopRelayPairingSession["status"]>;

const RELAY_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000] as const;

function relayError(
  operation: DesktopRelayOperation,
  reason: string,
  cause?: unknown,
): DesktopRelayError {
  return new DesktopRelayError({ operation, reason, cause });
}

function mapRelayDecodeError(operation: DesktopRelayOperation, reason: string) {
  return (cause: DesktopRelayError | Schema.SchemaError): DesktopRelayError =>
    cause instanceof DesktopRelayError ? cause : relayError(operation, reason, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseHttpErrorMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as { readonly error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  } catch {
    // Fall back to the raw response body below.
  }

  return trimmed;
}

function isInvalidBootstrapCredentialMessage(message: string): boolean {
  return (
    message === "Invalid bootstrap credential." ||
    message === "Unknown bootstrap credential." ||
    message === "Bootstrap credential expired."
  );
}

function isSessionExpired(session: DesktopRelayPairingSession, nowMs = Date.now()): boolean {
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function nextReconnectDelayMs(attempt: number): number {
  const index = Math.min(Math.max(0, attempt), RELAY_RECONNECT_DELAYS_MS.length - 1);
  return RELAY_RECONNECT_DELAYS_MS[index] ?? 30_000;
}

function createClosedBridgeHandle(): RelayBridgeHandle {
  return {
    close: () => {},
    isClosed: () => true,
  };
}

function toPairingSession(active: ActiveRelayBridge): DesktopRelayPairingSession {
  return {
    ...active.session,
    status: active.status,
  };
}

function mapDesktopBridgeBootstrapError(cause: DesktopRelayError | Schema.SchemaError) {
  if (cause instanceof DesktopRelayError && isInvalidBootstrapCredentialMessage(cause.reason)) {
    return relayError(
      "bootstrap-bearer-session",
      "Desktop bridge sign-in was rejected. Quit and reopen Threadlines, then create a new phone link.",
      cause,
    );
  }

  return mapRelayDecodeError(
    "bootstrap-bearer-session",
    "Desktop backend returned an invalid sign-in session.",
  )(cause);
}

function withPath(baseUrl: URL, pathname: string): URL {
  const url = new URL(baseUrl.href);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

function withRawRelayMode(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set("mode", "raw");
  return url.toString();
}

function toWebSocketUrl(httpBaseUrl: URL, wsToken: string): string {
  const url = withPath(httpBaseUrl, "/ws");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsToken", wsToken);
  return url.toString();
}

function readJsonResponse(
  operation: DesktopRelayOperation,
  url: URL,
  init?: RequestInit,
): Effect.Effect<unknown, DesktopRelayError> {
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, init);
        const responseText = await response.text();
        if (!response.ok) {
          throw relayError(
            operation,
            parseHttpErrorMessage(responseText) || `Request failed with HTTP ${response.status}.`,
          );
        }
        return responseText;
      },
      catch: (cause) =>
        cause instanceof DesktopRelayError
          ? cause
          : relayError(operation, "Relay HTTP request failed.", cause),
    });
    if (text.trim().length === 0) {
      return null;
    }
    return yield* decodeUnknownJsonString(text).pipe(
      Effect.mapError((cause) =>
        relayError(operation, "Relay response was not valid JSON.", cause),
      ),
    );
  });
}

function waitForSocketOpen(socket: WebSocket, label: string): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(relayError("open-relay-bridge", `${label} WebSocket failed to open.`));
    };
    const handleClose = (event: CloseEvent) => {
      cleanup();
      reject(
        relayError(
          "open-relay-bridge",
          `${label} WebSocket closed before opening (${event.code}).`,
        ),
      );
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
  });
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    return;
  }
  socket.close(1000, "Threadlines relay bridge closed.");
}

function forwardSocketMessages(source: WebSocket, target: WebSocket): () => void {
  const onMessage = (event: MessageEvent) => {
    if (target.readyState !== WebSocket.OPEN) {
      return;
    }
    target.send(event.data);
  };
  source.addEventListener("message", onMessage);
  return () => source.removeEventListener("message", onMessage);
}

function bindCloseTogether(left: WebSocket, right: WebSocket): () => void {
  const closeRight = () => closeSocket(right);
  const closeLeft = () => closeSocket(left);
  left.addEventListener("close", closeRight);
  left.addEventListener("error", closeRight);
  right.addEventListener("close", closeLeft);
  right.addEventListener("error", closeLeft);
  return () => {
    left.removeEventListener("close", closeRight);
    left.removeEventListener("error", closeRight);
    right.removeEventListener("close", closeLeft);
    right.removeEventListener("error", closeLeft);
  };
}

const createLocalWebSocketUrl = Effect.fn("desktop.relay.createLocalWebSocketUrl")(function* (
  config: DesktopBackendManager.DesktopBackendStartConfig,
) {
  const bootstrapToken = config.bootstrap.desktopBootstrapToken;
  if (!bootstrapToken) {
    return yield* relayError(
      "bootstrap-bearer-session",
      "Desktop backend bootstrap token is unavailable.",
    );
  }

  const bootstrapRequestBody = yield* encodeBootstrapBearerRequestBody({
    credential: bootstrapToken,
  }).pipe(
    Effect.mapError((cause) =>
      relayError("bootstrap-bearer-session", "Could not prepare desktop sign-in request.", cause),
    ),
  );

  const bearerSession = yield* readJsonResponse(
    "bootstrap-bearer-session",
    withPath(config.httpBaseUrl, "/api/auth/bootstrap/bearer"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bootstrapRequestBody,
    },
  ).pipe(
    Effect.flatMap(decodeAuthBearerBootstrapResult),
    Effect.mapError(mapDesktopBridgeBootstrapError),
  );

  const wsToken = yield* readJsonResponse(
    "issue-websocket-token",
    withPath(config.httpBaseUrl, "/api/auth/ws-token"),
    {
      method: "POST",
      headers: { authorization: `Bearer ${bearerSession.sessionToken}` },
    },
  ).pipe(
    Effect.flatMap(decodeAuthWebSocketTokenResult),
    Effect.mapError(
      mapRelayDecodeError(
        "issue-websocket-token",
        "Desktop backend returned an invalid phone token.",
      ),
    ),
  );

  return toWebSocketUrl(config.httpBaseUrl, wsToken.token);
});

const createRelaySession = Effect.fn("desktop.relay.createRelaySession")(function* (relayUrl: URL) {
  const requestBody = yield* encodeEmptyJsonRequestBody({}).pipe(
    Effect.mapError((cause) =>
      relayError("create-relay-session", "Could not prepare relay session request.", cause),
    ),
  );
  return yield* readJsonResponse("create-relay-session", withPath(relayUrl, "/v1/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  }).pipe(
    Effect.flatMap(decodeRelayCreateSessionResult),
    Effect.mapError(
      mapRelayDecodeError("create-relay-session", "Relay returned an invalid pairing session."),
    ),
  );
});

function openBridge(input: {
  readonly localSocketUrl: string;
  readonly relayDesktopSocketUrl: string;
  readonly relayDesktopToken: string;
  readonly onClosed?: () => void;
}): Effect.Effect<RelayBridgeHandle, DesktopRelayError> {
  return Effect.tryPromise({
    try: async () => {
      const relaySocket = new WebSocket(withRawRelayMode(input.relayDesktopSocketUrl), [
        RELAY_WEBSOCKET_PROTOCOL,
        `${RELAY_TOKEN_PROTOCOL_PREFIX}${input.relayDesktopToken}`,
      ]);
      const localSocket = new WebSocket(input.localSocketUrl);

      try {
        await Promise.all([
          waitForSocketOpen(relaySocket, "Relay"),
          waitForSocketOpen(localSocket, "Local backend"),
        ]);
      } catch (error) {
        closeSocket(relaySocket);
        closeSocket(localSocket);
        throw error instanceof DesktopRelayError
          ? error
          : relayError("open-relay-bridge", errorMessage(error), error);
      }

      const cleanupRelayForward = forwardSocketMessages(relaySocket, localSocket);
      const cleanupLocalForward = forwardSocketMessages(localSocket, relaySocket);
      const cleanupCloseBinding = bindCloseTogether(relaySocket, localSocket);
      let closed = false;
      let closeNotified = false;
      const markClosed = () => {
        closed = true;
        if (closeNotified) {
          return;
        }
        closeNotified = true;
        input.onClosed?.();
      };
      relaySocket.addEventListener("close", markClosed);
      relaySocket.addEventListener("error", markClosed);
      localSocket.addEventListener("close", markClosed);
      localSocket.addEventListener("error", markClosed);

      const cleanupClosedListeners = () => {
        relaySocket.removeEventListener("close", markClosed);
        relaySocket.removeEventListener("error", markClosed);
        localSocket.removeEventListener("close", markClosed);
        localSocket.removeEventListener("error", markClosed);
      };

      return {
        close: () => {
          closed = true;
          closeNotified = true;
          cleanupRelayForward();
          cleanupLocalForward();
          cleanupCloseBinding();
          cleanupClosedListeners();
          closeSocket(relaySocket);
          closeSocket(localSocket);
        },
        isClosed: () =>
          closed ||
          relaySocket.readyState === WebSocket.CLOSING ||
          relaySocket.readyState === WebSocket.CLOSED ||
          localSocket.readyState === WebSocket.CLOSING ||
          localSocket.readyState === WebSocket.CLOSED,
      };
    },
    catch: (cause) =>
      cause instanceof DesktopRelayError
        ? cause
        : relayError("open-relay-bridge", "Could not open phone bridge.", cause),
  });
}

const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const activeBridgeRef = yield* Ref.make(Option.none<ActiveRelayBridge>());

  function clearReconnectTimer(active: ActiveRelayBridge): void {
    if (!active.reconnectTimer) {
      return;
    }
    clearTimeout(active.reconnectTimer);
    active.reconnectTimer = null;
  }

  const disconnectPairingSession = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeBridgeRef, Option.none());
    if (Option.isNone(active)) {
      return;
    }

    active.value.intentionalClose = true;
    active.value.status = "disconnected";
    clearReconnectTimer(active.value);
    active.value.bridge.close();
    yield* logRelayInfo("relay pairing session disconnected", {
      sessionId: active.value.session.sessionId,
    });
  });

  function openActiveBridge(
    active: ActiveRelayBridge,
  ): Effect.Effect<RelayBridgeHandle, DesktopRelayError> {
    return Effect.gen(function* () {
      const maybeBackendConfig = yield* backendManager.currentConfig;
      if (Option.isNone(maybeBackendConfig)) {
        return yield* relayError("open-relay-bridge", "Desktop backend is not ready yet.");
      }

      const localSocketUrl = yield* createLocalWebSocketUrl(maybeBackendConfig.value);
      let bridge: RelayBridgeHandle | null = null;
      bridge = yield* openBridge({
        localSocketUrl,
        relayDesktopSocketUrl: active.relayDesktopSocketUrl,
        relayDesktopToken: active.relayDesktopToken,
        onClosed: () => {
          void Effect.runPromise(handleBridgeClosed(active, bridge)).catch((error) => {
            void Effect.runPromise(
              logRelayWarning("failed to handle relay pairing bridge close", {
                sessionId: active.session.sessionId,
                error: errorMessage(error),
              }),
            );
          });
        },
      });
      return bridge;
    });
  }

  function scheduleReconnect(active: ActiveRelayBridge): Effect.Effect<void> {
    return Effect.sync(() => {
      if (
        active.intentionalClose ||
        active.reconnectTimer ||
        active.reconnectInFlight ||
        isSessionExpired(active.session)
      ) {
        return;
      }

      active.status = "reconnecting";
      const delayMs = nextReconnectDelayMs(active.reconnectAttempt);
      active.reconnectTimer = setTimeout(() => {
        active.reconnectTimer = null;
        void Effect.runPromise(reconnectActiveBridge(active)).catch((error) => {
          void Effect.runPromise(
            logRelayWarning("failed to run relay pairing reconnect", {
              sessionId: active.session.sessionId,
              error: errorMessage(error),
            }),
          );
        });
      }, delayMs);
    });
  }

  function handleBridgeClosed(
    active: ActiveRelayBridge,
    closedBridge: RelayBridgeHandle | null,
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      const current = yield* Ref.get(activeBridgeRef);
      if (
        Option.isNone(current) ||
        current.value !== active ||
        active.intentionalClose ||
        (closedBridge && active.bridge !== closedBridge)
      ) {
        return;
      }

      if (isSessionExpired(active.session)) {
        yield* disconnectPairingSession;
        return;
      }

      const shouldLogClosed = active.status === "open";
      active.status = "reconnecting";
      if (shouldLogClosed) {
        yield* logRelayWarning("relay pairing bridge closed; reconnecting", {
          sessionId: active.session.sessionId,
        });
      }
      yield* scheduleReconnect(active);
    });
  }

  function reconnectActiveBridge(active: ActiveRelayBridge): Effect.Effect<void> {
    let ownsReconnectAttempt = false;

    return Effect.gen(function* () {
      const current = yield* Ref.get(activeBridgeRef);
      if (Option.isNone(current) || current.value !== active || active.intentionalClose) {
        return;
      }

      if (isSessionExpired(active.session)) {
        yield* disconnectPairingSession;
        return;
      }

      if (active.reconnectInFlight) {
        return;
      }

      active.reconnectInFlight = true;
      ownsReconnectAttempt = true;
      active.status = "reconnecting";

      const previousBridge = active.bridge;
      const nextBridge = yield* openActiveBridge(active);
      const latest = yield* Ref.get(activeBridgeRef);
      if (Option.isNone(latest) || latest.value !== active || active.intentionalClose) {
        nextBridge.close();
        return;
      }

      previousBridge.close();
      active.bridge = nextBridge;
      active.status = "open";
      active.lastError = null;
      active.reconnectAttempt = 0;
      yield* logRelayInfo("relay pairing bridge reconnected", {
        sessionId: active.session.sessionId,
      });
    }).pipe(
      Effect.catch((error: DesktopRelayError) =>
        Effect.gen(function* () {
          if (ownsReconnectAttempt) {
            active.reconnectInFlight = false;
            ownsReconnectAttempt = false;
          }

          const current = yield* Ref.get(activeBridgeRef);
          if (Option.isNone(current) || current.value !== active || active.intentionalClose) {
            return;
          }

          if (isSessionExpired(active.session)) {
            yield* disconnectPairingSession;
            return;
          }

          active.status = "reconnecting";
          active.lastError = error.message;
          active.reconnectAttempt += 1;
          yield* logRelayWarning("failed to reconnect relay pairing bridge", {
            sessionId: active.session.sessionId,
            error: error.message,
            retryInMs: nextReconnectDelayMs(active.reconnectAttempt),
          });
          yield* scheduleReconnect(active);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (ownsReconnectAttempt) {
            active.reconnectInFlight = false;
          }
        }),
      ),
    );
  }

  const getPairingSession = Effect.gen(function* () {
    const active = yield* Ref.get(activeBridgeRef);
    if (Option.isNone(active)) {
      return null;
    }

    if (isSessionExpired(active.value.session)) {
      yield* disconnectPairingSession;
      return null;
    }

    if (active.value.bridge.isClosed() && active.value.status === "open") {
      yield* handleBridgeClosed(active.value, active.value.bridge);
    }

    const latest = yield* Ref.get(activeBridgeRef);
    return Option.isSome(latest) ? toPairingSession(latest.value) : null;
  });

  const createPairingSession = Effect.gen(function* () {
    const maybeBackendConfig = yield* backendManager.currentConfig;
    if (Option.isNone(maybeBackendConfig)) {
      return yield* relayError("open-relay-bridge", "Desktop backend is not ready yet.");
    }

    yield* disconnectPairingSession;

    const relaySession = yield* createRelaySession(config.relayUrl);
    const session: DesktopRelayPairingSession = {
      pairingUrl: relaySession.pairingUrl,
      relayOrigin: new URL(relaySession.deviceSocketUrl).origin,
      sessionId: relaySession.sessionId,
      expiresAt: relaySession.expiresAt,
      status: "open",
    };
    const active: ActiveRelayBridge = {
      session,
      relayDesktopSocketUrl: relaySession.desktopSocketUrl,
      relayDesktopToken: relaySession.desktopToken,
      bridge: createClosedBridgeHandle(),
      intentionalClose: false,
      reconnectInFlight: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      status: "open",
      lastError: null,
    };
    active.bridge = yield* openActiveBridge(active);

    yield* Ref.set(activeBridgeRef, Option.some(active));
    yield* logRelayInfo("relay pairing session created", {
      sessionId: session.sessionId,
      relayOrigin: session.relayOrigin,
      expiresAt: session.expiresAt,
    });
    return toPairingSession(active);
  }).pipe(
    Effect.tapError((error) =>
      logRelayWarning("failed to create relay pairing session", {
        error: error.message,
      }),
    ),
  );

  return DesktopRelay.of({
    getPairingSession,
    createPairingSession,
    disconnectPairingSession,
  });
});

export const layer = Layer.effect(DesktopRelay, make);
