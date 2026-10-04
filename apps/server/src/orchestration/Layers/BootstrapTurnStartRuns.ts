/**
 * BootstrapTurnStartRuns - one bootstrap turn start per command id.
 *
 * A bootstrap turn start (create the thread, cut a worktree, launch the setup
 * script, start the turn) is several engine dispatches under one client
 * command id, so the engine's per-command receipts cannot make it idempotent
 * on their own. The client re-sends a command whose socket dropped or whose
 * response was slow, and a second run would fail on `thread.create` after the
 * first run already created the thread.
 *
 * This service runs each command id once. The run is forked into the
 * service's own scope so a dropped socket does not abort a half-done
 * bootstrap, and a retry that arrives while it is still running joins that
 * run's result. Retries that arrive after the run finished are answered from
 * the command receipt by the caller.
 *
 * `makeSingleFlight` is the same rule for any key, also used for child
 * thread setup (ThreadBootstrap.startChild), where two overlapping runs of
 * one request would race each other to the same worktree.
 *
 * @module BootstrapTurnStartRuns
 */
import type { CommandId, OrchestrationDispatchCommandError } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

export interface BootstrapTurnStartResult {
  readonly sequence: number;
}

type BootstrapTurnStartRun = Effect.Effect<
  BootstrapTurnStartResult,
  OrchestrationDispatchCommandError
>;

export interface BootstrapTurnStartRunsShape {
  /** Run `bootstrap` for `commandId`, or join the run already in flight for it. */
  readonly run: (commandId: CommandId, bootstrap: BootstrapTurnStartRun) => BootstrapTurnStartRun;
}

export class BootstrapTurnStartRuns extends Context.Service<
  BootstrapTurnStartRuns,
  BootstrapTurnStartRunsShape
>()("threadlines/orchestration/BootstrapTurnStartRuns") {}

/** Runs keyed by `K`: one in flight per key, the rest join it. */
export interface SingleFlight<K, A, E> {
  readonly run: (key: K, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/**
 * At most one run per key at a time, forked into the enclosing scope so the
 * caller going away does not abort it; a call while it runs joins its result.
 * A call after it finished starts a new run, so the run itself must be safe
 * to repeat.
 */
export const makeSingleFlight = <K, A, E>() =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const inflight = new Map<K, Deferred.Deferred<A, E>>();

    const run = (key: K, effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const existing = inflight.get(key);
        if (existing) {
          return yield* Deferred.await(existing);
        }
        const result = yield* Deferred.make<A, E>();
        inflight.set(key, result);
        const forget = Effect.sync(() => {
          if (inflight.get(key) === result) inflight.delete(key);
        });
        yield* effect.pipe(
          Effect.exit,
          // Dropped once the run is over (and, on success, after the engine
          // wrote the receipt), so a retry never finds neither a run in
          // flight nor a receipt; and dropped before its callers hear, so
          // one that retries straight after a failure runs again rather than
          // joining the run that failed.
          Effect.flatMap((exit) =>
            forget.pipe(
              Effect.andThen(
                Exit.isSuccess(exit)
                  ? Deferred.succeed(result, exit.value)
                  : Deferred.failCause(result, exit.cause),
              ),
            ),
          ),
          Effect.ensuring(forget),
          Effect.forkIn(scope),
        );
        return yield* Deferred.await(result);
      });

    return { run } satisfies SingleFlight<K, A, E>;
  });

export const makeBootstrapTurnStartRuns = Effect.gen(function* () {
  const runs = yield* makeSingleFlight<
    CommandId,
    BootstrapTurnStartResult,
    OrchestrationDispatchCommandError
  >();
  return { run: runs.run } satisfies BootstrapTurnStartRunsShape;
});

export const BootstrapTurnStartRunsLive = Layer.effect(
  BootstrapTurnStartRuns,
  makeBootstrapTurnStartRuns,
);
