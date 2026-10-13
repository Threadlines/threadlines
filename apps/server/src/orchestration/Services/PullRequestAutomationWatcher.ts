import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Watches the pull requests of threads that asked for it. With "Fix failing
 * checks and review comments" on, it starts a turn when a check has just failed,
 * a reviewer has just said something, or the merge queue has just given the
 * pull request back after its own run of the checks failed, and looks as soon
 * as that switch comes on, so a failure already there goes to the agent
 * straight away. Once the agent has had its turn at a merge queue failure, it
 * arms the host's merge again, so the queue takes the pull request back when
 * its checks pass. With "Merge when checks pass" held by the server (a host
 * that cannot arm the merge itself), it merges once the checks pass and the
 * host's rules allow it, and looks as soon as that switch comes on too, so a
 * pull request that is already green merges straight away.
 *
 * It looks every two minutes, and every twenty seconds, for up to half an
 * hour, at an idle thread whose checks are in motion (one running, or a push
 * whose checks are not listed yet), the same pace the composer's checks chip
 * keeps. It reads the thread again just before starting a turn, so a message
 * the user sent meanwhile goes alone. A switch coming on is answered by a look
 * at that thread alone, ahead of the rest of a sweep in flight, so the answer
 * does not slow down as more threads are armed. A watched thread gets the same
 * look as its turn ends, when the agent has most likely just pushed, and while
 * the host still answers for the commit before a push, its checks are neither
 * sent to the agent nor merged on. A thread with nothing to watch
 * (no pull request on its branch, or one that is merged or closed) is left
 * alone for a while, longer the longer it has sat untouched and at most half an
 * hour, and looked at again as soon as it changes.
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
