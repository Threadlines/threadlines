import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Watches the pull requests of threads whose "Fix failing checks and review
 * comments" switch is on, and starts a turn when a check has just failed or a
 * reviewer has just said something.
 *
 * It runs only while the server does: the baseline it compares against lives in
 * memory, so a restart re-observes rather than replaying what it missed.
 */
export interface PullRequestAutoFixWatcherShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Runs one sweep and answers how many turns it started. */
  readonly sweepNow: () => Effect.Effect<number, never>;
}

export class PullRequestAutoFixWatcher extends Context.Service<
  PullRequestAutoFixWatcher,
  PullRequestAutoFixWatcherShape
>()("threadlines/orchestration/Services/PullRequestAutoFixWatcher") {}
