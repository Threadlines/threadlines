/**
 * One gate per thread, in this process, between what acts for a thread on
 * its own and the move that freezes it (docs/design/fleet.md, Part 3e,
 * "Review changes" 1). The pull request watcher holds it from the read that
 * decides to act through the act itself (a merge, a turn, a re-queue), and
 * reads the thread's move state again under it. A move takes it around the
 * freeze, so an act already under way finishes first, and every act after
 * reads the thread as moving and stands down.
 *
 * Only threads that act or move contend, one key each, so the watcher's
 * sweep over other threads never waits. After a restart the freeze is in
 * the projection, which the watcher reads first anyway.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeKeyedLock } from "../links/keyedLock.ts";

export interface ThreadActionGateShape {
  /** Runs `effect` holding the thread's gate: no freeze of it can land meanwhile. */
  readonly withThread: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class ThreadActionGate extends Context.Service<ThreadActionGate, ThreadActionGateShape>()(
  "threadlines/moves/ThreadActionGate",
) {}

/** A gate of its own, for one server (or one test). */
export const makeThreadActionGate = (): ThreadActionGateShape => {
  const lock = makeKeyedLock();
  return { withThread: (threadId, effect) => lock(threadId)(effect) };
};

export const ThreadActionGateLive = Layer.sync(ThreadActionGate, makeThreadActionGate);
