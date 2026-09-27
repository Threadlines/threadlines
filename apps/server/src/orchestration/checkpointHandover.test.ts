import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { checkpointHandover } from "./checkpointHandover.ts";

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

describe("checkpointHandover", () => {
  it("lets the next agent in only after the previous turn's capture, and refuses a later one", async () => {
    const thread = "thread-barrier-1";
    await run(checkpointHandover.turnStarted(thread, "turn-a", null));
    expect(checkpointHandover.mustWait(thread, "astra")).toBe(true);
    // The same agent's next turn does not wait on itself.
    expect(checkpointHandover.mustWait(thread, null)).toBe(false);

    const order: string[] = [];
    await run(
      Effect.gen(function* () {
        const captureStarted = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        // A's final capture is under way when the thread is handed over.
        const capture = yield* checkpointHandover
          .capture(
            thread,
            "turn-a",
            Effect.gen(function* () {
              yield* Deferred.succeed(captureStarted, undefined);
              yield* Deferred.await(releaseCapture);
              order.push("captured");
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(captureStarted);
        // The wait runs out, but closing still waits for the capture in progress.
        const handOver = yield* checkpointHandover
          .handOver(thread, "astra", Duration.millis(10))
          .pipe(
            Effect.tap(() => Effect.sync(() => order.push("handed over"))),
            Effect.forkChild,
          );
        yield* Effect.sleep(Duration.millis(30));
        expect(order).toEqual([]);
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* Fiber.join(capture);
        yield* Fiber.join(handOver);
      }),
    );
    expect(order).toEqual(["captured", "handed over"]);

    // A capture of the closed turn that comes afterwards is refused.
    const late = await run(checkpointHandover.capture(thread, "turn-a", Effect.succeed("late")));
    expect(Option.isNone(late)).toBe(true);
    expect(checkpointHandover.mustWait(thread, "astra")).toBe(false);
  });

  it("hands over at once when the previous turn is already recorded", async () => {
    const thread = "thread-barrier-2";
    await run(checkpointHandover.turnStarted(thread, "turn-a", null));
    await run(checkpointHandover.finalCaptureFinished(thread, "turn-a"));
    expect(checkpointHandover.mustWait(thread, "astra")).toBe(false);
  });
});
