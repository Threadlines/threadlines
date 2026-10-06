import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { holdLaunchGate, makeLaunchGate, withLaunchGateClosed } from "./LaunchGate.ts";

describe("LaunchGate", () => {
  it.effect("waits out a running process, and lets nothing start or close it meanwhile", () =>
    Effect.gen(function* () {
      const gate = makeLaunchGate();
      const processScope = yield* Scope.make();
      yield* holdLaunchGate(gate, () => "closed" as const).pipe(Scope.provide(processScope));
      let stops = 0;
      let waitingNotices = 0;
      const options = {
        whenAlreadyClosed: () => "already closed" as const,
        whenStillHeld: () => "still held" as const,
        stop: Effect.sync(() => {
          stops += 1;
        }),
        onWaiting: Effect.sync(() => {
          waitingNotices += 1;
        }),
      };

      const closing = yield* withLaunchGateClosed(
        gate,
        options,
        Effect.sync(() => gate.holds),
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.millis(600));

      // Asked to stop on every poll (one still starting only becomes
      // stoppable later), told about the wait once.
      assert.equal(stops, 3);
      assert.equal(waitingNotices, 1);
      assert.equal(
        yield* Effect.flip(Effect.scoped(holdLaunchGate(gate, () => "closed" as const))),
        "closed",
      );
      assert.equal(
        yield* Effect.flip(withLaunchGateClosed(gate, options, Effect.void)),
        "already closed",
      );

      yield* Scope.close(processScope, Exit.void);
      yield* TestClock.adjust(Duration.millis(250));
      // The work ran with every process gone, and the gate is open again.
      assert.equal(yield* Fiber.join(closing), 0);
      yield* Effect.scoped(holdLaunchGate(gate, () => "closed" as const));
    }),
  );

  it.effect("gives up on a process that never ends, without running the work", () =>
    Effect.gen(function* () {
      const gate = makeLaunchGate();
      yield* holdLaunchGate(gate, () => "closed" as const);
      let ran = false;

      const closing = yield* withLaunchGateClosed(
        gate,
        {
          whenAlreadyClosed: () => "already closed" as const,
          whenStillHeld: () => "still held" as const,
          stop: Effect.void,
        },
        Effect.sync(() => {
          ran = true;
        }),
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(46));

      assert.equal(yield* Fiber.join(closing), "still held");
      assert.isFalse(ran);
      assert.isFalse(gate.busy);
    }),
  );
});
