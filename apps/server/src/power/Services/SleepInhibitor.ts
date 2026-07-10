/**
 * SleepInhibitor - Turn-scoped host sleep inhibition service interface.
 *
 * Owns a background worker that watches provider runtime activity and holds
 * an OS idle-sleep power assertion while any thread has a turn in flight, so
 * long-running turns are not suspended when the machine idles. The display
 * still dims and locks on its normal schedule.
 *
 * @module SleepInhibitor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * SleepInhibitorShape - Service API for turn-scoped sleep inhibition.
 */
export interface SleepInhibitorShape {
  /**
   * Start reacting to provider runtime events and settings changes.
   *
   * The returned effect must be run in a scope; the assertion is released
   * and worker fibers are finalized when that scope closes.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * SleepInhibitor - Service tag for the sleep inhibition worker.
 */
export class SleepInhibitor extends Context.Service<SleepInhibitor, SleepInhibitorShape>()(
  "threadlines/power/Services/SleepInhibitor",
) {}
