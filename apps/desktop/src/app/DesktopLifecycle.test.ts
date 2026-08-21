import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  confirmQuitWithRunningAgentSessions,
  DESKTOP_SHUTDOWN_FAILSAFE_DURATION,
  DesktopShutdown,
  layerShutdown,
  requestDesktopShutdownAndWaitWithFailsafe,
} from "./DesktopLifecycle.ts";
import * as DesktopState from "./DesktopState.ts";

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

const makeElectronDialogLayer = (input: {
  readonly calls: Electron.MessageBoxOptions[];
  readonly response: number;
}) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.die("unexpected pickFolder"),
    confirm: () => Effect.die("unexpected confirm"),
    showMessageBox: (options) =>
      Effect.sync(() => {
        input.calls.push(options);
        return { response: input.response, checkboxChecked: false };
      }),
    showErrorBox: () => Effect.die("unexpected showErrorBox"),
  } satisfies ElectronDialog.ElectronDialogShape);

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

const runConfirmHarness = (input: {
  readonly runningThreadCount: number;
  readonly quitting?: boolean;
  readonly styledResponse?: boolean;
  readonly styledFailure?: boolean;
  readonly nativeResponse?: number;
  readonly body: (
    shouldQuit: boolean,
    styledCalls: ReadonlyArray<number>,
    dialogCalls: ReadonlyArray<Electron.MessageBoxOptions>,
  ) => Effect.Effect<void>;
}): Effect.Effect<void> => {
  const styledCalls: number[] = [];
  const dialogCalls: Electron.MessageBoxOptions[] = [];
  return Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    yield* Ref.set(state.runningThreadCount, input.runningThreadCount);
    yield* Ref.set(state.quitting, input.quitting ?? false);
    const shouldQuit = yield* confirmQuitWithRunningAgentSessions();
    yield* input.body(shouldQuit, styledCalls, dialogCalls);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopState.layer,
        makeElectronDialogLayer({ calls: dialogCalls, response: input.nativeResponse ?? 0 }),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected createMain"),
          ensureMain: Effect.die("unexpected ensureMain"),
          revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
          activate: Effect.void,
          createMainIfBackendReady: Effect.void,
          handleBackendReady: Effect.void,
          allowMainWindowClose: Effect.void,
          requestQuitConfirmation: (runningThreadCount) =>
            Effect.sync(() => {
              styledCalls.push(runningThreadCount);
            }).pipe(
              Effect.andThen(
                input.styledFailure
                  ? Effect.fail(new DesktopWindow.DesktopWindowDevServerUrlMissingError())
                  : Effect.succeed(input.styledResponse ?? false),
              ),
            ),
          resolveQuitConfirmation: () => Effect.void,
          dispatchMenuAction: () => Effect.void,
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindowShape),
      ),
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

describe("confirmQuitWithRunningAgentSessions", () => {
  it.effect("allows idle quit without showing a dialog", () =>
    runConfirmHarness({
      runningThreadCount: 0,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, true);
          assert.deepEqual(styledCalls, []);
          assert.deepEqual(dialogCalls, []);
        }),
    }),
  );

  it.effect("keeps the app open when the running-session warning is canceled", () =>
    runConfirmHarness({
      runningThreadCount: 1,
      styledResponse: false,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, false);
          assert.deepEqual(styledCalls, [1]);
          assert.deepEqual(dialogCalls, []);
        }),
    }),
  );

  it.effect("allows quit when the running-session warning is confirmed", () =>
    runConfirmHarness({
      runningThreadCount: 2,
      styledResponse: true,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, true);
          assert.deepEqual(styledCalls, [2]);
          assert.deepEqual(dialogCalls, []);
        }),
    }),
  );

  it.effect("does not prompt after a programmatic shutdown has started", () =>
    runConfirmHarness({
      runningThreadCount: 1,
      quitting: true,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, true);
          assert.deepEqual(styledCalls, []);
          assert.deepEqual(dialogCalls, []);
        }),
    }),
  );

  it.effect("falls back to a native warning when the app dialog cannot open", () =>
    runConfirmHarness({
      runningThreadCount: 1,
      styledFailure: true,
      nativeResponse: 0,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, false);
          assert.deepEqual(styledCalls, [1]);
          assert.lengthOf(dialogCalls, 1);
          assert.equal(dialogCalls[0]?.type, "warning");
          assert.deepEqual(dialogCalls[0]?.buttons, ["Keep Running", "Quit Anyway"]);
        }),
    }),
  );
});
