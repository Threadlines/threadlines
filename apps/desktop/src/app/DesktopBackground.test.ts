import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopStatusIndicator from "../window/DesktopStatusIndicator.ts";
import * as DesktopBackground from "./DesktopBackground.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";

/** What the power-save blocker and the tray were asked to do. */
interface Calls {
  readonly started: number[];
  readonly stopped: number[];
  readonly tray: boolean[];
}

const makeLayer = (platform: NodeJS.Platform, calls: Calls) => {
  let nextId = 1;
  return DesktopBackground.layer.pipe(
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(DesktopAppSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(ElectronPowerSaveBlocker.ElectronPowerSaveBlocker, {
        preventAppSuspension: Effect.sync(() => {
          const id = nextId++;
          calls.started.push(id);
          return id;
        }),
        stop: (id) => Effect.sync(() => void calls.stopped.push(id)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(DesktopStatusIndicator.DesktopStatusIndicator)({
        setBackgroundTray: (enabled) => Effect.sync(() => void calls.tray.push(enabled)),
      }),
    ),
    Layer.provideMerge(Layer.mock(DesktopEnvironment.DesktopEnvironment)({ platform } as never)),
  );
};

describe("DesktopBackground", () => {
  it.effect(
    "keeps the computer awake only while it is asked to and a schedule is active or a run works",
    () => {
      const calls: Calls = { started: [], stopped: [], tray: [] };
      return Effect.gen(function* () {
        const background = yield* DesktopBackground.DesktopBackground;
        yield* background.configure;
        // A schedule, but nobody asked to keep awake.
        yield* background.setScheduledWork({ activeTasks: 2, workingRuns: 0 });
        assert.deepEqual(calls.started, []);

        yield* background.setOptions({ keepAwakeForScheduledTasks: true });
        assert.deepEqual(calls.started, [1]);
        // Another report while held takes no second blocker.
        yield* background.setScheduledWork({ activeTasks: 3, workingRuns: 0 });
        assert.deepEqual(calls.started, [1]);

        // The last schedule paused: let it sleep.
        yield* background.setScheduledWork({ activeTasks: 0, workingRuns: 0 });
        assert.deepEqual(calls.stopped, [1]);

        // A one-time task that ran has no schedule left, but its run still
        // works: stay awake for it.
        yield* background.setScheduledWork({ activeTasks: 0, workingRuns: 1 });
        assert.deepEqual(calls.started, [1, 2]);
        yield* background.setOptions({ keepAwakeForScheduledTasks: false });
        assert.deepEqual(calls.stopped, [1, 2]);
      }).pipe(Effect.provide(makeLayer("win32", calls)));
    },
  );

  it.effect("hides to the tray on Windows when asked, and never on macOS", () => {
    const windows: Calls = { started: [], stopped: [], tray: [] };
    const mac: Calls = { started: [], stopped: [], tray: [] };
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const background = yield* DesktopBackground.DesktopBackground;
        const state = yield* DesktopState.DesktopState;
        const options = yield* background.setOptions({ runInBackground: true });
        assert.isTrue(options.runInBackground);
        assert.isTrue(yield* Ref.get(state.runInBackground));
        yield* background.setOptions({ runInBackground: false });
        assert.isFalse(yield* Ref.get(state.runInBackground));
      }).pipe(Effect.provide(makeLayer("win32", windows)));
      assert.deepEqual(windows.tray, [true, false]);

      yield* Effect.gen(function* () {
        const background = yield* DesktopBackground.DesktopBackground;
        const options = yield* background.setOptions({ runInBackground: true });
        assert.isFalse(options.runInBackgroundSupported);
        assert.isFalse(options.runInBackground);
      }).pipe(Effect.provide(makeLayer("darwin", mac)));
      assert.deepEqual(mac.tray, [false]);
    });
  });
});
