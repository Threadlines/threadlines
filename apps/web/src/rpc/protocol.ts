import { WsRpcGroup } from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type { Rpc, RpcClientError, RpcGroup } from "effect/rpc";
import { RpcClient, RpcSchema, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import { applyRelayFrameChunking } from "./relayFrameChunking";
import { TransportUrlUnavailableError } from "./transportError";
import {
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  type WsConnectionMetadata,
} from "./wsConnectionState";

export interface WsProtocolCloseContext {
  readonly intentional: boolean;
}

export interface WsProtocolLifecycleHandlers {
  /**
   * Whether this socket is the app's own connection, the one the reconnect
   * coordinator and its toasts read (`wsConnectionState`). On by default. Off
   * for sockets to other computers: they keep their own state in the saved
   * environment runtime, so one of them dropping never reads as this
   * computer's link going down, and a live one never hides that it did.
   */
  readonly reportsAppConnection?: boolean;
  readonly getConnectionLabel?: () => string | null;
  readonly getVersionMismatchHint?: () => string | null;
  readonly isCloseIntentional?: () => boolean;
  readonly isActive?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  /**
   * First inbound frame on a socket connection. On relay transports the relay
   * forwards only desktop frames to devices, so this is the earliest proof
   * that the desktop peer is actually reachable — an open socket is not.
   */
  readonly onFirstMessage?: () => void;
  /**
   * Every inbound frame, heartbeat replies included. Any frame proves the
   * server is still answering; the protocol's own heartbeat counts liveness
   * the same way.
   */
  readonly onMessage?: () => void;
  /**
   * The heartbeat found the connection silent. Runs after the protocol has
   * dropped the socket and before it opens a replacement.
   */
  readonly onHeartbeatTimeout?: () => void;
  /** A request is about to go out on the socket. */
  readonly onRequestStart?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (
    details: { readonly code: number; readonly reason: string },
    context: WsProtocolCloseContext,
  ) => void;
}

type WsRpcs = typeof WsRpcGroup extends RpcGroup.RpcGroup<infer Rpcs> ? Rpcs : never;
const STREAM_RPC_TAGS: ReadonlySet<string> = new Set(
  Array.from(WsRpcGroup.requests.values(), (rpc) =>
    RpcSchema.isStreamSchema(rpc.successSchema) ? rpc._tag : null,
  ).filter((tag) => tag !== null),
);
/**
 * Named rather than inferred: the generated client expands to one method per
 * RPC, so letting the compiler infer it puts the whole surface (every command
 * payload included) inline, and adding a command tips it past the type
 * serialization limit.
 */
export type WsRpcProtocolClient = RpcClient.RpcClient<WsRpcs, RpcClientError.RpcClientError>;
export const makeWsRpcProtocolClient: Effect.Effect<
  WsRpcProtocolClient,
  never,
  RpcClient.Protocol | Rpc.MiddlewareClient<WsRpcs> | Scope.Scope
> = RpcClient.make(WsRpcGroup);
export type WsRpcProtocolSocketUrlProvider = string | (() => Promise<string>);

export interface WsRpcProtocolOptions {
  readonly preservePath?: boolean;
  readonly protocols?: string | readonly string[];
  /**
   * Split oversized outgoing frames and reassemble incoming chunk frames.
   * Required on relay connections, where Cloudflare drops WebSocket messages
   * over 1 MiB.
   */
  readonly chunkFrames?: boolean;
  /**
   * "Connect a device" connections: builds the end-to-end encrypted socket
   * (route choice and handshake) in place of a plain WebSocket. It frames its
   * own messages, so `chunkFrames` and `protocols` don't apply.
   */
  readonly secureSocket?: (socketUrl: string) => WebSocket;
  /** How long to wait for `open`; effect's default is 10 seconds. */
  readonly openTimeoutMs?: number;
}

function formatSocketErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function resolveWsRpcSocketUrl(rawUrl: string, options?: WsRpcProtocolOptions): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  if (!options?.preservePath) {
    resolved.pathname = "/ws";
  }
  return resolved.toString();
}

function resolveConnectionMetadata(handlers?: WsProtocolLifecycleHandlers): WsConnectionMetadata {
  return {
    connectionLabel: handlers?.getConnectionLabel?.() ?? null,
    versionMismatchHint: handlers?.getVersionMismatchHint?.() ?? null,
  };
}

function normalizeProtocols(
  protocols: WsRpcProtocolOptions["protocols"],
): string | Array<string> | undefined {
  if (protocols === undefined) {
    return undefined;
  }
  return typeof protocols === "string" ? protocols : [...protocols];
}

type ComposedWsProtocolLifecycleHandlers = Required<
  Pick<
    WsProtocolLifecycleHandlers,
    "isActive" | "onAttempt" | "onOpen" | "onFirstMessage" | "onMessage" | "onError" | "onClose"
  >
>;

function reportsAppConnection(handlers?: WsProtocolLifecycleHandlers): boolean {
  return handlers?.reportsAppConnection !== false;
}

function defaultLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  const reports = reportsAppConnection(handlers);
  return {
    isActive: () => true,
    onAttempt: (socketUrl) => {
      if (reports) recordWsConnectionAttempt(socketUrl, resolveConnectionMetadata(handlers));
    },
    onOpen: () => {
      if (reports) recordWsConnectionOpened(resolveConnectionMetadata(handlers));
    },
    onFirstMessage: () => undefined,
    onMessage: () => undefined,
    onError: (message) => {
      clearAllTrackedRpcRequests();
      if (reports) recordWsConnectionErrored(message, resolveConnectionMetadata(handlers));
    },
    onClose: (details, context) => {
      clearAllTrackedRpcRequests();
      if (context.intentional || !reports) {
        return;
      }
      recordWsConnectionClosed(details, resolveConnectionMetadata(handlers));
    },
  };
}

function composeLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  const defaults = defaultLifecycleHandlers(handlers);
  const isActive = handlers?.isActive ?? defaults.isActive;

  return {
    isActive,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      defaults.onAttempt(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      defaults.onOpen();
      handlers?.onOpen?.();
    },
    onFirstMessage: () => {
      if (!isActive()) {
        return;
      }
      handlers?.onFirstMessage?.();
    },
    onMessage: () => {
      if (!isActive()) {
        return;
      }
      handlers?.onMessage?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      defaults.onError(message);
      handlers?.onError?.(message);
    },
    onClose: (details, context) => {
      if (!isActive()) {
        return;
      }
      defaults.onClose(details, context);
      handlers?.onClose?.(details, context);
    },
  };
}

/** Whatever the URL provider failed with, kept whole for the triage below. */
class UrlProviderFailure extends Data.TaggedError("UrlProviderFailure")<{
  readonly cause: unknown;
}> {}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
  options?: WsRpcProtocolOptions,
) {
  const lifecycle = composeLifecycleHandlers(handlers);
  // A provider that could not reach the server fails the attempt the way a
  // socket that would not open does, so the retry policy below keeps trying.
  // Any other provider failure is a defect, which ends the protocol's connect
  // loop for good: every later request on the session fails at once. That is
  // right for a refused credential and was wrong for a computer that had gone
  // to sleep, which was never reconnected after it woke up.
  const resolvedUrl =
    typeof url === "function"
      ? Effect.tryPromise({
          try: () => url(),
          catch: (cause) => new UrlProviderFailure({ cause }),
        }).pipe(
          Effect.map((rawUrl) => resolveWsRpcSocketUrl(rawUrl, options)),
          Effect.catch(({ cause }) => {
            lifecycle.onError(formatSocketErrorMessage(cause));
            return cause instanceof TransportUrlUnavailableError
              ? Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
                  }),
                )
              : Effect.die(cause);
          }),
        )
      : Effect.succeed(resolveWsRpcSocketUrl(url, options));

  const openSocket = (socketUrl: string) => {
    lifecycle.onAttempt(socketUrl);
    const socket = options?.secureSocket
      ? options.secureSocket(socketUrl)
      : new globalThis.WebSocket(socketUrl, normalizeProtocols(options?.protocols));
    if (options?.chunkFrames && !options.secureSocket) {
      applyRelayFrameChunking(socket);
    }

    socket.addEventListener(
      "open",
      () => {
        lifecycle.onOpen();
      },
      { once: true },
    );
    // Self-guarded instead of { once: true }: the relay chunking patch
    // funnels message listeners and does not honor listener options.
    let sawFirstMessage = false;
    socket.addEventListener("message", () => {
      lifecycle.onMessage();
      if (sawFirstMessage) {
        return;
      }
      sawFirstMessage = true;
      lifecycle.onFirstMessage();
    });
    socket.addEventListener(
      "error",
      () => {
        lifecycle.onError("Unable to connect to the Threadlines server WebSocket.");
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        lifecycle.onClose(
          {
            code: event.code,
            reason: event.reason,
          },
          {
            intentional: handlers?.isCloseIntentional?.() ?? false,
          },
        );
      },
      { once: true },
    );

    return socket;
  };
  const socketLayer = Layer.effect(
    Socket.Socket,
    Socket.fromWebSocket(
      Effect.acquireRelease(Effect.map(resolvedUrl, openSocket), (socket) =>
        Effect.sync(() => socket.close(1000)),
      ),
      options?.openTimeoutMs === undefined
        ? undefined
        : { openTimeout: Duration.millis(options.openTimeoutMs) },
    ),
  );
  // Retry forever with capped backoff: giving up permanently meant mobile
  // browsers that dropped the socket while backgrounded came back to a dead
  // page. The online/visibility handlers reset the loop with a fresh session.
  const retryPolicy = Schedule.addDelay(Schedule.forever, ({ output: retryCount }) =>
    Effect.succeed(Duration.millis(getWsReconnectDelayMsForRetry(retryCount))),
  );
  // A heartbeat timeout should fail only the requests in flight on the silent
  // socket, whose answers are lost; WsTransport does that in
  // `onHeartbeatTimeout`. Effect also fails every request the client knows of,
  // even one made a moment later, and every send until a new socket is up. So
  // that failure is dropped in `run` below, and sends are held here until a
  // socket connects, as they are while a socket will not open. Streams move to
  // the new socket when it opens (WsTransport). A different failure after it
  // (a refused credential ends the connect loop) releases what is held, and
  // fails it as before.
  let heldUntilConnected: Latch.Latch | undefined;
  const releaseHeld = () => {
    const held = heldUntilConnected;
    heldUntilConnected = undefined;
    held?.openUnsafe();
  };
  const isHeartbeatFailure = (error: RpcClientError.RpcClientError) =>
    error.reason._tag === "SocketReadError";
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      onConnect: Effect.sync(releaseHeld),
      onDisconnect: Effect.void,
    }),
  );
  const sendWhenConnected = (
    protocol: RpcClient.Protocol["Service"],
    ...[clientId, request, transferables]: Parameters<RpcClient.Protocol["Service"]["send"]>
  ): ReturnType<RpcClient.Protocol["Service"]["send"]> =>
    // Suspended: the protocol's `send` checks its error state when called.
    Effect.suspend(() => protocol.send(clientId, request, transferables)).pipe(
      Effect.catch((error) => {
        const held = heldUntilConnected;
        return held === undefined || request._tag !== "Request" || !isHeartbeatFailure(error)
          ? Effect.fail(error)
          : held.await.pipe(
              Effect.andThen(() => sendWhenConnected(protocol, clientId, request, transferables)),
            );
      }),
    );

  // Request tracking and the heartbeat ride on the protocol itself: requests
  // are seen as they go out, chunks and exits as they come back.
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        retryTransientErrors: true,
        onPingTimeout: Effect.sync(() => {
          heldUntilConnected ??= Latch.makeUnsafe(false);
          if (!lifecycle.isActive()) {
            return;
          }
          clearAllTrackedRpcRequests();
          if (reportsAppConnection(handlers)) {
            recordWsConnectionErrored(
              "WebSocket heartbeat timed out.",
              resolveConnectionMetadata(handlers),
            );
          }
          handlers?.onHeartbeatTimeout?.();
        }),
      }),
      (protocol): RpcClient.Protocol["Service"] => ({
        ...protocol,
        send: (clientId, request, transferables) =>
          Effect.suspend(() => {
            const send = sendWhenConnected(protocol, clientId, request, transferables);
            if (!lifecycle.isActive()) {
              return send;
            }
            if (request._tag === "Interrupt") {
              acknowledgeRpcRequest(String(request.requestId));
              return send;
            }
            if (request._tag !== "Request") {
              return send;
            }
            const id = String(request.id);
            handlers?.onRequestStart?.({
              id,
              tag: request.tag,
              stream: STREAM_RPC_TAGS.has(request.tag),
            });
            trackRpcRequestSent(id, request.tag);
            // A send the protocol refused never gets an answer to wait for.
            return Effect.onError(send, () => Effect.sync(() => acknowledgeRpcRequest(id)));
          }),
        run: (clientId, writeResponse) =>
          protocol.run(clientId, (response) => {
            if (response._tag === "ClientProtocolError" && heldUntilConnected !== undefined) {
              // The heartbeat timeout's own failure (see above).
              if (isHeartbeatFailure(response.error)) {
                return Effect.void;
              }
              releaseHeld();
            }
            if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              clearAllTrackedRpcRequests();
            } else if (
              (response._tag === "Chunk" || response._tag === "Exit") &&
              lifecycle.isActive()
            ) {
              acknowledgeRpcRequest(String(response.requestId));
            }
            return writeResponse(response);
          }),
      }),
    ),
  );

  return protocolLayer.pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
  );
}
