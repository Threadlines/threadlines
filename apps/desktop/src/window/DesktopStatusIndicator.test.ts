import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, vi } from "vitest";

import type * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopStatusGlyphs from "./DesktopStatusGlyphs.ts";
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
  readonly createImages: (readonly ElectronTray.TrayImageRepresentation[])[];
  readonly createTemplateImages: (readonly ElectronTray.TrayImageRepresentation[])[];
  readonly images: Electron.NativeImage[];
  readonly titles: string[];
  readonly tooltips: string[];
}

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
    createImage: (representations) =>
      Effect.sync(() => {
        calls.createImages.push(representations);
        return Option.some({ representations } as unknown as Electron.NativeImage);
      }),
    createTemplateImage: (representations) =>
      Effect.sync(() => {
        calls.createTemplateImages.push(representations);
        return Option.some({ representations } as unknown as Electron.NativeImage);
      }),
    create: (initialImage) =>
      Effect.succeed({
        setContextMenu: (menu: Electron.Menu) => calls.contextMenu.push(menu),
        setImage: (image: Electron.NativeImage) => calls.images.push(image),
        setTitle: (title: string) => calls.titles.push(title),
        setToolTip: (tooltip: string) => calls.tooltips.push(tooltip),
        initialImage,
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
      createImages: [],
      createTemplateImages: [],
      images: [],
      titles: [],
      tooltips: [],
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DesktopStatusIndicator", () => {
  it.effect(
    "animates macOS Dock and tray progress while working and marks completion natively",
    () =>
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
          vi.advanceTimersByTime(DesktopStatusGlyphs.TRAY_WORKING_FRAME_INTERVAL_MS * 4.5);
          yield* indicator.setStatus({
            status: "completed",
            description: "3 threads completed",
            completedThreadCount: 3,
          });

          // The completed pop plays once and then stops updating the image.
          const imagesAtCompletion = trayCalls.images.length;
          vi.advanceTimersByTime(
            DesktopStatusGlyphs.TRAY_COMPLETED_FRAME_INTERVAL_MS *
              (DesktopStatusGlyphs.makeMacTrayGlyphSet().completedFrames.length + 2),
          );
          const imagesAfterPop = trayCalls.images.length;
          assert.isAbove(imagesAfterPop, imagesAtCompletion);
          vi.advanceTimersByTime(1000);
          assert.equal(trayCalls.images.length, imagesAfterPop);
        }).pipe(Effect.provide(makeTestLayer({ appCalls, trayCalls, window })));

        const glyphs = DesktopStatusGlyphs.makeMacTrayGlyphSet();
        const expectedGlyphCount = 1 + glyphs.workingFrames.length + glyphs.completedFrames.length;
        assert.lengthOf(trayCalls.createTemplateImages, expectedGlyphCount);
        assert.isTrue(
          trayCalls.createTemplateImages.every(
            (representations) =>
              representations.length === 2 &&
              representations[0]?.scaleFactor === 1 &&
              representations[1]?.scaleFactor === 2 &&
              representations.every((representation) =>
                representation.dataUrl.startsWith("data:image/png;base64,"),
              ),
          ),
        );
        assert.deepEqual(trayCalls.titles, ["", "1", ""]);
        assert.deepEqual(trayCalls.tooltips, [
          "Threadlines: Ready",
          "Threadlines: 1 thread running",
          "Threadlines: 3 threads completed",
        ]);
        assert.isTrue(new Set(trayCalls.images).size >= 4);
        assert.deepEqual(appCalls.setDockBadge, ["", "3"]);
        assert.deepEqual(appCalls.bounceDock, ["informational"]);
        // The Dock stays quiet while working; the menu bar item carries activity.
        const progressCalls = (window.setProgressBar as unknown as ReturnType<typeof vi.fn>).mock
          .calls;
        assert.lengthOf(progressCalls, 0);
        assert.deepEqual(trayCalls.createImages, []);
      }),
  );

  it.effect("drives the Windows taskbar with count chips and native progress", () =>
    Effect.gen(function* () {
      const { appCalls, trayCalls } = makeCalls();
      const window = makeFakeWindow({ focused: false });

      yield* Effect.gen(function* () {
        const indicator = yield* DesktopStatusIndicator.DesktopStatusIndicator;
        yield* indicator.configure;
        yield* indicator.setStatus({
          status: "working",
          description: "2 threads are working",
          runningThreadCount: 2,
        });
        yield* indicator.setStatus({
          status: "working",
          description: "2 threads are working",
          runningThreadCount: 2,
        });
        yield* indicator.setStatus({
          status: "completed",
          description: "3 threads completed",
          completedThreadCount: 3,
        });
        yield* indicator.setStatus({ status: "idle", description: "No threads are working" });
      }).pipe(Effect.provide(makeTestLayer({ appCalls, trayCalls, window, platform: "win32" })));

      // No macOS status item on Windows; overlay chips are created once per
      // distinct label and reused.
      assert.deepEqual(trayCalls.createTemplateImages, []);
      assert.lengthOf(trayCalls.createImages, 2);
      assert.isTrue(
        trayCalls.createImages.every(
          (representations) =>
            representations[0]?.scaleFactor === 1 &&
            representations[1]?.scaleFactor === 2 &&
            representations.every((representation) =>
              representation.dataUrl.startsWith("data:image/png;base64,"),
            ),
        ),
      );

      const overlayCalls = (window.setOverlayIcon as unknown as ReturnType<typeof vi.fn>).mock
        .calls as [Electron.NativeImage | null, string][];
      assert.lengthOf(overlayCalls, 4);
      assert.isNotNull(overlayCalls[0]?.[0]);
      assert.equal(overlayCalls[0]?.[1], "2 threads are working");
      assert.equal(overlayCalls[1]?.[0], overlayCalls[0]?.[0]);
      assert.isNotNull(overlayCalls[2]?.[0]);
      assert.notEqual(overlayCalls[2]?.[0], overlayCalls[0]?.[0]);
      assert.equal(overlayCalls[2]?.[1], "3 threads completed");
      assert.deepEqual(overlayCalls[3], [null, ""]);

      const progressCalls = (window.setProgressBar as unknown as ReturnType<typeof vi.fn>).mock
        .calls;
      assert.deepEqual(progressCalls, [
        [2, { mode: "indeterminate" }],
        [2, { mode: "indeterminate" }],
        [-1],
        [-1],
      ]);

      const flashCalls = (window.flashFrame as unknown as ReturnType<typeof vi.fn>).mock.calls;
      assert.deepEqual(flashCalls, [[false], [false], [true], [false]]);
      assert.deepEqual(appCalls.setDockBadge, []);
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
        assert.equal(latestMenu?.[0]?.label, "Ready");
        assert.equal(latestMenu?.[0]?.sublabel, "No active agent sessions");
        assert.equal(latestMenu?.at(-1)?.label, "Quit Threadlines");
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
