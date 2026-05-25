import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vitest";

const { registerMock, unregisterMock } = vi.hoisted(() => ({
  registerMock: vi.fn(),
  unregisterMock: vi.fn(),
}));

vi.mock("electron", () => ({
  globalShortcut: {
    register: registerMock,
    unregister: unregisterMock,
  },
}));

import * as ElectronGlobalShortcut from "./ElectronGlobalShortcut.ts";

describe("ElectronGlobalShortcut", () => {
  beforeEach(() => {
    registerMock.mockReset();
    unregisterMock.mockReset();
  });

  it.effect("registers a global shortcut", () =>
    Effect.gen(function* () {
      registerMock.mockReturnValue(true);
      const callback = vi.fn();

      const shortcuts = yield* ElectronGlobalShortcut.ElectronGlobalShortcut;
      const registered = yield* shortcuts.register("PrintScreen", callback);

      assert.equal(registered, true);
      assert.deepEqual(registerMock.mock.calls, [["PrintScreen", callback]]);
    }).pipe(Effect.provide(ElectronGlobalShortcut.layer)),
  );

  it.effect("unregisters a global shortcut", () =>
    Effect.gen(function* () {
      const shortcuts = yield* ElectronGlobalShortcut.ElectronGlobalShortcut;
      yield* shortcuts.unregister("PrintScreen");

      assert.deepEqual(unregisterMock.mock.calls, [["PrintScreen"]]);
    }).pipe(Effect.provide(ElectronGlobalShortcut.layer)),
  );
});
