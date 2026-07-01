import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

export interface TrayImageRepresentation {
  readonly scaleFactor: number;
  readonly dataUrl: string;
}

export interface ElectronTrayShape {
  readonly create: (image: Electron.NativeImage) => Effect.Effect<Electron.Tray>;
  readonly createImage: (
    representations: readonly TrayImageRepresentation[],
  ) => Effect.Effect<Option.Option<Electron.NativeImage>>;
  readonly createTemplateImage: (
    representations: readonly TrayImageRepresentation[],
  ) => Effect.Effect<Option.Option<Electron.NativeImage>>;
  readonly buildMenu: (
    template: readonly Electron.MenuItemConstructorOptions[],
  ) => Effect.Effect<Electron.Menu>;
}

export class ElectronTray extends Context.Service<ElectronTray, ElectronTrayShape>()(
  "threadlines/desktop/electron/Tray",
) {}

function createFromRepresentations(
  representations: readonly TrayImageRepresentation[],
): Option.Option<Electron.NativeImage> {
  try {
    const image = Electron.nativeImage.createEmpty();
    for (const representation of representations) {
      image.addRepresentation({
        scaleFactor: representation.scaleFactor,
        dataURL: representation.dataUrl,
      });
    }
    if (image.isEmpty()) {
      return Option.none<Electron.NativeImage>();
    }
    return Option.some(image);
  } catch {
    return Option.none<Electron.NativeImage>();
  }
}

export const layer = Layer.succeed(
  ElectronTray,
  ElectronTray.of({
    create: (image) => Effect.sync(() => new Electron.Tray(image)),
    createImage: (representations) => Effect.sync(() => createFromRepresentations(representations)),
    createTemplateImage: (representations) =>
      Effect.sync(() =>
        Option.map(createFromRepresentations(representations), (image) => {
          // Template images let macOS derive menu bar appearance (dark mode,
          // highlight inversion) from the alpha channel alone.
          image.setTemplateImage(true);
          return image;
        }),
      ),
    buildMenu: (template) => Effect.sync(() => Electron.Menu.buildFromTemplate([...template])),
  }),
);
