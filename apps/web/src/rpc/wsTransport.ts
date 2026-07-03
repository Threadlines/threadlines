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
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            console.warn("WebSocket RPC subscription failed", {
              error: formattedError,
            });
            return;
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

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      clearAllTrackedRpcRequests();
      this.lastHeartbeatPongAt = 0;
      const previousSession = this.session;
      this.session = this.createSession();
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

  private closeSession(session: TransportSession) {
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
