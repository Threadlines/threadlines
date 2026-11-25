import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  /**
   * Buffer incoming notifications in `incomingNotifications`. Set to `false`
   * when using `onNotification` without reading `incomingNotifications`.
   * Defaults to `true`.
   */
  readonly bufferNotifications?: boolean;
  /**
   * Buffer incoming requests in `incomingRequests`. Set to `false` when using
   * `onRequest` without reading `incomingRequests`. Defaults to `true`.
   */
  readonly bufferRequests?: boolean;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
}

/** What a request does when its caller stops waiting for the answer. */
export interface CodexAppServerRequestOptions {
  /**
   * Runs, with the request's id, when the caller is interrupted after the
   * request went out and before its answer came: to have the server stop
   * the work too (`thread/sample/cancel`). It runs inside the interruption,
   * so it should hand off anything that waits.
   */
  readonly onAbandon?: (requestId: number) => Effect.Effect<void>;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
    options?: CodexAppServerRequestOptions,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string" || !("id" in value)) {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  Effect.try({
    try: () => `${JSON.stringify(message)}\n`,
    catch: (cause) =>
      new CodexError.CodexAppServerProtocolParseError({
        detail: "Failed to encode Codex App Server message",
        cause,
      }),
  });

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: (cause) =>
      new CodexError.CodexAppServerProtocolParseError({
        detail: "Failed to decode Codex App Server wire message",
        cause,
      }),
  });

const normalizeIncomingError = (error: unknown, detail: string): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        detail,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
    const incomingNotifications = yield* Queue.unbounded<CodexAppServerIncomingNotification>();
    const incomingRequests = yield* Queue.unbounded<CodexAppServerIncomingRequest>();
    const bufferNotifications = options.bufferNotifications !== false;
    const bufferRequests = options.bufferRequests !== false;
    const logIncoming = options.logIncoming === true;
    const logOutgoing = options.logOutgoing === true;
    const pending = yield* Ref.make(
      new Map<string, Deferred.Deferred<unknown, CodexError.CodexAppServerError>>(),
    );
    const nextRequestId = yield* Ref.make(1);
    let pendingChunks: Array<string> = [];
    const terminationHandled = yield* Ref.make(false);
    const scope = yield* Effect.scope;

    const logProtocol = (event: CodexAppServerProtocolLogEvent) =>
      options.logger?.(event) ??
      Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }));

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], (deferred) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
        if (logOutgoing) {
          yield* logProtocol({
            direction: "outgoing",
            stage: "decoded",
            payload: message,
          });
        }
        const encoded = yield* encodeWireMessage(message);
        if (logOutgoing) {
          yield* logProtocol({
            direction: "outgoing",
            stage: "raw",
            payload: encoded,
          });
        }
        yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (
        deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>,
      ) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const deferred = current.get(requestId);
        if (!deferred) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(deferred), next] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, (deferred) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(protocolError),
          ),
        );
      }
      return resolvePending(requestId, (deferred) => Deferred.succeed(deferred, response.result));
    };

    const handleRequest = (request: CodexAppServerIncomingRequest) => {
      const dispatch = options.onRequest
        ? options.onRequest(request).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                respondError(request.id, CodexError.normalizeToRequestError(error)),
              onSuccess: (result) => respond(request.id, result),
            }),
            // Server-initiated requests such as requestUserInput remain
            // open while the user decides. Keep reading the bidirectional
            // JSON-RPC stream so client-initiated requests (especially
            // turn/interrupt) can receive their responses in the meantime.
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        : Effect.void;
      return bufferRequests
        ? Queue.offer(incomingRequests, request).pipe(Effect.andThen(dispatch), Effect.asVoid)
        : dispatch;
    };

    const handleNotification = (notification: CodexAppServerIncomingNotification) => {
      const dispatch = options.onNotification ? options.onNotification(notification) : Effect.void;
      return bufferNotifications
        ? Queue.offer(incomingNotifications, notification).pipe(
            Effect.andThen(dispatch),
            Effect.asVoid,
          )
        : dispatch;
    };

    const routeMessage = (
      message: unknown,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (isIncomingRequest(message)) {
        return handleRequest(message);
      }
      if (isIncomingNotification(message)) {
        return handleNotification(message);
      }
      if (isIncomingResponse(message)) {
        return handleResponse(message);
      }
      return Effect.fail(
        new CodexError.CodexAppServerProtocolParseError({
          detail: "Received protocol message in an unknown shape",
        }),
      );
    };

    const handleLine = (line: string): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      if (!logIncoming) {
        return decodeWireMessage(line).pipe(Effect.flatMap(routeMessage));
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(line)),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              detail: error.detail,
              cause: error.cause,
            },
          }),
        ),
        Effect.flatMap(routeMessage),
      );
    };

    const drainChunkLines = (chunk: string): ReadonlyArray<string> => {
      let newlineIndex = chunk.indexOf("\n");
      if (newlineIndex === -1) {
        if (chunk.length > 0) {
          pendingChunks.push(chunk);
        }
        return [];
      }
      const lines: Array<string> = [];
      const firstSegment =
        pendingChunks.length > 0
          ? pendingChunks.join("") + chunk.slice(0, newlineIndex)
          : chunk.slice(0, newlineIndex);
      pendingChunks = [];
      lines.push(firstSegment.endsWith("\r") ? firstSegment.slice(0, -1) : firstSegment);
      let start = newlineIndex + 1;
      while ((newlineIndex = chunk.indexOf("\n", start)) !== -1) {
        const line = chunk.slice(start, newlineIndex);
        lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
        start = newlineIndex + 1;
      }
      if (start < chunk.length) {
        pendingChunks.push(chunk.slice(start));
      }
      return lines;
    };

    yield* options.stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => {
        const lines = drainChunkLines(chunk);
        return lines.length === 0
          ? Effect.void
          : Effect.forEach(lines, handleLine, { discard: true });
      }),
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(error, "Codex App Server input stream failed")),
          ),
        onSuccess: () =>
          Effect.suspend(() => {
            const line = pendingChunks.length > 0 ? pendingChunks.join("") : "";
            pendingChunks = [];
            const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
            return trimmed.trim().length === 0 ? Effect.void : handleLine(trimmed);
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(error)),
              onSuccess: () =>
                handleTermination(
                  () =>
                    options.terminationError ??
                    Effect.succeed(
                      new CodexError.CodexAppServerTransportError({
                        detail: "Codex App Server input stream ended",
                        cause: new Error("Codex App Server input stream ended"),
                      }),
                    ),
                ),
            }),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

    // Registered and sent in one step, so an interruption either finds the
    // request unsent or knows its id to clean up after.
    const request = (
      method: string,
      payload?: unknown,
      requestOptions?: CodexAppServerRequestOptions,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const requestId = yield* Ref.modify(
            nextRequestId,
            (current) => [current, current + 1] as const,
          );
          const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
          yield* Ref.update(pending, (current) =>
            new Map(current).set(String(requestId), deferred),
          );
          yield* offerOutgoing({
            id: requestId,
            method,
            ...(payload !== undefined ? { params: payload } : {}),
          }).pipe(
            Effect.catch((error) =>
              removePending(String(requestId)).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
          return yield* restore(Deferred.await(deferred)).pipe(
            Effect.onInterrupt(() =>
              removePending(String(requestId)).pipe(
                Effect.andThen(requestOptions?.onAbandon?.(requestId) ?? Effect.void),
              ),
            ),
          );
        }),
      );

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromQueue(incomingNotifications),
      incomingRequests: Stream.fromQueue(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);
