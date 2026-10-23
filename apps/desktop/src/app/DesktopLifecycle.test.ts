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
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  confirmQuitWithRunningAgentSessions,
  describeRunningWorkForNativeQuit,
  DESKTOP_SHUTDOWN_FAILSAFE_DURATION,
  DesktopLifecycle,
  DesktopShutdown,
  layer as lifecycleLayer,
  layerShutdown,
  requestDesktopShutdownAndWaitWithFailsafe,
} from "./DesktopLifecycle.ts";
import * as DesktopState from "./DesktopState.ts";

const makeElectronAppLayer = (
  exitCodes: Array<number>,
  on: ElectronApp.ElectronAppShape["on"] = () => Effect.void,
) =>
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
    focus: Effect.void,
    cancelDockBounce: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    on,
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
  readonly activeScheduledTaskCount?: number;
  readonly runInBackground?: boolean;
  readonly busyTerminalCount?: number;
  readonly quitting?: boolean;
  readonly styledResponse?: boolean;
  readonly styledFailure?: { readonly windowOpen: boolean };
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
    yield* Ref.set(state.localRunningThreadCount, input.runningThreadCount);
    yield* Ref.set(state.activeScheduledTaskCount, input.activeScheduledTaskCount ?? 0);
    yield* Ref.set(state.runInBackground, input.runInBackground ?? false);
    yield* Ref.set(state.localBusyTerminalCount, input.busyTerminalCount ?? 0);
    yield* Ref.set(state.quitting, input.quitting ?? false);
    const shouldQuit = yield* confirmQuitWithRunningAgentSessions();
    yield* input.body(shouldQuit, styledCalls, dialogCalls);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopState.layer,
        makeElectronDialogLayer({ calls: dialogCalls, response: input.nativeResponse ?? 0 }),
        makeElectronAppLayer([]),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected createMain"),
          ensureMain: Effect.die("unexpected ensureMain"),
          revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
          activate: Effect.void,
          createMainIfBackendReady: Effect.void,
          handleBackendReady: Effect.void,
          allowMainWindowOpen: Effect.void,
          allowMainWindowClose: Effect.void,
          requestQuitConfirmation: (work) =>
            Effect.sync(() => {
              styledCalls.push(work.runningThreadCount);
            }).pipe(
              Effect.andThen(
                input.styledFailure
                  ? Effect.fail(
                      new DesktopWindow.DesktopWindowQuitConfirmationError({
                        cause: "not shown",
                        windowOpen: input.styledFailure.windowOpen,
                      }),
                    )
                  : Effect.succeed(input.styledResponse ?? false),
              ),
            ),
          quitConfirmationShown: () => Effect.void,
          resolveQuitConfirmation: () => Effect.void,
          repeatQuitConfirmation: Effect.succeed(false),
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
  it.effect("asks about scheduled tasks only where the app keeps running in the background", () =>
    Effect.gen(function* () {
      // An active schedule alone is no reason to ask at every quit.
      yield* runConfirmHarness({
        runningThreadCount: 0,
        activeScheduledTaskCount: 2,
        body: (shouldQuit, styledCalls) =>
          Effect.sync(() => {
            assert.equal(shouldQuit, true);
            assert.deepEqual(styledCalls, []);
          }),
      });
      // Kept running in the tray, quitting is a deliberate stop of them.
      yield* runConfirmHarness({
        runningThreadCount: 0,
        activeScheduledTaskCount: 2,
        runInBackground: true,
        styledFailure: { windowOpen: false },
        nativeResponse: 0,
        body: (shouldQuit, _styledCalls, dialogCalls) =>
          Effect.sync(() => {
            assert.equal(shouldQuit, false);
            assert.include(
              String(dialogCalls[0]?.message),
              "2 scheduled tasks won't run until you open Threadlines again.",
            );
          }),
      });
      // Asked for other work, the question still says what happens to them.
      yield* runConfirmHarness({
        runningThreadCount: 0,
        busyTerminalCount: 1,
        activeScheduledTaskCount: 1,
        styledFailure: { windowOpen: true },
        nativeResponse: 0,
        body: (shouldQuit, _styledCalls, dialogCalls) =>
          Effect.sync(() => {
            assert.equal(shouldQuit, false);
            assert.equal(
              dialogCalls[0]?.message,
              "A terminal command is still running. A scheduled task won't run until you open Threadlines again.",
            );
          }),
      });
    }),
  );

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
      styledFailure: { windowOpen: true },
      nativeResponse: 0,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, false);
          assert.deepEqual(styledCalls, [1]);
          assert.lengthOf(dialogCalls, 1);
          assert.equal(dialogCalls[0]?.type, "warning");
          assert.equal(dialogCalls[0]?.message, "An agent session is still running.");
          assert.deepEqual(dialogCalls[0]?.buttons, ["Keep Running", "Quit Anyway"]);
        }),
    }),
  );

  it.effect("asks when only a terminal is running something, naming both kinds of work", () =>
    runConfirmHarness({
      runningThreadCount: 0,
      busyTerminalCount: 1,
      styledFailure: { windowOpen: true },
      nativeResponse: 0,
      body: (shouldQuit, styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, false);
          assert.deepEqual(styledCalls, [0]);
          assert.equal(dialogCalls[0]?.message, "A terminal command is still running.");
          assert.equal(
            describeRunningWorkForNativeQuit({ threadCount: 1, terminalCount: 2 }, true),
            "An agent session and 2 terminal commands are still running.",
          );
        }),
    }),
  );

  it.effect("quits from the native warning when no window is open to ask", () =>
    runConfirmHarness({
      runningThreadCount: 2,
      styledFailure: { windowOpen: false },
      nativeResponse: 1,
      body: (shouldQuit, _styledCalls, dialogCalls) =>
        Effect.sync(() => {
          assert.equal(shouldQuit, true);
          // The count is from the last window to close, so it is not stated as fact.
          assert.equal(dialogCalls[0]?.message, "2 agent sessions may still be running.");
        }),
    }),
  );
});

describe("register", () => {
  it.effect("removes its listeners when the caller's scope closes", () => {
    const appListeners = new Set<string>();
    const themeListeners = new Set<() => void>();
    const track = <A>(set: Set<A>, value: A) =>
      Effect.acquireRelease(
        Effect.sync(() => set.add(value)),
        () => Effect.sync(() => set.delete(value)),
      ).pipe(Effect.asVoid);
    const services = Layer.mergeAll(
      layerShutdown,
      DesktopState.layer,
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: false,
        platform: "linux",
      } as DesktopEnvironment.DesktopEnvironmentShape),
      Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindowShape),
      makeElectronDialogLayer({ calls: [], response: 0 }),
      makeElectronAppLayer([], (eventName) => track(appListeners, eventName)),
      Layer.succeed(ElectronTheme.ElectronTheme, {
        onUpdated: (listener) => track(themeListeners, listener),
      } as ElectronTheme.ElectronThemeShape),
    );
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopLifecycle;
      const sigterm = process.listenerCount("SIGTERM");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lifecycle.register;
          assert.isAbove(appListeners.size, 0);
          assert.strictEqual(themeListeners.size, 1);
          assert.strictEqual(process.listenerCount("SIGTERM"), sigterm + 1);
        }),
      );
      assert.strictEqual(appListeners.size, 0);
      assert.strictEqual(themeListeners.size, 0);
      assert.strictEqual(process.listenerCount("SIGTERM"), sigterm);
    }).pipe(Effect.provide(lifecycleLayer.pipe(Layer.provide(services))));
  });
});
