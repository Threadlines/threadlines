import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vitest";

const { buildFromTemplateMock, createFromDataURLMock, nativeThemeMock, setApplicationMenuMock } =
  vi.hoisted(() => ({
    buildFromTemplateMock: vi.fn(),
    createFromDataURLMock: vi.fn(),
    nativeThemeMock: {
      shouldUseDarkColors: true,
    },
    setApplicationMenuMock: vi.fn(),
  }));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
  nativeTheme: nativeThemeMock,
  nativeImage: {
    createFromDataURL: createFromDataURLMock,
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

describe("ElectronMenu", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockReset();
    createFromDataURLMock.mockReset();
    nativeThemeMock.shouldUseDarkColors = true;
    setApplicationMenuMock.mockReset();
  });

  it.effect("returns none without building a menu when there are no valid items", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [],
        position: Option.none(),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("resolves with the clicked leaf item id", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(
        (template: Electron.MenuItemConstructorOptions[]) => ({
          popup: () => {
            const firstItem = template[0];
            assert.isDefined(firstItem);
            const click = firstItem.click;
            if (!click) {
              throw new Error("Expected menu item to have a click handler.");
            }
            click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
          },
        }),
      );

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.none(),
      });

      assert.equal(Option.getOrNull(selectedItemId), "copy");
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("resolves with none when the menu closes without a click", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.some({ x: 10.8, y: 20.2 }),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.deepEqual(buildFromTemplateMock.mock.calls[0]?.[0][0], {
        label: "Copy",
        enabled: true,
        click: buildFromTemplateMock.mock.calls[0]?.[0][0].click,
      });
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("defers popupTemplate side effects until the returned Effect runs", () =>
    Effect.gen(function* () {
      const popupMock = vi.fn();
      buildFromTemplateMock.mockImplementation(() => ({ popup: popupMock }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const popup = electronMenu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        template: [{ label: "Copy" }],
      });

      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
      assert.equal(popupMock.mock.calls.length, 0);

      yield* popup;

      assert.equal(buildFromTemplateMock.mock.calls.length, 1);
      assert.equal(popupMock.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("passes context frame and source type through popupTemplate", () =>
    Effect.gen(function* () {
      const popupMock = vi.fn();
      buildFromTemplateMock.mockImplementation(() => ({ popup: popupMock }));
      const frame = {} as Electron.WebFrameMain;

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      yield* electronMenu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        frame,
        sourceType: "mouse",
        template: [{ label: "Copy" }],
      });

      assert.deepEqual(popupMock.mock.calls[0]?.[0], {
        window: {},
        frame,
        sourceType: "mouse",
      });
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("uses a red native icon for destructive context menu items on macOS", () =>
    Effect.gen(function* () {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const icon = {
        isEmpty: () => false,
      } as Electron.NativeImage;
      createFromDataURLMock.mockReturnValue(icon);
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      try {
        const electronMenu = yield* ElectronMenu.ElectronMenu;
        yield* electronMenu.showContextMenu({
          window: {} as Electron.BrowserWindow,
          items: [
            { id: "rename", label: "Rename" },
            { id: "delete", label: "Delete", destructive: true },
          ],
          position: Option.none(),
        });

        const template = buildFromTemplateMock.mock.calls[0]?.[0];
        assert.equal(createFromDataURLMock.mock.calls.length, 1);
        assert.include(createFromDataURLMock.mock.calls[0]?.[0], "data:image/png;base64,");
        assert.deepEqual(template?.[2], {
          label: "Delete",
          enabled: true,
          click: template?.[2].click,
          icon,
        });
      } finally {
        platformSpy.mockRestore();
      }
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );
});
