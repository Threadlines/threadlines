/**
 * DesktopBackground: what keeps Threadlines working for scheduled tasks
 * while nobody looks at it (docs/design/fleet.md, Part 6 and "Background
 * running on Windows and Linux").
 *
 * - Keep this computer awake for scheduled tasks: while this computer's
 *   server has an active task with a schedule, an Electron power-save
 *   blocker (`prevent-app-suspension`) stops idle sleep. Closing a laptop's
 *   lid still sleeps it.
 * - Keep running in the background (Windows and Linux): closing the window
 *   hides it to a tray icon instead of quitting, so links and schedules keep
 *   working; the tray's Quit quits. macOS always keeps running.
 *
 * Both are off until the user turns them on in Settings › General.
 */
import type {
  DesktopBackgroundOptions,
  DesktopBackgroundOptionsPatch,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopStatusIndicator from "../window/DesktopStatusIndicator.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";

export interface DesktopBackgroundShape {
  /** Applies the saved options at startup: the tray, and whether to keep awake. */
  readonly configure: Effect.Effect<void>;
  readonly options: Effect.Effect<DesktopBackgroundOptions>;
  readonly setOptions: (
    patch: DesktopBackgroundOptionsPatch,
  ) => Effect.Effect<DesktopBackgroundOptions, DesktopAppSettings.DesktopSettingsWriteError>;
  /** The page reported this computer's active scheduled tasks. */
  readonly setActiveScheduledTaskCount: (count: number) => Effect.Effect<void>;
}

export class DesktopBackground extends Context.Service<DesktopBackground, DesktopBackgroundShape>()(
  "threadlines/desktop/Background",
) {}

const make = Effect.gen(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const statusIndicator = yield* DesktopStatusIndicator.DesktopStatusIndicator;
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const runInBackgroundSupported = environment.platform !== "darwin";
  const lock = yield* Semaphore.make(1);
  let blockerId: number | null = null;

  const releaseBlocker = Effect.gen(function* () {
    if (blockerId === null) return;
    const id = blockerId;
    blockerId = null;
    yield* powerSaveBlocker.stop(id);
  });
  yield* Effect.addFinalizer(() => releaseBlocker);

  /** Holds the blocker exactly while it is wanted and there is a schedule to keep. */
  const reconcileKeepAwake = Effect.gen(function* () {
    const current = yield* settings.get;
    const active = yield* Ref.get(state.activeScheduledTaskCount);
    const wanted = current.keepAwakeForScheduledTasks && active > 0;
    if (wanted && blockerId === null) {
      blockerId = yield* powerSaveBlocker.preventAppSuspension;
    } else if (!wanted) {
      yield* releaseBlocker;
    }
  });

  const applyRunInBackground = Effect.gen(function* () {
    const enabled = runInBackgroundSupported && (yield* settings.get).runInBackground;
    yield* Ref.set(state.runInBackground, enabled);
    yield* statusIndicator.setBackgroundTray(enabled);
  });

  const options = Effect.map(settings.get, (current) => ({
    keepAwakeForScheduledTasks: current.keepAwakeForScheduledTasks,
    runInBackground: runInBackgroundSupported && current.runInBackground,
    runInBackgroundSupported,
  }));

  return DesktopBackground.of({
    configure: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* applyRunInBackground;
        yield* reconcileKeepAwake;
      }),
    ),
    options,
    setOptions: (patch) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* settings.setBackgroundOptions(patch);
          yield* applyRunInBackground;
          yield* reconcileKeepAwake;
          return yield* options;
        }),
      ),
    setActiveScheduledTaskCount: (count) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.set(
            state.activeScheduledTaskCount,
            Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
          );
          yield* reconcileKeepAwake;
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopBackground, make);
