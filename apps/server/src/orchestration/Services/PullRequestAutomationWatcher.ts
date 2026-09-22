import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Watches the pull requests of threads that asked for it. With "Fix failing
 * checks and review comments" on, it starts a turn when a check has just failed
 * or a reviewer has just said something. With "Merge when checks pass" held by
 * the server (a host that cannot arm the merge itself), it merges once the
 * checks pass and the host's rules allow it.
 *
 * It runs only while the server does: the auto-fix baseline lives in memory, so
 * a restart re-observes rather than replaying what it missed. The merge switch
 * lives in the read model and survives a restart.
 */
export interface PullRequestAutomationWatcherShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Runs one sweep and answers how many turns it started. */
  readonly sweepNow: () => Effect.Effect<number, never>;
}

export class PullRequestAutomationWatcher extends Context.Service<
  PullRequestAutomationWatcher,
  PullRequestAutomationWatcherShape
>()("threadlines/orchestration/Services/PullRequestAutomationWatcher") {}
