import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * "Continue at reset" (OrchestrationSession.continueAtReset): continues the
 * threads a usage limit stopped once the limit resets, on the computer each
 * thread runs on. A limit that resets before its time (the user spent a limit
 * reset) continues them then: within a pass of the account's next usage
 * reading showing room again.
 */
export interface ContinueAtResetSweeperShape {
  /** Continue what is due now, then check every 30 seconds. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** One pass now: how many threads it continued. */
  readonly sweepNow: () => Effect.Effect<number, never>;
}

export class ContinueAtResetSweeper extends Context.Service<
  ContinueAtResetSweeper,
  ContinueAtResetSweeperShape
>()("threadlines/orchestration/Services/ContinueAtResetSweeper") {}
