/**
 * ThreadPullRequestLinker - notices when a thread's agent opens a pull request
 * on another branch, and links it to the thread.
 *
 * An agent asked to put something in "its own PR" often makes it from a
 * temporary checkout and reports it with a link. The thread's own pull
 * request is found from its branch; this is how the others become the
 * thread's too, so its rows, its Pull request tab and its merge switch reach
 * them.
 *
 * @module ThreadPullRequestLinker
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadPullRequestLinkerShape {
  /** Starts reading finished assistant messages; run in a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once every message seen so far has been read. For tests. */
  readonly drain: Effect.Effect<void>;
}

export class ThreadPullRequestLinker extends Context.Service<
  ThreadPullRequestLinker,
  ThreadPullRequestLinkerShape
>()("threadlines/orchestration/Services/ThreadPullRequestLinker") {}
