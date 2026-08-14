import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronApp from "../electron/ElectronApp.ts";
import {
  DESKTOP_SHUTDOWN_FAILSAFE_DURATION,
  DesktopShutdown,
  layerShutdown,
  requestDesktopShutdownAndWaitWithFailsafe,
} from "./DesktopLifecycle.ts";

const makeElectronAppLayer = (exitCodes: Array<number>) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("Threadlines"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: (code) =>
      Effect.sync(() => {
        exitCodes.push(code);
      }),
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    setDockBadge: () => Effect.void,
    bounceDock: () => Effect.die("unexpected dock bounce"),
    cancelDockBounce: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronAppShape);

const runHarness = (
  body: (
    exitCodes: ReadonlyArray<number>,
  ) => Effect.Effect<void, never, DesktopShutdown | ElectronApp.ElectronApp>,
): Effect.Effect<void> => {
  const exitCodes: Array<number> = [];
  return body(exitCodes).pipe(
    Effect.provide(
      Layer.mergeAll(layerShutdown, makeElectronAppLayer(exitCodes), TestClock.layer()),
    ),
  );
};

describe("requestDesktopShutdownAndWaitWithFailsafe", () => {
  it.effect("forces the process down when shutdown never completes", () =>
    runHarness((exitCodes) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(requestDesktopShutdownAndWaitWithFailsafe());
        yield* Effect.yieldNow;

        yield* TestClock.adjust(Duration.seconds(14));
        assert.deepEqual([...exitCodes], []);

        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(fiber);
        assert.deepEqual([...exitCodes], [1]);
      }),
    ),
  );

  it.effect("stays out of the way when shutdown completes in time", () =>
    runHarness((exitCodes) =>
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown;
        const fiber = yield* Effect.forkChild(requestDesktopShutdownAndWaitWithFailsafe());
        yield* Effect.yieldNow;

        yield* shutdown.markComplete;
        yield* Fiber.join(fiber);

        yield* TestClock.adjust(DESKTOP_SHUTDOWN_FAILSAFE_DURATION);
        assert.deepEqual([...exitCodes], []);
      }),
    ),
  );
});
