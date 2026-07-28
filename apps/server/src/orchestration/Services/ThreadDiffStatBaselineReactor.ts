/**
 * ThreadDiffStatBaselineReactor - Clean-checkout observer for thread diff stats.
 *
 * Watches the local git status the VCS broadcaster computes and, whenever a
 * checkout has no uncommitted changes, advances the diff-rollup baseline of
 * every thread working in it. That is what makes the sidebar's per-thread +/-
 * badge reset on commit instead of growing without bound.
 *
 * @module ThreadDiffStatBaselineReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadDiffStatBaselineReactorShape - Service API for the reactor lifecycle.
 */
export interface ThreadDiffStatBaselineReactorShape {
  /**
   * Start observing local git status.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when every observation accepted so far has been processed.
   * Intended for test use in place of timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadDiffStatBaselineReactor - Service tag for the clean-checkout observer.
 */
export class ThreadDiffStatBaselineReactor extends Context.Service<
  ThreadDiffStatBaselineReactor,
  ThreadDiffStatBaselineReactorShape
>()("threadlines/orchestration/Services/ThreadDiffStatBaselineReactor") {}
