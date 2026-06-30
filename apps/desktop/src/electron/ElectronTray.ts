import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

export interface ElectronTrayShape {
  readonly create: (image: Electron.NativeImage) => Effect.Effect<Electron.Tray>;
  readonly createTemplateImageFromPath: (
    iconPath: string,
  ) => Effect.Effect<Option.Option<Electron.NativeImage>>;
  readonly buildMenu: (
    template: readonly Electron.MenuItemConstructorOptions[],
  ) => Effect.Effect<Electron.Menu>;
}

export class ElectronTray extends Context.Service<ElectronTray, ElectronTrayShape>()(
  "threadlines/desktop/electron/Tray",
) {}

export const layer = Layer.succeed(
  ElectronTray,
  ElectronTray.of({
    create: (image) => Effect.sync(() => new Electron.Tray(image)),
    createTemplateImageFromPath: (iconPath) =>
      Effect.sync(() => {
        try {
          const source = Electron.nativeImage.createFromPath(iconPath);
          if (source.isEmpty()) {
            return Option.none<Electron.NativeImage>();
          }

          const image = source.resize({ width: 16, height: 16 });
          if (image.isEmpty()) {
            return Option.none<Electron.NativeImage>();
          }
          image.setTemplateImage(true);
          return Option.some(image);
        } catch {
          return Option.none<Electron.NativeImage>();
        }
      }),
    buildMenu: (template) => Effect.sync(() => Electron.Menu.buildFromTemplate([...template])),
  }),
);
