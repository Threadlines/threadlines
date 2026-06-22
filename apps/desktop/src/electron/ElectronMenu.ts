import type { ContextMenuItem } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

export interface ElectronMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ElectronMenuContextInput {
  readonly window: Electron.BrowserWindow;
  readonly items: readonly ContextMenuItem[];
  readonly position: Option.Option<ElectronMenuPosition>;
}

export interface ElectronMenuTemplateInput {
  readonly window: Electron.BrowserWindow;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
  readonly frame?: Electron.WebFrameMain | null;
  readonly sourceType?: Electron.PopupOptions["sourceType"];
}

export interface ElectronMenuShape {
  readonly setApplicationMenu: (
    template: readonly Electron.MenuItemConstructorOptions[],
  ) => Effect.Effect<void>;
  readonly showContextMenu: (
    input: ElectronMenuContextInput,
  ) => Effect.Effect<Option.Option<string>>;
  readonly popupTemplate: (input: ElectronMenuTemplateInput) => Effect.Effect<void>;
}

export class ElectronMenu extends Context.Service<ElectronMenu, ElectronMenuShape>()(
  "threadlines/desktop/electron/Menu",
) {}

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

const normalizePosition = (
  position: Option.Option<ElectronMenuPosition>,
): Option.Option<ElectronMenuPosition> =>
  Option.filter(
    position,
    ({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0,
  ).pipe(Option.map(({ x, y }) => ({ x: Math.floor(x), y: Math.floor(y) })));

const DESTRUCTIVE_MENU_ICON_DATA_URLS = {
  dark: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAApElEQVR4nGP4n5LOgAU7AHEWFDtgU4NNUwQQ/wDiA1D8AyqGVSMXEItC8QsgrkbiV0PFYHwuZI37gfg/kXg/uo0bgbgLyWR03AVVg2IjCK8C4gYoWxiIWaFYGCrWAFWDETjIGncBcSoU7yJF436k6Ng/uDX6ArEyFPsS0rgcKsGIJAbDjFC55dg0av+HpJAzUOch4zNQOW1sGkFYDclv6FgNWS0AsdqaYq+R+y4AAAAASUVORK5CYII=",
  light:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAApElEQVR4nGM4yMDOgAU7AHEWFDtgU4NNUwQQ/wDiA1D8AyqGVSMXEItC8QsgrkbiV0PFYHwuZI37gfg/kXg/uo0bgbgLyWR03AVVg2IjCK8C4gYoWxiIWaFYGCrWAFWDETjIGncBcSoU7yJF436k6Ng/uDX6ArEyFPsS0rgcKsGIJAbDjFC55dg0ah+EpJAzUOch4zNQOW1sGkFYDclv6FgNWS0AeBrUy/yE688AAAAASUVORK5CYII=",
} as const;

type DestructiveMenuIconTone = keyof typeof DESTRUCTIVE_MENU_ICON_DATA_URLS;

export const layer = Layer.sync(ElectronMenu, () => {
  const destructiveMenuIconCache: Partial<
    Record<DestructiveMenuIconTone, Option.Option<Electron.NativeImage>>
  > = {};

  const getDestructiveMenuIcon = (): Option.Option<Electron.NativeImage> => {
    if (process.platform !== "darwin") {
      return Option.none();
    }
    const tone: DestructiveMenuIconTone = Electron.nativeTheme.shouldUseDarkColors
      ? "dark"
      : "light";
    const cachedIcon = destructiveMenuIconCache[tone];
    if (cachedIcon !== undefined) {
      return cachedIcon;
    }

    try {
      const icon = Electron.nativeImage.createFromDataURL(DESTRUCTIVE_MENU_ICON_DATA_URLS[tone]);
      destructiveMenuIconCache[tone] = icon.isEmpty() ? Option.none() : Option.some(icon);
    } catch {
      destructiveMenuIconCache[tone] = Option.none();
    }

    return destructiveMenuIconCache[tone] ?? Option.none();
  };

  const buildTemplate = (
    entries: readonly ContextMenuItem[],
    complete: (selectedItemId: Option.Option<string>) => void,
  ): Electron.MenuItemConstructorOptions[] => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    let hasInsertedDestructiveSeparator = false;

    for (const item of entries) {
      if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
        template.push({ type: "separator" });
        hasInsertedDestructiveSeparator = true;
      }

      const itemOption: Electron.MenuItemConstructorOptions = {
        label: item.label,
        enabled: !item.disabled,
      };
      if (item.children && item.children.length > 0) {
        itemOption.submenu = buildTemplate(item.children, complete);
      } else {
        itemOption.click = () => complete(Option.some(item.id));
      }
      if (item.destructive && (!item.children || item.children.length === 0)) {
        const destructiveIcon = getDestructiveMenuIcon();
        if (Option.isSome(destructiveIcon)) {
          itemOption.icon = destructiveIcon.value;
        }
      }

      template.push(itemOption);
    }

    return template;
  };

  return ElectronMenu.of({
    setApplicationMenu: (template) =>
      Effect.sync(() => {
        Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
      }),
    popupTemplate: (input) =>
      Effect.sync(() => {
        if (input.template.length === 0) {
          return;
        }
        const popupOptions: Electron.PopupOptions = { window: input.window };
        if (input.frame) {
          popupOptions.frame = input.frame;
        }
        if (input.sourceType !== undefined) {
          popupOptions.sourceType = input.sourceType;
        }
        Electron.Menu.buildFromTemplate([...input.template]).popup(popupOptions);
      }),
    showContextMenu: (input) =>
      Effect.callback<Option.Option<string>>((resume) => {
        const normalizedItems = normalizeContextMenuItems(input.items);
        if (normalizedItems.length === 0) {
          resume(Effect.succeed(Option.none()));
          return;
        }

        let completed = false;
        const complete = (selectedItemId: Option.Option<string>) => {
          if (completed) {
            return;
          }
          completed = true;
          resume(Effect.succeed(selectedItemId));
        };

        const menu = Electron.Menu.buildFromTemplate(buildTemplate(normalizedItems, complete));
        const popupPosition = normalizePosition(input.position);
        const popupOptions = Option.match(popupPosition, {
          onNone: (): Electron.PopupOptions => ({
            window: input.window,
            callback: () => complete(Option.none()),
          }),
          onSome: (position): Electron.PopupOptions => ({
            window: input.window,
            x: position.x,
            y: position.y,
            callback: () => complete(Option.none()),
          }),
        });
        menu.popup(popupOptions);
      }),
  });
});
