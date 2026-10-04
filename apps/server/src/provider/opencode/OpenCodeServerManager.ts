/**
 * OpenCodeServerManager — one OpenCode 2 server per provider instance, shared
 * by every session, the snapshot probe and text generation.
 *
 * The server starts on first use and stops after it has been idle (no leases)
 * for a while. Each start is a *generation*: if the process dies, the
 * generation ends, `ServerGone` is published, and the next use starts a new
 * one. Sessions survive that, because OpenCode keeps them in its database.
 *
 * The manager also owns the single `/api/event` subscription. OpenCode's stream
 * is volatile: events sent while it is down are lost, a slow reader is cut off,
 * and nothing is replayed. So every (re)subscription publishes `StreamOpened`,
 * and consumers treat it as "re-read whatever you were tracking".
 *
 * @module provider/opencode/OpenCodeServerManager
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { OpenCodeError, openCodeErrorDetail } from "./OpenCodeClient.ts";
import { decodeOpenCodeFrame, type OpenCodeEvent } from "./OpenCodeEvents.ts";
import {
  connectOpenCodeServer,
  type OpenCodeServer,
  startOpenCodeServer,
} from "./OpenCodeServer.ts";

const DEFAULT_IDLE_TTL = Duration.minutes(10);
/** OpenCode sends a heartbeat every 15s; three missed ones mean a dead stream. */
const HEARTBEAT_CHECK = Duration.seconds(15);
const MISSED_HEARTBEATS_LIMIT = 3;
const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000] as const;

export interface OpenCodeActiveServer {
  readonly generation: number;
  readonly server: OpenCodeServer;
  /**
   * Resolves once this generation's event stream is subscribed. Anything that
   * starts work must wait for it: events sent before the subscription are lost.
   */
  readonly streamReady: Effect.Effect<void>;
}

export type OpenCodeServerSignal =
  /** A (re)subscription is live; anything tracked from earlier frames may be stale. */
  | { readonly _tag: "StreamOpened"; readonly generation: number }
  | { readonly _tag: "Event"; readonly generation: number; readonly event: OpenCodeEvent }
  /** A frame of a type the driver acts on no longer matched its schema. */
  | { readonly _tag: "Malformed"; readonly generation: number; readonly type: string }
  /** The server is gone: stopped while idle, or its process exited. */
  | {
      readonly _tag: "ServerGone";
      readonly generation: number;
      readonly unexpected: boolean;
      readonly detail: string;
    };

export interface OpenCodeServerManagerShape {
  /** The running server, starting one if needed. Does not keep it alive on its own. */
  readonly server: Effect.Effect<OpenCodeActiveServer, OpenCodeError>;
  /** Keeps the server from idling out until the caller's scope closes. */
  readonly lease: Effect.Effect<void, never, Scope.Scope>;
  /**
   * The installed binary changed (an update): start a fresh server as soon as
   * nothing is using the current one, so new work runs the new version.
   */
  readonly retire: Effect.Effect<void>;
  /** `lease` + `server`, for one-shot work. */
  readonly withServer: <A, E, R>(
    use: (active: OpenCodeActiveServer) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OpenCodeError, Exclude<R, Scope.Scope>>;
  /** Every signal from every generation, for as long as the manager lives. */
  readonly signals: Stream.Stream<OpenCodeServerSignal>;
}

export interface OpenCodeServerManagerOptions {
  /** A function is asked at each start, so an install made meanwhile is found. */
  readonly binaryPath: string | (() => string);
  readonly environment: NodeJS.ProcessEnv;
  /** Settings `serverUrl`: reach this server instead of starting one. */
  readonly externalServer?: { readonly url: string; readonly password: string | undefined };
  readonly idleTtl?: Duration.Duration;
}

interface Generation {
  readonly active: OpenCodeActiveServer;
  readonly scope: Scope.Closeable;
  readonly streamOpened: Deferred.Deferred<void>;
  /** Superseded by an update; ends when its last lease is released. */
  retired: boolean;
}

/**
 * Builds the manager in the caller's scope; closing that scope stops the
 * server. Create it before anything that uses the server, so their
 * finalizers (which may still talk to it) run first.
 */
export const makeOpenCodeServerManager = (
  options: OpenCodeServerManagerOptions,
): Effect.Effect<
  OpenCodeServerManagerShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const managerScope = yield* Scope.Scope;
    const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const idleTtl = options.idleTtl ?? DEFAULT_IDLE_TTL;
    const signals = yield* PubSub.unbounded<OpenCodeServerSignal>();
    const startLock = yield* Semaphore.make(1);
    // Taking a lease and deciding that nothing holds one (idle stop, retire)
    // are serialized, so a session that just took a lease never gets a
    // server that is being stopped under it.
    const leaseLock = yield* Semaphore.make(1);
    const currentRef = yield* Ref.make<Generation | undefined>(undefined);
    const leasesRef = yield* Ref.make(0);
    const idleFiberRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
    let nextGeneration = 1;

    const publish = (signal: OpenCodeServerSignal) =>
      PubSub.publish(signals, signal).pipe(Effect.asVoid);

    /** Ends a generation once; later calls for the same one are no-ops. */
    const endGeneration = (generation: Generation, unexpected: boolean, detail: string) =>
      Effect.gen(function* () {
        const ended = yield* Ref.modify(currentRef, (current) =>
          current === generation ? [true, undefined] : [false, current],
        );
        if (!ended) return;
        yield* publish({
          _tag: "ServerGone",
          generation: generation.active.generation,
          unexpected,
          detail,
        });
        yield* Scope.close(generation.scope, Exit.void);
      });

    const runSubscription = (generation: Generation, onOpened: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        let sawActivity = false;
        const iterable = generation.active.server.client.event.subscribe({
          signal: controller.signal,
          onActivity: () => {
            sawActivity = true;
          },
        });
        // A stream that stops sending heartbeats is dead even if the socket
        // is still open; aborting it makes the read below end.
        yield* Effect.gen(function* () {
          let missed = 0;
          while (true) {
            yield* Effect.sleep(HEARTBEAT_CHECK);
            missed = sawActivity ? 0 : missed + 1;
            sawActivity = false;
            if (missed >= MISSED_HEARTBEATS_LIMIT) {
              controller.abort();
              return;
            }
          }
        }).pipe(Effect.forkScoped);

        const generationId = generation.active.generation;
        yield* Stream.fromAsyncIterable(
          iterable,
          (cause) =>
            new OpenCodeError({
              operation: "event stream",
              detail: openCodeErrorDetail(cause),
              cause,
            }),
        ).pipe(
          Stream.runForEach((frame) => {
            const decoded = decodeOpenCodeFrame(frame);
            switch (decoded._tag) {
              case "Ignored":
                return Effect.void;
              case "Malformed":
                return Effect.logWarning("OpenCode event no longer matches its schema", {
                  type: decoded.type,
                }).pipe(
                  Effect.andThen(
                    publish({ _tag: "Malformed", generation: generationId, type: decoded.type }),
                  ),
                );
              case "Event":
                return decoded.event.type === "server.connected"
                  ? onOpened.pipe(
                      Effect.andThen(Deferred.succeed(generation.streamOpened, undefined)),
                      Effect.andThen(publish({ _tag: "StreamOpened", generation: generationId })),
                    )
                  : publish({ _tag: "Event", generation: generationId, event: decoded.event });
            }
          }),
        );
      }).pipe(Effect.scoped);

    /** Keeps one subscription open for the generation's whole life. */
    const pump = (generation: Generation) =>
      Effect.gen(function* () {
        let failures = 0;
        while (true) {
          const exit = yield* Effect.exit(
            runSubscription(
              generation,
              Effect.sync(() => {
                failures = 0;
              }),
            ),
          );
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
          const delay = RECONNECT_DELAYS[Math.min(failures, RECONNECT_DELAYS.length - 1)]!;
          failures += 1;
          if (Exit.isFailure(exit)) {
            yield* Effect.logDebug("OpenCode event stream ended; reconnecting", {
              generation: generation.active.generation,
              cause: Cause.pretty(exit.cause),
            });
          }
          yield* Effect.sleep(Duration.millis(delay));
        }
      });

    const scheduleIdleStop = Effect.gen(function* () {
      const fiber = yield* Effect.sleep(idleTtl).pipe(
        Effect.andThen(
          leaseLock.withPermit(
            Effect.gen(function* () {
              if ((yield* Ref.get(leasesRef)) > 0) return;
              const current = yield* Ref.get(currentRef);
              if (current) yield* endGeneration(current, false, "Stopped after being idle.");
            }),
          ),
        ),
        Effect.forkIn(managerScope),
      );
      const previous = yield* Ref.getAndSet(idleFiberRef, fiber);
      if (previous) yield* Fiber.interrupt(previous);
    });

    const cancelIdleStop = Ref.getAndSet(idleFiberRef, undefined).pipe(
      Effect.flatMap((fiber) => (fiber ? Fiber.interrupt(fiber) : Effect.void)),
    );

    /**
     * Only the startup itself can be interrupted. Once the server answers,
     * installing the generation (current ref, event pump, crash watch) runs to
     * completion, so a cancelled caller never leaves a generation without its
     * crash watch. The scope is not a child of the manager's: closing order is
     * the manager finalizer's, registered when the manager was built.
     */
    const startGeneration = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const server = yield* restore(
          options.externalServer
            ? connectOpenCodeServer(options.externalServer)
            : startOpenCodeServer({
                binaryPath:
                  typeof options.binaryPath === "function"
                    ? options.binaryPath()
                    : options.binaryPath,
                environment: options.environment,
              }),
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(services),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const streamOpened = yield* Deferred.make<void>();
        const generation: Generation = {
          active: {
            generation: nextGeneration++,
            server,
            streamReady: Deferred.await(streamOpened),
          },
          scope,
          streamOpened,
          retired: false,
        };
        yield* Ref.set(currentRef, generation);
        yield* pump(generation).pipe(Effect.forkIn(scope));
        // Ending a generation closes its scope, which interrupts the fibers in
        // it; the watcher hands the ending to the manager scope so it never
        // waits on its own interruption.
        yield* server.exited.pipe(
          Effect.andThen(
            endGeneration(generation, true, "The OpenCode server stopped unexpectedly.").pipe(
              Effect.forkIn(managerScope),
            ),
          ),
          Effect.forkIn(scope),
        );
        // Started without a lease (a bare `server` call): it still idles out.
        if ((yield* Ref.get(leasesRef)) === 0) yield* scheduleIdleStop;
        return generation.active;
      }),
    );

    const server: OpenCodeServerManagerShape["server"] = Effect.gen(function* () {
      const current = yield* Ref.get(currentRef);
      if (current) return current.active;
      return yield* startLock.withPermit(
        Effect.gen(function* () {
          const raced = yield* Ref.get(currentRef);
          return raced ? raced.active : yield* startGeneration;
        }),
      );
    });

    const lease: OpenCodeServerManagerShape["lease"] = Effect.acquireRelease(
      leaseLock.withPermit(
        Ref.update(leasesRef, (count) => count + 1).pipe(Effect.andThen(cancelIdleStop)),
      ),
      () =>
        leaseLock.withPermit(
          Ref.updateAndGet(leasesRef, (count) => Math.max(0, count - 1)).pipe(
            Effect.flatMap((count) =>
              count > 0
                ? Effect.void
                : Ref.get(currentRef).pipe(
                    Effect.flatMap((current) =>
                      current?.retired
                        ? endGeneration(current, false, "Restarted to run the updated OpenCode.")
                        : scheduleIdleStop,
                    ),
                  ),
            ),
          ),
        ),
    );

    const retire: OpenCodeServerManagerShape["retire"] = leaseLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(currentRef);
        if (!current || current.active.server.external) return;
        current.retired = true;
        if ((yield* Ref.get(leasesRef)) === 0) {
          yield* endGeneration(current, false, "Restarted to run the updated OpenCode.");
        }
      }),
    );

    const withServer: OpenCodeServerManagerShape["withServer"] = (use) =>
      Effect.scoped(lease.pipe(Effect.andThen(server), Effect.flatMap(use)));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* cancelIdleStop;
        const current = yield* Ref.get(currentRef);
        if (current) yield* endGeneration(current, false, "Provider instance stopped.");
        yield* PubSub.shutdown(signals);
      }),
    );

    return {
      server,
      lease,
      retire,
      withServer,
      signals: Stream.fromPubSub(signals),
    } satisfies OpenCodeServerManagerShape;
  });
