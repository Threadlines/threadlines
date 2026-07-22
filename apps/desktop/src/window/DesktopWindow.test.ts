import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronGlobalShortcut from "../electron/ElectronGlobalShortcut.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronSpelling from "../electron/ElectronSpelling.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function makeFakeBrowserWindow(input?: {
  readonly bounds?: Electron.Rectangle;
  readonly normalBounds?: Electron.Rectangle;
  readonly isMaximized?: boolean;
}) {
  const windowHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const webContentsHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  let isMaximized = input?.isMaximized ?? false;
  const bounds = input?.bounds ?? { x: 0, y: 0, width: 1100, height: 780 };
  const normalBounds = input?.normalBounds ?? bounds;
  const webContents = {
    copyImageAt: vi.fn(),
    focus: vi.fn(),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      webContentsHandlers.set(eventName, [...(webContentsHandlers.get(eventName) ?? []), listener]);
      return webContents;
    }),
    once: vi.fn(),
    openDevTools: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };

  const window = {
    focus: vi.fn(),
    getBounds: vi.fn(() => bounds),
    getNormalBounds: vi.fn(() => normalBounds),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => isMaximized),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(() => {
      isMaximized = true;
    }),
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      windowHandlers.set(eventName, [...(windowHandlers.get(eventName) ?? []), listener]);
      return window;
    }),
    once: vi.fn(),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    loadURL: window.loadURL,
    maximize: window.maximize,
    webContentsFocus: webContents.focus,
    openDevTools: webContents.openDevTools,
    replaceMisspelling: webContents.replaceMisspelling,
    send: webContents.send,
    emitWebContents: (eventName: string, ...args: unknown[]) => {
      for (const listener of webContentsHandlers.get(eventName) ?? []) {
        listener(...args);
      }
    },
    emitWindow: (eventName: string, ...args: unknown[]) => {
      for (const listener of windowHandlers.get(eventName) ?? []) {
        listener(...args);
      }
    },
  };
}

const desktopAssetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssetsShape);

const desktopServerExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposureShape);

const electronMenuLayer = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeed(Option.none()),
} satisfies ElectronMenu.ElectronMenuShape);

const electronGlobalShortcutLayer = Layer.succeed(ElectronGlobalShortcut.ElectronGlobalShortcut, {
  register: () => Effect.succeed(true),
  unregister: () => Effect.void,
} satisfies ElectronGlobalShortcut.ElectronGlobalShortcutShape);

const electronShellLayer = Layer.succeed(ElectronShell.ElectronShell, {
  openExternal: () => Effect.succeed(true),
  openScreenClip: () => Effect.succeed(true),
  copyText: () => Effect.void,
} satisfies ElectronShell.ElectronShellShape);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronThemeShape);

function makeDesktopEnvironmentLayer(
  platform: NodeJS.Platform = "darwin",
  env: Readonly<Record<string, string | undefined>> = {},
) {
  return DesktopEnvironment.layer({ ...environmentInput, platform }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
          ...env,
        }),
      ),
    ),
  );
}

function makeTestLayer(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly createOptions?: Ref.Ref<ReadonlyArray<Electron.BrowserWindowConstructorOptions>>;
  readonly electronGlobalShortcut?: ElectronGlobalShortcut.ElectronGlobalShortcutShape;
  readonly electronMenu?: ElectronMenu.ElectronMenuShape;
  readonly electronShell?: ElectronShell.ElectronShellShape;
  readonly electronSpelling?: ElectronSpelling.ElectronSpellingShape;
}) {
  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.gen(function* () {
        yield* Ref.update(input.createCount, (count) => count + 1);
        if (input.createOptions) {
          yield* Ref.update(input.createOptions, (entries) => [...entries, options]);
        }
        return input.window;
      }),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindowShape);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        desktopAssetsLayer,
        makeDesktopEnvironmentLayer(input.platform, input.env),
        desktopServerExposureLayer,
        DesktopState.layer,
        NodeServices.layer,
        input.electronMenu
          ? Layer.succeed(ElectronMenu.ElectronMenu, input.electronMenu)
          : electronMenuLayer,
        input.electronGlobalShortcut
          ? Layer.succeed(
              ElectronGlobalShortcut.ElectronGlobalShortcut,
              input.electronGlobalShortcut,
            )
          : electronGlobalShortcutLayer,
        input.electronShell
          ? Layer.succeed(ElectronShell.ElectronShell, input.electronShell)
          : electronShellLayer,
        Layer.succeed(
          ElectronSpelling.ElectronSpelling,
          input.electronSpelling ?? { platformSuggestionsFor: () => Effect.succeed([]) },
        ),
        electronThemeLayer,
        electronWindowLayer,
      ),
    ),
  );
}

const waitForMockCalls = (mock: { readonly mock: { readonly calls: ReadonlyArray<unknown> } }) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100 && mock.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

describe("DesktopWindow", () => {
  it.effect("does not open a development window until the backend is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady;
        assert.equal(yield* Ref.get(createCount), 1);
        assert.deepEqual(fakeWindow.loadURL.mock.calls[0], ["http://127.0.0.1:5733/"]);
        assert.equal(fakeWindow.openDevTools.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens development DevTools only when explicitly requested", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        env: {
          T3CODE_DESKTOP_OPEN_DEVTOOLS: "true",
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        assert.equal(fakeWindow.openDevTools.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("applies an accepted spellcheck suggestion without renderer notifications", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const frame = {} as Electron.WebFrameMain;
      const popupTemplate = vi.fn((input: ElectronMenu.ElectronMenuTemplateInput) =>
        Effect.sync(() => {
          const [firstItem] = input.template;
          if (!firstItem?.click) {
            throw new Error("Expected first context menu item to accept the spelling suggestion.");
          }
          firstItem.click({} as Electron.MenuItem, fakeWindow.window, {} as KeyboardEvent);
        }),
      );
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        electronMenu: {
          setApplicationMenu: () => Effect.void,
          popupTemplate,
          showContextMenu: () => Effect.succeed(Option.none()),
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        const preventDefault = vi.fn();
        fakeWindow.emitWebContents("context-menu", { preventDefault }, {
          misspelledWord: "speeling",
          dictionarySuggestions: ["spelling"],
          linkURL: "",
          mediaType: "none",
          editFlags: {
            canUndo: false,
            canRedo: false,
            canCut: true,
            canCopy: true,
            canPaste: true,
            canDelete: false,
            canSelectAll: true,
            canEditRichly: false,
          },
          frame,
          menuSourceType: "mouse",
        } satisfies Partial<Electron.ContextMenuParams>);
        yield* waitForMockCalls(popupTemplate);

        assert.equal(preventDefault.mock.calls.length, 1);
        assert.equal(popupTemplate.mock.calls.length, 1);
        assert.equal(popupTemplate.mock.calls[0]?.[0].frame, frame);
        assert.equal(popupTemplate.mock.calls[0]?.[0].sourceType, "mouse");
        assert.deepEqual(fakeWindow.replaceMisspelling.mock.calls, [["spelling"]]);
        assert.equal(fakeWindow.webContentsFocus.mock.calls.length, 1);
        assert.deepEqual(fakeWindow.send.mock.calls, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("recovers platform spelling suggestions when Chromium provides none", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const platformSuggestionsFor = vi.fn((_word: string) =>
        Effect.succeed<ReadonlyArray<string>>(["I've", "Ive"]),
      );
      const popupTemplate = vi.fn((input: ElectronMenu.ElectronMenuTemplateInput) =>
        Effect.sync(() => {
          const [firstItem] = input.template;
          if (!firstItem?.click) {
            throw new Error("Expected first context menu item to accept the spelling suggestion.");
          }
          firstItem.click({} as Electron.MenuItem, fakeWindow.window, {} as KeyboardEvent);
        }),
      );
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        electronMenu: {
          setApplicationMenu: () => Effect.void,
          popupTemplate,
          showContextMenu: () => Effect.succeed(Option.none()),
        },
        electronSpelling: { platformSuggestionsFor },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        fakeWindow.emitWebContents("context-menu", { preventDefault: vi.fn() }, {
          misspelledWord: "ive",
          dictionarySuggestions: [],
          linkURL: "",
          mediaType: "none",
          editFlags: {
            canUndo: false,
            canRedo: false,
            canCut: true,
            canCopy: true,
            canPaste: true,
            canDelete: false,
            canSelectAll: true,
            canEditRichly: false,
          },
          frame: {} as Electron.WebFrameMain,
          menuSourceType: "mouse",
        } satisfies Partial<Electron.ContextMenuParams>);
        yield* waitForMockCalls(popupTemplate);

        assert.deepEqual(platformSuggestionsFor.mock.calls, [["ive"]]);
        assert.equal(popupTemplate.mock.calls.length, 1);
        const template = popupTemplate.mock.calls[0]?.[0].template ?? [];
        assert.equal(template[0]?.label, "I've");
        assert.equal(template[1]?.label, "Ive");
        assert.isFalse(template.some((item) => item.label === "No suggestions"));
        assert.deepEqual(fakeWindow.replaceMisspelling.mock.calls, [["I've"]]);
        assert.equal(fakeWindow.webContentsFocus.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("only opens the newest spelling menu when platform lookups overlap", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const firstSuggestions = yield* Deferred.make<ReadonlyArray<string>>();
      const secondSuggestions = yield* Deferred.make<ReadonlyArray<string>>();
      const platformSuggestionsFor = vi.fn((word: string) =>
        Deferred.await(word === "firstt" ? firstSuggestions : secondSuggestions),
      );
      const popupTemplate = vi.fn((_input: ElectronMenu.ElectronMenuTemplateInput) => Effect.void);
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        electronMenu: {
          setApplicationMenu: () => Effect.void,
          popupTemplate,
          showContextMenu: () => Effect.succeed(Option.none()),
        },
        electronSpelling: { platformSuggestionsFor },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        const contextMenuParams = (misspelledWord: string) =>
          ({
            misspelledWord,
            dictionarySuggestions: [],
            linkURL: "",
            mediaType: "none",
            editFlags: {
              canUndo: false,
              canRedo: false,
              canCut: true,
              canCopy: true,
              canPaste: true,
              canDelete: false,
              canSelectAll: true,
              canEditRichly: false,
            },
            frame: {} as Electron.WebFrameMain,
            menuSourceType: "mouse",
          }) satisfies Partial<Electron.ContextMenuParams>;

        fakeWindow.emitWebContents(
          "context-menu",
          { preventDefault: vi.fn() },
          contextMenuParams("firstt"),
        );
        fakeWindow.emitWebContents(
          "context-menu",
          { preventDefault: vi.fn() },
          contextMenuParams("secondd"),
        );

        yield* Deferred.succeed(secondSuggestions, ["second"]);
        yield* waitForMockCalls(popupTemplate);
        assert.equal(popupTemplate.mock.calls.length, 1);
        assert.equal(popupTemplate.mock.calls[0]?.[0].template[0]?.label, "second");

        yield* Deferred.succeed(firstSuggestions, ["first"]);
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        assert.equal(popupTemplate.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("falls back to No suggestions when the platform has none either", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const popupTemplate = vi.fn((_input: ElectronMenu.ElectronMenuTemplateInput) => Effect.void);
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        electronMenu: {
          setApplicationMenu: () => Effect.void,
          popupTemplate,
          showContextMenu: () => Effect.succeed(Option.none()),
        },
        electronSpelling: { platformSuggestionsFor: () => Effect.succeed([]) },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        fakeWindow.emitWebContents("context-menu", { preventDefault: vi.fn() }, {
          misspelledWord: "ive",
          dictionarySuggestions: [],
          linkURL: "",
          mediaType: "none",
          editFlags: {
            canUndo: false,
            canRedo: false,
            canCut: true,
            canCopy: true,
            canPaste: true,
            canDelete: false,
            canSelectAll: true,
            canEditRichly: false,
          },
          frame: {} as Electron.WebFrameMain,
          menuSourceType: "mouse",
        } satisfies Partial<Electron.ContextMenuParams>);
        yield* waitForMockCalls(popupTemplate);

        const template = popupTemplate.mock.calls[0]?.[0].template ?? [];
        assert.equal(template[0]?.label, "No suggestions");
        assert.equal(template[0]?.enabled, false);
        assert.deepEqual(fakeWindow.replaceMisspelling.mock.calls, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("restores maximized windows from persisted state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-window-state-",
      });
      const stateDir = path.join(baseDir, "dev");
      const windowStatePath = path.join(stateDir, "window-state.json");
      const fakeWindow = makeFakeBrowserWindow({
        bounds: { x: 0, y: 0, width: 1920, height: 1040 },
        normalBounds: { x: 120, y: 80, width: 960, height: 720 },
        isMaximized: true,
      });
      const createCount = yield* Ref.make(0);
      const createOptions = yield* Ref.make<
        ReadonlyArray<Electron.BrowserWindowConstructorOptions>
      >([]);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        createOptions,
        mainWindow,
        env: {
          T3CODE_HOME: baseDir,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          windowStatePath,
          `{"width":960,"height":720,"isMaximized":true}`,
        );

        yield* desktopWindow.handleBackendReady;
        const [options] = yield* Ref.get(createOptions);
        assert.equal(options?.width, 960);
        assert.equal(options?.height, 720);
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("uses normal bounds when a maximized window is persisted", () => {
    const fakeWindow = makeFakeBrowserWindow({
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
      normalBounds: { x: 120, y: 80, width: 960, height: 720 },
      isMaximized: true,
    });

    const bounds = DesktopWindow.getPersistableMainWindowBounds(fakeWindow.window);

    assert.equal(bounds.width, 960);
    assert.equal(bounds.height, 720);
  });

  it.effect("opens Windows screen clipping for bare PrintScreen", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openScreenClip = vi.fn(() => Effect.succeed(true));
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        platform: "win32",
        electronShell: {
          openExternal: () => Effect.succeed(true),
          openScreenClip,
          copyText: () => Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        const preventDefault = vi.fn();
        fakeWindow.emitWebContents("before-input-event", { preventDefault }, {
          type: "keyDown",
          key: "PrintScreen",
          code: "PrintScreen",
          alt: false,
          control: false,
          meta: false,
          shift: false,
        } satisfies Partial<Electron.Input>);
        yield* Effect.promise(() => Promise.resolve());

        assert.equal(preventDefault.mock.calls.length, 1);
        assert.equal(openScreenClip.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("registers PrintScreen while the Windows window is focused", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openScreenClip = vi.fn(() => Effect.succeed(true));
      const unregister = vi.fn(() => Effect.void);
      let shortcutCallback: (() => void) | null = null;
      const register = vi.fn((accelerator: string, callback: () => void) => {
        shortcutCallback = callback;
        return Effect.succeed(accelerator === "PrintScreen");
      });
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        platform: "win32",
        electronGlobalShortcut: {
          register,
          unregister,
        },
        electronShell: {
          openExternal: () => Effect.succeed(true),
          openScreenClip,
          copyText: () => Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        fakeWindow.emitWindow("focus");
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(
          register.mock.calls.map(([accelerator]) => accelerator),
          ["PrintScreen"],
        );

        shortcutCallback?.();
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(openScreenClip.mock.calls.length, 1);

        fakeWindow.emitWindow("blur");
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(unregister.mock.calls, [["PrintScreen"]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens Windows screen clipping from the menu action", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openScreenClip = vi.fn(() => Effect.succeed(true));
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        platform: "win32",
        electronShell: {
          openExternal: () => Effect.succeed(true),
          openScreenClip,
          copyText: () => Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.dispatchMenuAction(DesktopWindow.OPEN_SCREEN_CLIP_MENU_ACTION);

        assert.equal(openScreenClip.mock.calls.length, 1);
        assert.equal(fakeWindow.send.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not override modified PrintScreen shortcuts", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openScreenClip = vi.fn(() => Effect.succeed(true));
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        platform: "win32",
        electronShell: {
          openExternal: () => Effect.succeed(true),
          openScreenClip,
          copyText: () => Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady;

        const preventDefault = vi.fn();
        fakeWindow.emitWebContents("before-input-event", { preventDefault }, {
          type: "keyDown",
          key: "PrintScreen",
          code: "PrintScreen",
          alt: true,
          control: false,
          meta: false,
          shift: false,
        } satisfies Partial<Electron.Input>);
        yield* Effect.promise(() => Promise.resolve());

        assert.equal(preventDefault.mock.calls.length, 0);
        assert.equal(openScreenClip.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
