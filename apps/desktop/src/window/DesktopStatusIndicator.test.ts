import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, vi } from "vitest";

import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopStatusIndicator from "./DesktopStatusIndicator.ts";

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

function makeFakeWindow(input?: { readonly focused?: boolean }) {
  const window = {
    flashFrame: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => input?.focused === true),
    setOverlayIcon: vi.fn(),
    setProgressBar: vi.fn(),
  };

  return window as unknown as Electron.BrowserWindow;
}

interface ElectronAppCalls {
  readonly bounceDock: Array<"critical" | "informational">;
  readonly cancelDockBounce: number[];
  readonly setDockBadge: string[];
}

interface TrayCalls {
  readonly buildMenu: Electron.MenuItemConstructorOptions[][];
  readonly contextMenu: Electron.Menu[];
  readonly createIconPaths: string[];
  readonly titles: string[];
  readonly tooltips: string[];
}

const makeAssetsLayer = () =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none<string>(),
      icns: Option.none<string>(),
      png: Option.some("/icon.png"),
    }),
    resolveResourcePath: () => Effect.succeed(Option.none<string>()),
  } satisfies DesktopAssets.DesktopAssetsShape);

const makeElectronAppLayer = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
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
    setDockBadge: (badge) =>
      Effect.sync(() => {
        calls.setDockBadge.push(badge);
      }),
    bounceDock: (type) =>
      Effect.sync(() => {
        calls.bounceDock.push(type);
        return Option.some(9);
      }),
    cancelDockBounce: (id) =>
      Effect.sync(() => {
        calls.cancelDockBounce.push(id);
      }),
    appendCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronAppShape);

const makeElectronTrayLayer = (calls: TrayCalls) =>
  Layer.succeed(ElectronTray.ElectronTray, {
    createTemplateImageFromPath: (iconPath) =>
      Effect.sync(() => {
        calls.createIconPaths.push(iconPath);
        return Option.some({} as Electron.NativeImage);
      }),
    create: () =>
      Effect.succeed({
        setContextMenu: (menu: Electron.Menu) => calls.contextMenu.push(menu),
        setTitle: (title: string) => calls.titles.push(title),
        setToolTip: (tooltip: string) => calls.tooltips.push(tooltip),
      } as unknown as Electron.Tray),
    buildMenu: (template) =>
      Effect.sync(() => {
        calls.buildMenu.push([...template]);
        return { template } as unknown as Electron.Menu;
      }),
  } satisfies ElectronTray.ElectronTrayShape);

const makeElectronWindowLayer = (window: Electron.BrowserWindow) =>
  Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected create"),
    main: Effect.succeed(Option.some(window)),
    currentMainOrFirst: Effect.succeed(Option.some(window)),
    focusedMainOrFirst: Effect.succeed(Option.some(window)),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(window),
  } satisfies ElectronWindow.ElectronWindowShape);

const makeDesktopWindowLayer = (input: {
  readonly dispatchedActions: string[];
  readonly window: Electron.BrowserWindow;
}) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.succeed(input.window),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    handleBackendReady: Effect.void,
    dispatchMenuAction: (action) =>
      Effect.sync(() => {
        input.dispatchedActions.push(action);
      }),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindowShape);

function makeTestLayer(input: {
  readonly appCalls: ElectronAppCalls;
  readonly dispatchedActions?: string[];
  readonly platform?: NodeJS.Platform;
  readonly trayCalls: TrayCalls;
  readonly window: Electron.BrowserWindow;
}) {
  return DesktopStatusIndicator.layer.pipe(
    Layer.provideMerge(makeAssetsLayer()),
    Layer.provideMerge(makeElectronAppLayer(input.appCalls)),
    Layer.provideMerge(makeElectronTrayLayer(input.trayCalls)),
    Layer.provideMerge(makeElectronWindowLayer(input.window)),
    Layer.provideMerge(
      makeDesktopWindowLayer({
        dispatchedActions: input.dispatchedActions ?? [],
        window: input.window,
      }),
    ),
    Layer.provideMerge(
      DesktopEnvironment.layer({
        ...environmentInput,
        platform: input.platform ?? "darwin",
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
    ),
  );
}

function makeCalls(): {
  readonly appCalls: ElectronAppCalls;
  readonly trayCalls: TrayCalls;
} {
  return {
    appCalls: {
      bounceDock: [],
      cancelDockBounce: [],
      setDockBadge: [],
    },
    trayCalls: {
      buildMenu: [],
      contextMenu: [],
      createIconPaths: [],
      titles: [],
      tooltips: [],
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DesktopStatusIndicator", () => {
  it.effect("animates macOS Dock progress while working and marks completion natively", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const { appCalls, trayCalls } = makeCalls();
      const window = makeFakeWindow({ focused: false });

      yield* Effect.gen(function* () {
        const indicator = yield* DesktopStatusIndicator.DesktopStatusIndicator;
        yield* indicator.configure;
        yield* indicator.setStatus({
          status: "working",
          description: "One chat is working",
          runningThreadCount: 1,
        });
        yield* indicator.setStatus({ status: "completed", description: "Chat completed" });
      }).pipe(Effect.provide(makeTestLayer({ appCalls, trayCalls, window })));

      assert.deepEqual(trayCalls.createIconPaths, ["/icon.png"]);
      assert.deepEqual(trayCalls.titles, ["", "1", "OK"]);
      assert.deepEqual(appCalls.setDockBadge, ["", "1"]);
      assert.deepEqual(appCalls.bounceDock, ["informational"]);
      assert.deepEqual((window.setProgressBar as unknown as ReturnType<typeof vi.fn>).mock.calls, [
        [0.12],
        [-1],
      ]);
    }),
  );

  it.effect("routes the macOS status menu New Thread action through the renderer bridge", () =>
    Effect.gen(function* () {
      const { appCalls, trayCalls } = makeCalls();
      const dispatchedActions: string[] = [];
      const window = makeFakeWindow({ focused: true });

      yield* Effect.gen(function* () {
        const indicator = yield* DesktopStatusIndicator.DesktopStatusIndicator;
        yield* indicator.configure;

        const latestMenu = trayCalls.buildMenu.at(-1);
        const newThreadItem = latestMenu?.find((item) => item.label === "New Thread");
        assert.isDefined(newThreadItem);
        if (typeof newThreadItem.click !== "function") {
          throw new Error("Expected New Thread tray item to have a click handler.");
        }

        newThreadItem.click(
          {} as Electron.MenuItem,
          {} as Electron.BrowserWindow,
          {} as KeyboardEvent,
        );
        yield* Effect.promise(() => Promise.resolve());
      }).pipe(Effect.provide(makeTestLayer({ appCalls, dispatchedActions, trayCalls, window })));

      assert.deepEqual(dispatchedActions, ["new-thread"]);
    }),
  );
});
