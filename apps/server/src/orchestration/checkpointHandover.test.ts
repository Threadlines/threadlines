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
    await run(checkpointHandover.turnStarted(thread, "turn-a"));

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
          .handOver(thread, "turn-a", Duration.millis(10))
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
  });

  it("closes a turn that was already recorded, so a repeated capture cannot publish", async () => {
    const thread = "thread-barrier-2";
    await run(checkpointHandover.turnStarted(thread, "turn-a"));
    await run(checkpointHandover.finalCaptureFinished(thread, "turn-a"));
    await run(checkpointHandover.handOver(thread, "turn-a", Duration.seconds(10)));
    const repeated = await run(
      checkpointHandover.capture(thread, "turn-a", Effect.succeed("recaptured")),
    );
    expect(Option.isNone(repeated)).toBe(true);
  });

  it("does not reopen a turn captured before its acceptance was registered", async () => {
    const thread = "thread-barrier-4";
    // A fast turn: its final capture finishes before the reactor registers it.
    await run(checkpointHandover.finalCaptureFinished(thread, "turn-a"));
    await run(checkpointHandover.turnStarted(thread, "turn-a"));
    const started = Date.now();
    await run(checkpointHandover.handOver(thread, "turn-a", Duration.seconds(10)));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait for a turn this process never started", async () => {
    const thread = "thread-barrier-3";
    const started = Date.now();
    // A turn from before a restart: nothing of it is in flight.
    await run(checkpointHandover.handOver(thread, "turn-before-restart", Duration.seconds(10)));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
