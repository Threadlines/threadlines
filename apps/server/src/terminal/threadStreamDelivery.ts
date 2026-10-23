/**
 * Delivery of one thread's terminal events to one connection, bounded
 * (docs/terminal.md). A connection that can't keep up (a phone on a slow
 * link, a dev server printing nonstop) would otherwise grow the server's
 * queue without limit. Past `maxQueued` waiting events its output is
 * dropped; once the connection has caught up to `resumeAt`, a `resync`
 * event tells it to redraw the thread's tabs from the server's copy, which
 * holds everything that was dropped. Events other than output always go.
 *
 * @module threadStreamDelivery
 */
import type { TerminalStreamEvent } from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

export interface ThreadStreamLimits {
  readonly maxQueued: number;
  readonly resumeAt: number;
  readonly checkEvery: Duration.Input;
}

export const DEFAULT_THREAD_STREAM_LIMITS: ThreadStreamLimits = {
  maxQueued: 2_000,
  resumeAt: 100,
  checkEvery: Duration.millis(250),
};

/** The listener to hand the terminal manager for one connection's thread stream. */
export const makeThreadStreamDelivery = Effect.fn("terminal.makeThreadStreamDelivery")(function* <
  E,
>(
  queue: Queue.Queue<TerminalStreamEvent, E>,
  threadId: string,
  limits: ThreadStreamLimits = DEFAULT_THREAD_STREAM_LIMITS,
): Effect.fn.Return<(event: TerminalStreamEvent) => Effect.Effect<void>, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  let dropping = false;

  const resumeIfCaughtUp = Effect.gen(function* () {
    if (!dropping || (yield* Queue.size(queue)) > limits.resumeAt) return;
    dropping = false;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* Queue.offer(queue, { type: "resync", threadId, createdAt });
  });

  // Checks back while dropping, so a terminal that went quiet still gets its
  // resync once the connection catches up.
  const watchUntilResumed = resumeIfCaughtUp.pipe(
    Effect.delay(limits.checkEvery),
    Effect.repeat({ while: () => dropping }),
  );

  return (event: TerminalStreamEvent) =>
    Effect.gen(function* () {
      if (event.type === "output") {
        if (dropping) {
          yield* resumeIfCaughtUp;
          if (dropping) return;
        } else if ((yield* Queue.size(queue)) >= limits.maxQueued) {
          dropping = true;
          yield* watchUntilResumed.pipe(Effect.forkIn(scope));
          return;
        }
      }
      yield* Queue.offer(queue, event);
    });
});
