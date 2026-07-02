import {
  AuthBearerBootstrapResult,
  AuthWebSocketTokenResult,
  type DesktopRelayPairingSession,
} from "@threadlines/contracts";
import {
  RELAY_CLOSE_CODE_REPLACED,
  RELAY_RAW_CONTROL_PREFIX,
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

// The relay now keeps the desktop socket alive while the phone is away, so
// bridge closes are rare, real failures; a 10s cap keeps the phone's
// worst-case wait for the desktop short.
const RELAY_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

// Device frames buffered while the local backend socket is (re)opening.
// Localhost opens in milliseconds; the cap only guards against a stuck
// backend, where dropping frames is safe because the phone's heartbeat
// timeout forces a fresh session anyway.
const MAX_PENDING_DEVICE_FRAMES = 1_000;

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
  return RELAY_RECONNECT_DELAYS_MS[index] ?? 10_000;
}

interface RelayRawControlEvent {
  readonly type: "relay.peer-joined" | "relay.peer-left";
  readonly role: string;
  readonly connectionId: string;
}

function parseRelayRawControlFrame(data: string): RelayRawControlEvent | null {
  try {
    const parsed = JSON.parse(data.slice(RELAY_RAW_CONTROL_PREFIX.length)) as Record<
      string,
      unknown
    >;
    if (
      (parsed.type === "relay.peer-joined" || parsed.type === "relay.peer-left") &&
      typeof parsed.role === "string" &&
      typeof parsed.connectionId === "string"
    ) {
      return { type: parsed.type, role: parsed.role, connectionId: parsed.connectionId };
    }
  } catch {
    // Malformed control frames are dropped below.
  }
  return null;
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

export interface RelayBridgeCloseContext {
  readonly closeCode: number | null;
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

// The bridge keeps one long-lived relay socket per pairing session and pipes
// its frames into a replaceable local backend socket. The local socket is
// recycled whenever a device (re)joins after using it, because a fresh device
// RPC client must not resume on a server connection that still holds the
// previous client's subscriptions and request ids.
function openBridge(input: {
  readonly getLocalSocketUrl: () => Promise<string>;
  readonly relayDesktopSocketUrl: string;
  readonly relayDesktopToken: string;
  readonly onClosed?: (context: RelayBridgeCloseContext) => void;
}): Effect.Effect<RelayBridgeHandle, DesktopRelayError> {
  return Effect.tryPromise({
    try: async () => {
      const relaySocket = new WebSocket(withRawRelayMode(input.relayDesktopSocketUrl), [
        RELAY_WEBSOCKET_PROTOCOL,
        `${RELAY_TOKEN_PROTOCOL_PREFIX}${input.relayDesktopToken}`,
      ]);

      let closed = false;
      let closeNotified = false;
      let localSocket: WebSocket | null = null;
      let localGeneration = 0;
      let localOpenChain: Promise<void> = Promise.resolve();
      let localUsedByDevice = false;
      let detachLocal: () => void = () => {};
      let pendingDeviceFrames: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
      let currentDeviceConnectionId: string | null = null;

      const teardownLocal = () => {
        localGeneration += 1;
        detachLocal();
        detachLocal = () => {};
        const socket = localSocket;
        localSocket = null;
        localUsedByDevice = false;
        if (socket) {
          closeSocket(socket);
        }
      };

      const detachRelay = () => {
        relaySocket.removeEventListener("message", onRelayMessage);
        relaySocket.removeEventListener("close", onRelayClose);
        relaySocket.removeEventListener("error", onRelayError);
      };

      const markClosed = (closeCode: number | null) => {
        if (closed) {
          return;
        }
        closed = true;
        pendingDeviceFrames = [];
        teardownLocal();
        detachRelay();
        closeSocket(relaySocket);
        if (!closeNotified) {
          closeNotified = true;
          input.onClosed?.({ closeCode });
        }
      };

      const attachLocal = (socket: WebSocket) => {
        const onLocalMessage = (event: MessageEvent) => {
          if (relaySocket.readyState === WebSocket.OPEN) {
            relaySocket.send(event.data);
          }
        };
        const onLocalClosed = () => {
          if (closed || localSocket !== socket) {
            return;
          }
          teardownLocal();
          // The backend socket dropped (for example a server restart). If a
          // device is still connected, reopen right away; otherwise the next
          // device frame or peer-join reopens it on demand.
          if (currentDeviceConnectionId !== null) {
            void ensureLocalSocket().catch(() => markClosed(null));
          }
        };
        socket.addEventListener("message", onLocalMessage);
        socket.addEventListener("close", onLocalClosed);
        socket.addEventListener("error", onLocalClosed);
        detachLocal = () => {
          socket.removeEventListener("message", onLocalMessage);
          socket.removeEventListener("close", onLocalClosed);
          socket.removeEventListener("error", onLocalClosed);
        };
        localSocket = socket;
        localUsedByDevice = false;
        const frames = pendingDeviceFrames;
        pendingDeviceFrames = [];
        for (const frame of frames) {
          socket.send(frame);
          localUsedByDevice = true;
        }
      };

      // Opens are serialized so a recycle issued while a previous open is in
      // flight cannot race it; the superseded open abandons its socket via
      // the generation check.
      const ensureLocalSocket = (): Promise<void> => {
        const next = localOpenChain.then(async () => {
          if (closed || localSocket) {
            return;
          }
          const generation = localGeneration;
          const localSocketUrl = await input.getLocalSocketUrl();
          if (closed || generation !== localGeneration || localSocket) {
            return;
          }
          const socket = new WebSocket(localSocketUrl);
          try {
            await waitForSocketOpen(socket, "Local backend");
          } catch (error) {
            closeSocket(socket);
            throw error;
          }
          if (closed || generation !== localGeneration || localSocket) {
            closeSocket(socket);
            return;
          }
          attachLocal(socket);
        });
        localOpenChain = next.catch(() => undefined);
        return next;
      };

      const onRelayMessage = (event: MessageEvent) => {
        if (closed) {
          return;
        }
        const data: unknown = event.data;
        if (typeof data === "string" && data.startsWith(RELAY_RAW_CONTROL_PREFIX)) {
          const control = parseRelayRawControlFrame(data);
          if (!control || control.role !== "device") {
            return;
          }
          if (control.type === "relay.peer-joined") {
            currentDeviceConnectionId = control.connectionId;
            if (localUsedByDevice) {
              teardownLocal();
            }
            void ensureLocalSocket().catch(() => markClosed(null));
            return;
          }
          if (control.connectionId !== currentDeviceConnectionId) {
            return;
          }
          currentDeviceConnectionId = null;
          pendingDeviceFrames = [];
          teardownLocal();
          return;
        }

        if (localSocket && localSocket.readyState === WebSocket.OPEN) {
          localUsedByDevice = true;
          localSocket.send(event.data);
          return;
        }
        if (pendingDeviceFrames.length >= MAX_PENDING_DEVICE_FRAMES) {
          pendingDeviceFrames.shift();
        }
        pendingDeviceFrames.push(event.data);
        void ensureLocalSocket().catch(() => markClosed(null));
      };
      const onRelayClose = (event: CloseEvent) => {
        markClosed(typeof event.code === "number" ? event.code : null);
      };
      const onRelayError = () => {
        markClosed(null);
      };

      try {
        await waitForSocketOpen(relaySocket, "Relay");
      } catch (error) {
        closeSocket(relaySocket);
        throw error instanceof DesktopRelayError
          ? error
          : relayError("open-relay-bridge", errorMessage(error), error);
      }

      relaySocket.addEventListener("message", onRelayMessage);
      relaySocket.addEventListener("close", onRelayClose);
      relaySocket.addEventListener("error", onRelayError);

      try {
        await ensureLocalSocket();
      } catch (error) {
        closed = true;
        closeNotified = true;
        teardownLocal();
        detachRelay();
        closeSocket(relaySocket);
        throw error instanceof DesktopRelayError
          ? error
          : relayError("open-relay-bridge", errorMessage(error), error);
      }
      if (closed) {
        throw relayError(
          "open-relay-bridge",
          "Relay connection closed while the local pipe was opening.",
        );
      }

      return {
        close: () => {
          closeNotified = true;
          markClosed(null);
        },
        isClosed: () =>
          closed ||
          relaySocket.readyState === WebSocket.CLOSING ||
          relaySocket.readyState === WebSocket.CLOSED,
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

  // Mints a fresh short-lived ws token per local socket, so recycled local
  // pipes never reuse a consumed credential.
  const createLocalSocketUrlForCurrentBackend = Effect.gen(function* () {
    const maybeBackendConfig = yield* backendManager.currentConfig;
    if (Option.isNone(maybeBackendConfig)) {
      return yield* relayError("open-relay-bridge", "Desktop backend is not ready yet.");
    }
    return yield* createLocalWebSocketUrl(maybeBackendConfig.value);
  });

  function openActiveBridge(
    active: ActiveRelayBridge,
  ): Effect.Effect<RelayBridgeHandle, DesktopRelayError> {
    return Effect.gen(function* () {
      let bridge: RelayBridgeHandle | null = null;
      bridge = yield* openBridge({
        getLocalSocketUrl: () => Effect.runPromise(createLocalSocketUrlForCurrentBackend),
        relayDesktopSocketUrl: active.relayDesktopSocketUrl,
        relayDesktopToken: active.relayDesktopToken,
        onClosed: (context) => {
          void Effect.runPromise(handleBridgeClosed(active, bridge, context.closeCode)).catch(
            (error) => {
              void Effect.runPromise(
                logRelayWarning("failed to handle relay pairing bridge close", {
                  sessionId: active.session.sessionId,
                  error: errorMessage(error),
                }),
              );
            },
          );
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
    closeCode: number | null = null,
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

      if (closeCode === RELAY_CLOSE_CODE_REPLACED) {
        // Another desktop connection took over this relay session; retrying
        // from here would make the two desktops steal the link back and
        // forth.
        yield* logRelayWarning("relay pairing session was replaced by another desktop", {
          sessionId: active.session.sessionId,
        });
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
