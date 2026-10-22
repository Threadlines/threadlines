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
      ...(sourceItem.separatorBefore === true ? { separatorBefore: true } : {}),
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

export const layer = Layer.sync(ElectronMenu, () => {
  const buildTemplate = (
    entries: readonly ContextMenuItem[],
    complete: (selectedItemId: Option.Option<string>) => void,
  ): Electron.MenuItemConstructorOptions[] => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    let hasInsertedDestructiveSeparator = false;

    const endsInSeparator = () => template.at(-1)?.type === "separator";
    // A menu that draws its own groups places its dividers; any other one
    // gets the destructive items set apart.
    const ownsGroups = entries.some((item) => item.separatorBefore === true);
    for (const item of entries) {
      if (
        template.length > 0 &&
        !endsInSeparator() &&
        (item.separatorBefore === true ||
          (!ownsGroups && item.destructive && !hasInsertedDestructiveSeparator))
      ) {
        template.push({ type: "separator" });
      }
      if (item.destructive) hasInsertedDestructiveSeparator = true;

      const itemOption: Electron.MenuItemConstructorOptions = {
        label: item.label,
        enabled: !item.disabled,
      };
      if (item.children && item.children.length > 0) {
        itemOption.submenu = buildTemplate(item.children, complete);
      } else {
        itemOption.click = () => complete(Option.some(item.id));
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
