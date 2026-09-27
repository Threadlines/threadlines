/**
 * One lifecycle per room request, whoever is waiting on it.
 *
 * An ask or a review waits for its answer inside the MCP call that made it.
 * The request itself must not live in that call: a provider can retry a tool
 * call, drop its connection, or make the same call twice. So a request runs
 * in the registry's own scope, and HTTP calls attach to it as waiters:
 *
 * - an identical call while the request is open joins it instead of starting
 *   another (the caller supplies the key that says what "identical" means);
 * - a waiter that goes away (its call interrupted) only leaves;
 * - when the last waiter leaves before the request is over, the request is
 *   told it was abandoned, so it can stop what it started;
 * - once the request is over it leaves the registry, and the same call again
 *   is a new request.
 *
 * In memory only: after a restart there is nobody left to answer, and the
 * orchestration core cancels open asks and reviews on startup.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";

interface OpenRequest {
  readonly result: Deferred.Deferred<unknown>;
  readonly abandoned: Deferred.Deferred<void>;
  waiters: number;
  over: boolean;
}

export interface RoomRequestRegistry {
  /**
   * Wait for the open request under `key`, or open it with `run`. `run` gets
   * an effect that completes if every waiter leaves before it finishes.
   */
  readonly join: <A>(
    key: string,
    run: (abandoned: Effect.Effect<void>) => Effect.Effect<A>,
  ) => Effect.Effect<A>;
  /** Requests open right now, for tests and diagnostics. */
  readonly openCount: Effect.Effect<number>;
}

/** Requests run in `scope`: closing it (server shutdown) interrupts them. */
export function makeRoomRequestRegistry(scope: Scope.Scope): RoomRequestRegistry {
  const open = new Map<string, OpenRequest>();

  const leave = (key: string, request: OpenRequest) =>
    Effect.sync(() => {
      request.waiters -= 1;
      if (request.waiters === 0 && !request.over) {
        // Nobody is waiting: a later identical call starts afresh.
        if (open.get(key) === request) open.delete(key);
        Deferred.doneUnsafe(request.abandoned, Exit.void);
      }
    });

  const join = <A>(key: string, run: (abandoned: Effect.Effect<void>) => Effect.Effect<A>) =>
    Effect.acquireUseRelease(
      // Uninterruptible: a waiter is counted exactly when it will be released.
      Effect.gen(function* () {
        const existing = open.get(key);
        if (existing !== undefined) {
          existing.waiters += 1;
          return existing;
        }
        const request: OpenRequest = {
          result: Deferred.makeUnsafe<unknown>(),
          abandoned: Deferred.makeUnsafe<void>(),
          waiters: 1,
          over: false,
        };
        open.set(key, request);
        // However it ends, the server shutting down included, it leaves the
        // registry and its waiters hear how.
        yield* Effect.interruptible(run(Deferred.await(request.abandoned))).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              request.over = true;
              if (open.get(key) === request) open.delete(key);
              Deferred.doneUnsafe(request.result, exit);
            }),
          ),
          Effect.forkIn(scope),
        );
        return request;
      }),
      (request) => Deferred.await(request.result) as Effect.Effect<A>,
      (request) => leave(key, request),
    );

  return { join, openCount: Effect.sync(() => open.size) };
}
