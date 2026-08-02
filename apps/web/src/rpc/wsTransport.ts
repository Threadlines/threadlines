import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/unstable/rpc";

import { ClientTracingLive } from "../observability/clientTracing";
import {
  recordStreamDiagnostic,
  STREAM_DIAGNOSTIC_NAMES,
} from "../observability/streamDiagnostics";
import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsRpcProtocolOptions,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";
import {
  isRetryableRequestFailure,
  isTransportConnectionErrorMessage,
  TransportRequestRetriesExhaustedError,
  TransportRequestTimeoutError,
} from "./transportError";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  readonly tag?: string;
  readonly resubscribe?: boolean;
  readonly onComplete?: () => void;
  /**
   * Fires every time a stream attempt fails and the subscription is about to
   * retry. Consumers use it to surface "live data is broken" states instead of
   * sitting on a spinner while the transport retries in the background.
   */
  readonly onRetry?: (error: unknown, attempt: number) => void;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

export interface RequestRetryOptions {
  /** Method name used in error messages and telemetry. */
  readonly label?: string;
  /** How long one attempt may wait for the server's response. */
  readonly attemptTimeoutMs?: number;
  /** Total wall-clock budget across attempts, reconnects, and backoff. */
  readonly totalBudgetMs?: number;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
// Ceiling for the exponential backoff applied to subscription streams that
// fail with non-transport errors (server-side stream failures, protocol
// teardown races). Retrying forever is intentional: these streams are the
// only source of live orchestration state, so abandoning one permanently
// freezes the UI until a full page reload.
const MAX_SUBSCRIPTION_FAILURE_BACKOFF_MS = 15_000;
const DEFAULT_REQUEST_ATTEMPT_TIMEOUT_MS = 25_000;
const DEFAULT_REQUEST_RETRY_BUDGET_MS = 90_000;
// A pong newer than this means the socket the failure happened on is alive,
// so the failure was request-level and a plain re-send is enough. Older (or
// no) pongs mean a zombie socket: force a fresh session before retrying
// instead of waiting out the protocol's own backoff on a dead pipe.
const REQUEST_RETRY_HEARTBEAT_FRESH_MS = 12_000;
const REQUEST_RETRY_DELAYS_MS = [400, 800, 1_600, 3_200, 5_000] as const;
const NOOP: () => void = () => undefined;

function getRequestRetryDelayMs(attempt: number): number {
  return (
    REQUEST_RETRY_DELAYS_MS[Math.min(attempt, REQUEST_RETRY_DELAYS_MS.length - 1)] ??
    REQUEST_RETRY_DELAYS_MS[0]
  );
}

function resolveRequestTimeoutMs(options: RequestOptions | undefined): number | null {
  const timeout = options?.timeout;
  if (timeout === undefined || Option.isNone(timeout)) {
    return null;
  }
  return Duration.toMillis(Duration.fromInputUnsafe(timeout.value));
}

function withAttemptTimeout<TSuccess>(
  effect: Effect.Effect<TSuccess, Error, never>,
  timeoutMs: number,
  label: string,
): Effect.Effect<TSuccess, Error, never> {
  return effect.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(new TransportRequestTimeoutError(label, timeoutMs)),
    ),
  );
}

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

interface StreamRequestStartInfo {
  readonly id: string;
  readonly tag: string;
  readonly stream: boolean;
}

/**
 * Handle for one running subscription stream, tracked per session so a session
 * swap can interrupt every stream still bound to the replaced session.
 */
interface RunningStreamRegistration {
  cancel: () => void;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly protocolOptions: WsRpcProtocolOptions | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private intentionalCloseDepth = 0;
  private reconnectChain: Promise<void> = Promise.resolve();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession;
  private lastHeartbeatPongAt = 0;
  private readonly streamRequestStartListeners = new Set<(info: StreamRequestStartInfo) => void>();
  // Session-replacement invariant: no subscription stream may keep awaiting a
  // session that is no longer `this.session`. A half-open socket never fails
  // its streams, so without this registry a subscribe loop can sit on a dead
  // session forever while unary requests already run on the new one.
  private readonly runningStreamsBySession = new Map<
    TransportSession,
    Set<RunningStreamRegistration>
  >();

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    protocolOptions?: WsRpcProtocolOptions,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.protocolOptions = protocolOptions;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    const timeoutMs = resolveRequestTimeoutMs(options);
    const effect = Effect.suspend(() => execute(client));
    return await session.runtime.runPromise(
      timeoutMs === null ? effect : withAttemptTimeout(effect, timeoutMs, "request"),
    );
  }

  /**
   * Like request(), but re-sends across socket drops, zombie sockets, and
   * session swaps until the server acknowledges or the budget runs out.
   * ONLY safe for idempotent methods: orchestration commands (deduped
   * server-side by commandId receipts) and pure reads. Server rejections
   * are never retried — they surface on the first attempt.
   */
  async requestWithReconnectRetry<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    options?: RequestRetryOptions,
  ): Promise<TSuccess> {
    const label = options?.label ?? "request";
    const attemptTimeoutMs = options?.attemptTimeoutMs ?? DEFAULT_REQUEST_ATTEMPT_TIMEOUT_MS;
    const totalBudgetMs = options?.totalBudgetMs ?? DEFAULT_REQUEST_RETRY_BUDGET_MS;
    const startedAtMs = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }
      const session = this.session;
      try {
        const client = await session.clientPromise;
        return await session.runtime.runPromise(
          withAttemptTimeout(
            Effect.suspend(() => execute(client)),
            attemptTimeoutMs,
            label,
          ),
        );
      } catch (error) {
        if (this.disposed || !isRetryableRequestFailure(error)) {
          throw error;
        }
        const elapsedMs = Date.now() - startedAtMs;
        const retryDelayMs = getRequestRetryDelayMs(attempt);
        if (elapsedMs + retryDelayMs >= totalBudgetMs) {
          throw new TransportRequestRetriesExhaustedError(label, elapsedMs, error);
        }
        if (session === this.session && !this.isHeartbeatFresh(REQUEST_RETRY_HEARTBEAT_FRESH_MS)) {
          recordStreamDiagnostic(STREAM_DIAGNOSTIC_NAMES.transportReconnect, "zombie-socket", {
            "rpc.reconnect.trigger": "zombie-socket",
            "rpc.request.label": label,
            "rpc.request.attempt": attempt,
            "error.message": formatErrorMessage(error),
          });
          await this.reconnect().catch(() => undefined);
        }
        await sleep(retryDelayMs);
      }
    }
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    await session.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let hasReceivedValue = false;
    let consecutiveFailures = 0;
    let retryAttempt = 0;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        try {
          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            {
              ...(options?.tag === undefined ? {} : { tag: options.tag }),
              ...(hasReceivedValue
                ? {
                    onStarted: () => {
                      try {
                        options?.onResubscribe?.();
                      } catch {
                        // Swallow reconnect hook errors so the stream can recover.
                      }
                    },
                  }
                : {}),
            },
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
              consecutiveFailures = 0;
              retryAttempt = 0;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
          if (options?.resubscribe === false) {
            if (active) {
              options.onComplete?.();
            }
            return;
          }
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            if (active && options?.resubscribe === false) {
              options.onComplete?.();
            }
            return;
          }

          if (options?.resubscribe === false) {
            options.onComplete?.();
            return;
          }

          retryAttempt += 1;
          const diagnosticTag = options?.tag ?? "unknown";
          recordStreamDiagnostic(STREAM_DIAGNOSTIC_NAMES.subscriptionRetry, diagnosticTag, {
            "rpc.stream.tag": diagnosticTag,
            "rpc.stream.attempt": retryAttempt,
            "error.message": formatErrorMessage(error),
          });
          try {
            options?.onRetry?.(error, retryAttempt);
          } catch {
            // Swallow retry hook errors so the stream can still recover.
          }

          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            // Non-transport failures must still resubscribe: the socket may
            // be healthy while a single stream died (server-side stream
            // error, teardown race), and nothing else will revive it.
            // Backoff keeps a persistent server error from becoming a hot
            // retry loop.
            consecutiveFailures += 1;
            console.warn("WebSocket RPC subscription failed", {
              error: formattedError,
              attempt: consecutiveFailures,
            });
            await sleep(
              Math.min(
                retryDelayMs * 2 ** Math.min(consecutiveFailures - 1, 10),
                MAX_SUBSCRIPTION_FAILURE_BACKOFF_MS,
              ),
            );
            continue;
          }

          if (!this.hasReportedTransportDisconnect) {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          await sleep(retryDelayMs);
        }
      }
    })();

    return () => {
      active = false;
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    recordStreamDiagnostic(STREAM_DIAGNOSTIC_NAMES.transportReconnect, "session-swap", {
      "rpc.reconnect.trigger": "session-swap",
      "rpc.heartbeat.fresh": this.isHeartbeatFresh(),
    });

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      clearAllTrackedRpcRequests();
      this.lastHeartbeatPongAt = 0;
      const previousSession = this.session;
      this.session = this.createSession();
      // Interrupt before closing: a half-open socket may never fail its
      // streams, and every subscribe loop stays parked on `completed` until
      // its stream ends. Cancelling here is what lets them pick up the new
      // session instead of waiting on the replaced one forever.
      this.cancelStreamsForSession(previousSession);
      await this.closeSession(previousSession);
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return this.lastHeartbeatPongAt > 0 && Date.now() - this.lastHeartbeatPongAt <= maxAgeMs;
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.closeSession(this.session);
  }

  private cancelStreamsForSession(session: TransportSession): void {
    const running = this.runningStreamsBySession.get(session);
    if (!running) {
      return;
    }
    this.runningStreamsBySession.delete(session);
    for (const registration of running) {
      try {
        registration.cancel();
      } catch {
        // A stream that already exited cannot be cancelled again; ignore.
      }
    }
  }

  private registerRunningStream(
    session: TransportSession,
    registration: RunningStreamRegistration,
  ): void {
    const running = this.runningStreamsBySession.get(session);
    if (running) {
      running.add(registration);
      return;
    }
    this.runningStreamsBySession.set(session, new Set([registration]));
  }

  private unregisterRunningStream(
    session: TransportSession,
    registration: RunningStreamRegistration,
  ): void {
    const running = this.runningStreamsBySession.get(session);
    if (!running) {
      return;
    }
    running.delete(registration);
    if (running.size === 0) {
      this.runningStreamsBySession.delete(session);
    }
  }

  private closeSession(session: TransportSession) {
    this.cancelStreamsForSession(session);
    this.intentionalCloseDepth += 1;
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      this.intentionalCloseDepth -= 1;
      session.runtime.dispose();
    });
  }

  private createSession(): TransportSession {
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        createWsRpcProtocolLayer(
          this.url,
          {
            ...this.lifecycleHandlers,
            isActive: () => !this.disposed && this.activeSessionId === sessionId,
            isCloseIntentional: () =>
              this.disposed ||
              this.intentionalCloseDepth > 0 ||
              this.lifecycleHandlers?.isCloseIntentional?.() === true,
            onHeartbeatPong: () => {
              this.lastHeartbeatPongAt = Date.now();
              this.lifecycleHandlers?.onHeartbeatPong?.();
            },
            onRequestStart: (info) => {
              this.lifecycleHandlers?.onRequestStart?.(info);
              if (!info.stream) {
                return;
              }
              for (const listener of this.streamRequestStartListeners) {
                listener(info);
              }
            },
          },
          this.protocolOptions,
        ),
        ClientTracingLive,
      ),
    );
    const clientScope = runtime.runSync(Scope.make());
    return {
      runtime,
      clientScope,
      clientPromise: runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient)),
    };
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    requestStart: {
      readonly tag?: string;
      readonly onStarted?: () => void;
    },
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    let requestStartListener: ((info: StreamRequestStartInfo) => void) | null = null;
    if (requestStart.onStarted) {
      requestStartListener = (info) => {
        if (!isActive() || !info.stream) {
          return;
        }
        if (requestStart.tag !== undefined && info.tag !== requestStart.tag) {
          return;
        }
        requestStart.onStarted?.();
        if (requestStartListener) {
          this.streamRequestStartListeners.delete(requestStartListener);
          requestStartListener = null;
        }
      };
      this.streamRequestStartListeners.add(requestStartListener);
    }
    const registration: RunningStreamRegistration = { cancel: NOOP };
    let hasExited = false;
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          hasExited = true;
          this.unregisterRunningStream(session, registration);
          if (requestStartListener) {
            this.streamRequestStartListeners.delete(requestStartListener);
            requestStartListener = null;
          }
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    registration.cancel = cancel;
    if (!hasExited) {
      this.registerRunningStream(session, registration);
    }

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
