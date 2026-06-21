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
  readonly createPairingSession: Effect.Effect<DesktopRelayPairingSession, DesktopRelayError>;
  readonly disconnectPairingSession: Effect.Effect<void>;
}

export class DesktopRelay extends Context.Service<DesktopRelay, DesktopRelayShape>()(
  "t3/desktop/Relay",
) {}

interface ActiveRelayBridge {
  readonly session: DesktopRelayPairingSession;
  readonly close: () => void;
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
}): Effect.Effect<() => void, DesktopRelayError> {
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

      return () => {
        cleanupRelayForward();
        cleanupLocalForward();
        cleanupCloseBinding();
        closeSocket(relaySocket);
        closeSocket(localSocket);
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

  const disconnectPairingSession = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeBridgeRef, Option.none());
    if (Option.isNone(active)) {
      return;
    }
    active.value.close();
    yield* logRelayInfo("relay pairing session disconnected", {
      sessionId: active.value.session.sessionId,
    });
  });

  const createPairingSession = Effect.gen(function* () {
    const maybeBackendConfig = yield* backendManager.currentConfig;
    if (Option.isNone(maybeBackendConfig)) {
      return yield* relayError("open-relay-bridge", "Desktop backend is not ready yet.");
    }

    yield* disconnectPairingSession;

    const backendConfig = maybeBackendConfig.value;
    const relaySession = yield* createRelaySession(config.relayUrl);
    const localSocketUrl = yield* createLocalWebSocketUrl(backendConfig);
    const close = yield* openBridge({
      localSocketUrl,
      relayDesktopSocketUrl: relaySession.desktopSocketUrl,
      relayDesktopToken: relaySession.desktopToken,
    });
    const session: DesktopRelayPairingSession = {
      pairingUrl: relaySession.pairingUrl,
      relayOrigin: new URL(relaySession.deviceSocketUrl).origin,
      sessionId: relaySession.sessionId,
      expiresAt: relaySession.expiresAt,
    };

    yield* Ref.set(activeBridgeRef, Option.some({ session, close }));
    yield* logRelayInfo("relay pairing session created", {
      sessionId: session.sessionId,
      relayOrigin: session.relayOrigin,
      expiresAt: session.expiresAt,
    });
    return session;
  }).pipe(
    Effect.tapError((error) =>
      logRelayWarning("failed to create relay pairing session", {
        error: error.message,
      }),
    ),
  );

  return DesktopRelay.of({
    createPairingSession,
    disconnectPairingSession,
  });
});

export const layer = Layer.effect(DesktopRelay, make);
