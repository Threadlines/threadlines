import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  bounceDockMock,
  cancelDockBounceMock,
  exitMock,
  getAppPathMock,
  getVersionMock,
  onMock,
  quitMock,
  relaunchMock,
  removeListenerMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setDesktopNameMock,
  setDockBadgeMock,
  setDockIconMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  bounceDockMock: vi.fn(() => 7),
  cancelDockBounceMock: vi.fn(),
  exitMock: vi.fn(),
  getAppPathMock: vi.fn(() => "/app"),
  getVersionMock: vi.fn(() => "1.2.3"),
  onMock: vi.fn(),
  quitMock: vi.fn(),
  relaunchMock: vi.fn(),
  removeListenerMock: vi.fn(),
  setAboutPanelOptionsMock: vi.fn(),
  setAppUserModelIdMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  setDockBadgeMock: vi.fn(),
  setDockIconMock: vi.fn(),
  setNameMock: vi.fn(),
  setPathMock: vi.fn(),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
    },
    dock: {
      bounce: bounceDockMock,
      cancelBounce: cancelDockBounceMock,
      setBadge: setDockBadgeMock,
      setIcon: setDockIconMock,
    },
    getAppPath: getAppPathMock,
    getVersion: getVersionMock,
    isPackaged: true,
    name: "Threadlines",
    on: onMock,
    quit: quitMock,
    relaunch: relaunchMock,
    removeListener: removeListenerMock,
    runningUnderARM64Translation: false,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
    exit: exitMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    bounceDockMock.mockClear();
    cancelDockBounceMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    removeListenerMock.mockClear();
    setDockBadgeMock.mockClear();
    setPathMock.mockClear();
  });

  it.effect("reads app metadata through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.deepEqual(metadata, {
        appVersion: "1.2.3",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: process.resourcesPath,
        runningUnderArm64Translation: false,
      });
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes app event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.on("activate", listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["activate", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["activate", listener]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("wraps macOS Dock status APIs", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;

      yield* electronApp.setDockBadge("1");
      const bounceId = yield* electronApp.bounceDock("informational");
      yield* electronApp.cancelDockBounce(7);

      assert.deepEqual(setDockBadgeMock.mock.calls, [["1"]]);
      assert.deepEqual(bounceDockMock.mock.calls, [["informational"]]);
      assert.deepEqual(cancelDockBounceMock.mock.calls, [[7]]);
      assert.isTrue(Option.isSome(bounceId));
      if (Option.isSome(bounceId)) {
        assert.equal(bounceId.value, 7);
      }
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
