import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { appFocusMock, getAllWindowsMock, defaultSession } = vi.hoisted(() => ({
  appFocusMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
  defaultSession: {},
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  session: { defaultSession },
}));

import * as ElectronWindow from "./ElectronWindow.ts";

function makeBrowserWindow(input: { readonly destroyed: boolean; readonly session?: object }) {
  return {
    isDestroyed: vi.fn(() => input.destroyed),
    webContents: { session: input.session ?? defaultSession },
  } as unknown as Electron.BrowserWindow;
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    getAllWindowsMock.mockReset();
  });

  it.effect("syncs appearance only on live app windows, never a page's pop-up", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ destroyed: false });
      const destroyedWindow = makeBrowserWindow({ destroyed: true });
      // A browser page's sign-in pop-up runs in a preview profile, not the app's.
      const signInPopup = makeBrowserWindow({ destroyed: false, session: {} });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow, signInPopup]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(ElectronWindow.layer)),
  );
});
