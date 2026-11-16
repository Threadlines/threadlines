import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThemeChoice } from "~/theme/themeStore";

const store = vi.hoisted(() => ({
  state: {
    committed: { kind: "builtin", id: "dark" } as ThemeChoice,
    systemPair: null as ThemeChoice | null,
  },
  chosen: [] as ThemeChoice[],
  loads: [] as Array<() => void>,
}));

vi.mock("~/theme/themeStore", () => ({
  readThemeState: () => store.state,
  chooseTheme: (choice: ThemeChoice) => {
    store.chosen.push(choice);
    store.state = { ...store.state, committed: choice };
  },
  rememberSystemPair: (pair: ThemeChoice | null) => {
    store.state = { ...store.state, systemPair: pair };
  },
}));
vi.mock("~/themeLibrary/themeCatalog", () => ({
  // Each load waits until the test lets it finish.
  loadPairManifests: () => new Promise((resolve) => store.loads.push(() => resolve({}))),
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: () => {} }, failureNotice: () => ({}) }));

const { pickSystemSide } = await import("./systemPairPick");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("picking a side of System's pair", () => {
  beforeEach(() => {
    store.state = { committed: { kind: "builtin", id: "dark" }, systemPair: null };
    store.chosen = [];
    store.loads = [];
  });

  it("lands once its themes load, building a second pick on the first", async () => {
    pickSystemSide("dark", { kind: "starter", id: "tokyo-rain" });
    pickSystemSide("light", { kind: "starter", id: "meadow" });
    for (const finish of store.loads) finish();
    await flush();
    expect(store.chosen).toEqual([
      {
        kind: "pair",
        light: { kind: "starter", id: "meadow" },
        dark: { kind: "starter", id: "tokyo-rain" },
      },
    ]);
  });

  it("gives way to a theme chosen while it loads", async () => {
    pickSystemSide("dark", { kind: "starter", id: "tokyo-rain" });
    // Restore defaults, or Light picked from the gallery, before the load finishes.
    store.state = { ...store.state, committed: { kind: "builtin", id: "system" } };
    for (const finish of store.loads) finish();
    await flush();
    expect(store.chosen).toEqual([]);
  });
});
