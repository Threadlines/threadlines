/**
 * GoalWaitReactor - pauses a thread's goal while the thread waits, and
 * resumes it when the wait ends (docs/design/goal-wait-pause.md).
 *
 * Watches the events that change what a thread with a goal waits on (its
 * cards, the threads it started, its session, its goal) and the scheduler's
 * waiting cards, and sends `thread.goal.wait.sync` for each thread whose goal
 * should change. The decider holds the rule; this only asks it at the right
 * moments, and only for goals whose provider can pause one.
 *
 * @module GoalWaitReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface GoalWaitReactorShape {
  /**
   * Start watching, and bring every goal in line once (a restart may have
   * left a card answered while the server was down).
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves once every thread queued so far has been looked at. For tests. */
  readonly drain: Effect.Effect<void>;
}

export class GoalWaitReactor extends Context.Service<GoalWaitReactor, GoalWaitReactorShape>()(
  "threadlines/orchestration/Services/GoalWaitReactor",
) {}
