/**
 * LaunchGate — keeps an agent's processes apart from the work that needs
 * them all gone: signing in or out (they hold the old credentials in
 * memory), or removing the agent's files.
 *
 * Every agent process holds the gate while it runs. Closing it stops new
 * ones from starting and waits for the holds to reach zero.
 *
 * @module provider/managedRuntime/LaunchGate
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const DRAIN_TIMEOUT_MS = 45_000;
const DRAIN_POLL = Duration.millis(250);

export interface LaunchGate {
  /** Closed: nothing new may start. */
  busy: boolean;
  /** Processes running now. */
  holds: number;
}

export const makeLaunchGate = (): LaunchGate => ({ busy: false, holds: 0 });

/**
 * Holds the gate until the scope closes (give it the process's scope), or
 * fails with `whenClosed()` while the gate is closed. Checked and taken in
 * one step, so a close can wait the process out.
 */
export const holdLaunchGate = <E>(
  gate: LaunchGate,
  whenClosed: () => E,
): Effect.Effect<void, E, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      if (gate.busy) return Effect.fail(whenClosed());
      gate.holds += 1;
      return Effect.void;
    }),
    () =>
      Effect.sync(() => {
        gate.holds -= 1;
      }),
  );

export interface CloseLaunchGateOptions<E> {
  /** The failure when something else already has the gate closed. */
  readonly whenAlreadyClosed: () => E;
  /** The failure when processes are still running after the wait. */
  readonly whenStillHeld: () => E;
  /**
   * Stops what can be stopped. Runs on every poll: a process that was still
   * starting when the gate closed only becomes stoppable once it has
   * registered.
   */
  readonly stop: Effect.Effect<void>;
  /** Runs once, when there is something to wait for. */
  readonly onWaiting?: Effect.Effect<void>;
}

/**
 * Runs `use` with the gate closed and every hold gone, then reopens it. Fails
 * without running `use` when the gate is already closed, or when the holds
 * don't drain in time.
 */
export const withLaunchGateClosed = <A, E, E2>(
  gate: LaunchGate,
  options: CloseLaunchGateOptions<E2>,
  use: Effect.Effect<A, E>,
): Effect.Effect<A, E | E2> => {
  const drain = Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + DRAIN_TIMEOUT_MS;
    let told = false;
    while (true) {
      yield* options.stop;
      if (gate.holds <= 0) return;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.fail(options.whenStillHeld());
      }
      if (!told) {
        told = true;
        if (options.onWaiting) yield* options.onWaiting;
      }
      yield* Effect.sleep(DRAIN_POLL);
    }
  });
  return Effect.acquireUseRelease(
    Effect.suspend(() => {
      if (gate.busy) return Effect.fail(options.whenAlreadyClosed());
      gate.busy = true;
      return Effect.void;
    }),
    () => drain.pipe(Effect.andThen(use)),
    () =>
      Effect.sync(() => {
        gate.busy = false;
      }),
  );
};
