/**
 * ChildThreadReactor - the server's side of threads an agent starts
 * (docs/design/child-threads.md).
 *
 * Sets up each child once its request is cleared to start, settles an answer
 * that was waiting on a child's background work once the child goes quiet,
 * settles requests whose child session stopped mid-answer, takes back
 * approvals when the setting is turned off, and on startup settles or
 * resumes whatever the previous process left open.
 *
 * @module ChildThreadReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ChildThreadReactorShape {
  /**
   * Start reacting to child-thread events. Run in a scope so its fibers end
   * on shutdown. Settles requests left open by the previous process before it
   * returns, so start it after the provider command reactor has settled the
   * sessions that process left behind.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when the event queue is empty and idle. For tests. */
  readonly drain: Effect.Effect<void>;
}

export class ChildThreadReactor extends Context.Service<
  ChildThreadReactor,
  ChildThreadReactorShape
>()("threadlines/orchestration/Services/ChildThreadReactor") {}
