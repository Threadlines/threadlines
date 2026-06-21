import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ElectronGlobalShortcutShape {
  readonly register: (accelerator: string, callback: () => void) => Effect.Effect<boolean>;
  readonly unregister: (accelerator: string) => Effect.Effect<void>;
}

export class ElectronGlobalShortcut extends Context.Service<
  ElectronGlobalShortcut,
  ElectronGlobalShortcutShape
>()("threadlines/desktop/electron/GlobalShortcut") {}

const make = ElectronGlobalShortcut.of({
  register: (accelerator, callback) =>
    Effect.sync(() => {
      try {
        return Electron.globalShortcut.register(accelerator, callback);
      } catch {
        return false;
      }
    }),
  unregister: (accelerator) =>
    Effect.sync(() => {
      try {
        Electron.globalShortcut.unregister(accelerator);
      } catch {
        // Ignore shutdown-time races with Electron's shortcut registry.
      }
    }),
});

export const layer = Layer.succeed(ElectronGlobalShortcut, make);
