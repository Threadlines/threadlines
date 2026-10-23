import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/** Electron's powerSaveBlocker, behind a service so the main process can be tested without it. */
export interface ElectronPowerSaveBlockerShape {
  /** Keeps the system from idle sleep (the screen may still turn off); returns the blocker's id. */
  readonly preventAppSuspension: Effect.Effect<number>;
  readonly stop: (id: number) => Effect.Effect<void>;
}

export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  ElectronPowerSaveBlockerShape
>()("threadlines/desktop/electron/PowerSaveBlocker") {}

export const layer = Layer.succeed(
  ElectronPowerSaveBlocker,
  ElectronPowerSaveBlocker.of({
    preventAppSuspension: Effect.sync(() =>
      Electron.powerSaveBlocker.start("prevent-app-suspension"),
    ),
    stop: (id) =>
      Effect.sync(() => {
        if (Electron.powerSaveBlocker.isStarted(id)) Electron.powerSaveBlocker.stop(id);
      }),
  }),
);
