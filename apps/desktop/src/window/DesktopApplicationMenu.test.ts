import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("Threadlines"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  setDockBadge: () => Effect.void,
  bounceDock: () => Effect.succeed(Option.none()),
  cancelDockBounce: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronAppShape);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  confirm: () => Effect.succeed(false),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialogShape);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
} satisfies DesktopUpdates.DesktopUpdatesShape);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    handleBackendReady: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindowShape);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenuShape);

const makeElectronShellLayer = (openedExternalUrl: Deferred.Deferred<string>) =>
  Layer.succeed(ElectronShell.ElectronShell, {
    openExternal: (rawUrl) =>
      typeof rawUrl === "string"
        ? Deferred.succeed(openedExternalUrl, rawUrl).pipe(Effect.as(true))
        : Effect.succeed(false),
    openScreenClip: () => Effect.die("unexpected openScreenClip"),
    copyText: () => Effect.die("unexpected copyText"),
  } satisfies ElectronShell.ElectronShellShape);

const configureMenu = (platform: DesktopEnvironment.MakeDesktopEnvironmentInput["platform"]) =>
  Effect.gen(function* () {
    const selectedAction = yield* Deferred.make<string>();
    const openedExternalUrl = yield* Deferred.make<string>();
    const applicationMenuTemplate =
      yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

    yield* Effect.gen(function* () {
      const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
      yield* menu.configure;
    }).pipe(
      Effect.provide(
        DesktopApplicationMenu.layer.pipe(
          Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
          Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
          Layer.provideMerge(makeElectronShellLayer(openedExternalUrl)),
          Layer.provideMerge(desktopUpdatesLayer),
          Layer.provideMerge(electronDialogLayer),
          Layer.provideMerge(electronAppLayer),
          Layer.provideMerge(
            DesktopEnvironment.layer({ ...environmentInput, platform }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
            ),
          ),
        ),
      ),
    );

    const template = yield* Deferred.await(applicationMenuTemplate);
    return { template, selectedAction, openedExternalUrl };
  });

function submenuItems(
  template: readonly Electron.MenuItemConstructorOptions[],
  matches: (item: Electron.MenuItemConstructorOptions) => boolean,
  description: string,
): readonly Electron.MenuItemConstructorOptions[] {
  const menu = template.find(matches);
  if (!menu || !Array.isArray(menu.submenu)) {
    throw new Error(`Expected ${description} menu with an array submenu.`);
  }
  return menu.submenu;
}

function findMenuItem(
  items: readonly Electron.MenuItemConstructorOptions[],
  label: string,
): Electron.MenuItemConstructorOptions {
  const item = items.find((entry) => entry.label === label);
  if (!item) {
    throw new Error(`Expected "${label}" menu item.`);
  }
  return item;
}

function clickMenuItem(items: readonly Electron.MenuItemConstructorOptions[], label: string): void {
  const click = findMenuItem(items, label).click;
  if (typeof click !== "function") {
    throw new Error(`Expected "${label}" menu item to have a click handler.`);
  }
  click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
}

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const { template, selectedAction } = yield* configureMenu("linux");

      const fileItems = submenuItems(template, (item) => item.label === "File", "File");
      clickMenuItem(fileItems, "Settings...");
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("installs a hidden Windows PrintScreen accelerator for screen clipping", () =>
    Effect.gen(function* () {
      const { template, selectedAction } = yield* configureMenu("win32");

      const viewItems = submenuItems(template, (item) => item.label === "View", "View");
      const screenClipItem = findMenuItem(viewItems, "Screen Clip");
      assert.equal(screenClipItem.accelerator, "PrintScreen");
      assert.equal(screenClipItem.visible, false);
      clickMenuItem(viewItems, "Screen Clip");
      assert.equal(
        yield* Deferred.await(selectedAction),
        DesktopWindow.OPEN_SCREEN_CLIP_MENU_ACTION,
      );
    }),
  );

  it.effect("routes File > New Thread to the renderer on macOS", () =>
    Effect.gen(function* () {
      const { template, selectedAction } = yield* configureMenu("darwin");

      assert.equal(template[0]?.label, "Threadlines");
      const fileItems = submenuItems(template, (item) => item.label === "File", "File");
      const newThreadItem = findMenuItem(fileItems, "New Thread");
      assert.isUndefined(newThreadItem.accelerator);
      clickMenuItem(fileItems, "New Thread");
      assert.equal(yield* Deferred.await(selectedAction), "new-thread");
    }),
  );

  it.effect("routes View > Command Palette to the renderer", () =>
    Effect.gen(function* () {
      const { template, selectedAction } = yield* configureMenu("darwin");

      const viewItems = submenuItems(template, (item) => item.label === "View", "View");
      const commandPaletteItem = findMenuItem(viewItems, "Command Palette...");
      assert.isUndefined(commandPaletteItem.accelerator);
      clickMenuItem(viewItems, "Command Palette...");
      assert.equal(yield* Deferred.await(selectedAction), "toggle-command-palette");
    }),
  );

  it.effect("opens the GitHub repository from the Help menu", () =>
    Effect.gen(function* () {
      const { template, openedExternalUrl } = yield* configureMenu("darwin");

      const helpItems = submenuItems(template, (item) => item.role === "help", "Help");
      clickMenuItem(helpItems, "Threadlines on GitHub");
      assert.equal(
        yield* Deferred.await(openedExternalUrl),
        DesktopApplicationMenu.GITHUB_REPOSITORY_URL,
      );
    }),
  );

  it.effect("opens the issue tracker from the Help menu", () =>
    Effect.gen(function* () {
      const { template, openedExternalUrl } = yield* configureMenu("darwin");

      const helpItems = submenuItems(template, (item) => item.role === "help", "Help");
      clickMenuItem(helpItems, "Report an Issue");
      assert.equal(
        yield* Deferred.await(openedExternalUrl),
        DesktopApplicationMenu.GITHUB_NEW_ISSUE_URL,
      );
    }),
  );
});
