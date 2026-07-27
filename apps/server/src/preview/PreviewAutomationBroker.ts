/**
 * Carries a tool call from a provider session to the browser tab the user has
 * open, and the answer back.
 *
 * The server cannot touch a page. The page lives in a webview owned by the
 * desktop main process, and the only thing that can reach it is the renderer
 * showing the browser panel. So a tool call becomes a request parked here,
 * handed down the client's subscription, and settled when the client answers.
 *
 * Everything difficult about that is the failure cases, which is most of what
 * this file is: nobody is showing the thread, the client disappeared halfway
 * through, the page never answered, the answer is bigger than the conversation
 * can hold. Each one is a different sentence to the agent, because each one has
 * a different next move.
 */
import {
  PreviewAutomationDisconnectedError,
  PreviewAutomationNoHostError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedError,
  type PreviewAutomationError,
  type PreviewAutomationHost,
  type PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type ThreadId,
} from "@threadlines/contracts";
import { PreviewAutomationExecutionError } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Long enough for a page that is still fetching, short enough that a wedged
 * client does not hold a turn open indefinitely.
 */
export const PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS = 20_000;
/**
 * A snapshot of a large page, or an evaluate that returned the DOM, can be
 * bigger than the conversation it is going into. Refused rather than truncated:
 * half a result read as a whole one is worse than an error that says to narrow
 * the request.
 */
export const PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES = 512_000;

export interface PreviewAutomationInvokeInput {
  readonly threadId: ThreadId;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly timeoutMs?: number | undefined;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    /**
     * Registers a client as the browser for a thread and hands back the
     * requests meant for it. Scoped: leaving the scope unregisters, which is
     * what makes closing the panel or dropping the socket the same event.
     */
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationRequest>, never, Scope.Scope>;
    readonly respond: (response: PreviewAutomationResponse) => Effect.Effect<void>;
    readonly invoke: (
      input: PreviewAutomationInvokeInput,
    ) => Effect.Effect<unknown, PreviewAutomationError>;
    /** Whether a thread has a browser standing by, for callers that would
     *  rather not offer a tool that cannot work. */
    readonly hasHost: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("@threadlines/server/preview/PreviewAutomationBroker") {}

/** The broker itself, for callers that hold one rather than resolve it. */
export type PreviewAutomationBrokerService = PreviewAutomationBroker["Service"];

interface HostConnection {
  readonly hostId: string;
  readonly operations: ReadonlySet<PreviewAutomationOperation>;
  readonly queue: Queue.Queue<PreviewAutomationRequest>;
}

interface PendingRequest {
  readonly threadId: ThreadId;
  readonly operation: PreviewAutomationOperation;
  readonly hostId: string;
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
}

export const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  // Plain maps rather than a SynchronizedRef: every mutation below happens in
  // one synchronous run with no yield inside it, so there is no interleaving to
  // protect against, and a ref would only add ceremony.
  const hosts = new Map<ThreadId, HostConnection>();
  const pending = new Map<string, PendingRequest>();
  let requestSequence = 0;

  /** Settles everything still waiting on a host that has gone. */
  const failPendingForHost = (threadId: ThreadId, hostId: string) => {
    const orphaned: PendingRequest[] = [];
    for (const [requestId, entry] of pending) {
      if (entry.threadId === threadId && entry.hostId === hostId) {
        pending.delete(requestId);
        orphaned.push(entry);
      }
    }
    return Effect.forEach(
      orphaned,
      (entry) =>
        Deferred.fail(
          entry.deferred,
          new PreviewAutomationDisconnectedError({ operation: entry.operation }),
        ),
      { discard: true },
    );
  };

  const disconnect = (threadId: ThreadId, connection: HostConnection) =>
    Effect.suspend(() => {
      // Only if it is still the registered one: a reconnect may already have
      // replaced it, and tearing down the newcomer on the old scope's way out
      // would leave the thread with no browser at all.
      if (hosts.get(threadId) === connection) {
        hosts.delete(threadId);
      }
      return failPendingForHost(threadId, connection.hostId).pipe(
        Effect.andThen(Queue.shutdown(connection.queue)),
        Effect.asVoid,
      );
    });

  const connect = Effect.fn("PreviewAutomationBroker.connect")(function* (
    host: PreviewAutomationHost,
  ) {
    const queue = yield* Queue.unbounded<PreviewAutomationRequest>();
    const connection: HostConnection = {
      hostId: host.hostId,
      operations: new Set(host.operations),
      queue,
    };

    // One browser per thread. A second connection is a reload or a second
    // window, and the newest one is the one the user is looking at.
    const displaced = hosts.get(host.threadId);
    if (displaced !== undefined) {
      yield* disconnect(host.threadId, displaced);
    }
    hosts.set(host.threadId, connection);

    yield* Effect.addFinalizer(() => disconnect(host.threadId, connection));
    return Stream.fromQueue(queue);
  });

  const respond = Effect.fn("PreviewAutomationBroker.respond")(function* (
    response: PreviewAutomationResponse,
  ) {
    const entry = pending.get(response.requestId);
    // A response with nothing waiting is a request that already timed out or
    // whose host was replaced. Dropping it is right; the caller has moved on.
    if (entry === undefined) {
      return;
    }
    pending.delete(response.requestId);
    if (response.error !== undefined) {
      yield* Deferred.fail(
        entry.deferred,
        new PreviewAutomationExecutionError({
          operation: entry.operation,
          detail: response.error,
        }),
      );
      return;
    }
    yield* Deferred.succeed(entry.deferred, response.result ?? null);
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* (
    input: PreviewAutomationInvokeInput,
  ) {
    const connection = hosts.get(input.threadId);
    if (connection === undefined) {
      return yield* Effect.fail(
        new PreviewAutomationNoHostError({
          threadId: input.threadId,
          operation: input.operation,
        }),
      );
    }
    // Asked before sending rather than discovered by silence: a client that
    // cannot do this should say so as an answer, not as a twenty second wait.
    if (!connection.operations.has(input.operation)) {
      return yield* Effect.fail(
        new PreviewAutomationUnsupportedError({ operation: input.operation }),
      );
    }

    requestSequence += 1;
    const requestId = `${input.threadId}:${requestSequence}`;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    pending.set(requestId, {
      threadId: input.threadId,
      operation: input.operation,
      hostId: connection.hostId,
      deferred,
    });

    const timeoutMs = input.timeoutMs ?? PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS;
    const result = yield* Queue.offer(connection.queue, {
      requestId,
      operation: input.operation,
      input: input.input as PreviewAutomationRequest["input"],
    }).pipe(
      Effect.andThen(Deferred.await(deferred)),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(new PreviewAutomationTimeoutError({ operation: input.operation, timeoutMs })),
      }),
      // Whatever settled it, this request is over. Left behind, its entry would
      // catch a late response meant for nobody and hold the deferred forever.
      Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
    );

    const bytes = measure(result);
    if (bytes > PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES) {
      return yield* Effect.fail(
        new PreviewAutomationResultTooLargeError({
          operation: input.operation,
          bytes,
          limitBytes: PREVIEW_AUTOMATION_RESULT_LIMIT_BYTES,
        }),
      );
    }
    return result;
  });

  const service: PreviewAutomationBrokerService = {
    connect,
    respond,
    invoke,
    hasHost: (threadId: ThreadId) => Effect.sync(() => hosts.has(threadId)),
  };
  return service;
});

/** Byte length of the result as it will actually travel, not character count. */
function measure(result: unknown): number {
  if (result === null || result === undefined) {
    return 0;
  }
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
  } catch {
    // Unserialisable is a different problem, and the caller will hit it next.
    return 0;
  }
}

export const layer = Layer.effect(PreviewAutomationBroker)(make);
