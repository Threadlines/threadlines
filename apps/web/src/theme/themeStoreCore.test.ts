import { THEME_FILE_FORMAT, type ThemeManifest } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  readKeptThemeHashes,
  serializeThemeChoice,
  THEME_PAINT_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./themeChoice";
import {
  createThemeStoreCore,
  THEME_TRIAL_MS,
  type ThemeContentLookup,
  type ThemeStoreEnv,
} from "./themeStoreCore";
import type { ThemeChoice } from "./themeTypes";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const manifest = (name: string, base: "light" | "dark" = "dark"): ThemeManifest => ({
  format: THEME_FILE_FORMAT,
  name,
  base,
  colors: {
    background: base === "dark" ? "#0a1029" : "#fbf6ee",
    foreground: base === "dark" ? "#e7ecff" : "#2a1f16",
    mutedForeground: base === "dark" ? "#a3aed2" : "#6f5b48",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
});

const library = (hash: string, name: string): ThemeChoice => ({
  kind: "library",
  entryId: `entry-${hash.slice(0, 4)}`,
  hash,
  name,
  environmentId: null,
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

/** An environment with timers the test fires by hand and content it hands out. */
function makeEnv(input: {
  readonly storage?: ReturnType<typeof memoryStorage>;
  readonly content?: Record<string, ThemeManifest>;
  readonly lookup?: (hash: string) => Promise<ThemeContentLookup>;
}) {
  const timers: Array<{ readonly callback: () => void; cancelled: boolean }> = [];
  let ids = 0;
  const storage = input.storage ?? memoryStorage();
  const env: ThemeStoreEnv = {
    storage,
    now: () => 1_000,
    setTimer: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    randomId: () => `trial-${(ids += 1)}`,
    systemDark: () => false,
    bypassSavedChoice: false,
    hashManifest: async () => HASH_B,
    lookupContent: (choice) =>
      input.lookup
        ? input.lookup(choice.hash)
        : Promise.resolve(
            input.content?.[choice.hash]
              ? { kind: "found", manifest: input.content[choice.hash]! }
              : { kind: "missing" },
          ),
    rememberContent: () => {},
    starterManifest: (id) => (id === "aurora" ? manifest("Aurora") : null),
  };
  /** Fires a timer the store set, unless it was cancelled (a real timer would not run). */
  const fire = (index: number) => {
    const timer = timers[index];
    if (timer && !timer.cancelled) timer.callback();
  };
  return { env, storage, timers, fire };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("theme store", () => {
  it("loads today's stored values: the built-in words, the legacy key, and anything else as System", () => {
    expect(
      createThemeStoreCore(
        makeEnv({ storage: memoryStorage({ [THEME_STORAGE_KEY]: "dark" }) }).env,
      ).getState().active,
    ).toMatchObject({ choice: { kind: "builtin", id: "dark" }, base: "dark", tokens: null });

    const legacy = memoryStorage({ "t3code:theme": "light" });
    const migrated = createThemeStoreCore(makeEnv({ storage: legacy }).env).getState();
    expect(migrated.committed).toEqual({ kind: "builtin", id: "light" });
    expect(legacy.values.get(THEME_STORAGE_KEY)).toBe("light");

    expect(
      createThemeStoreCore(
        makeEnv({ storage: memoryStorage({ [THEME_STORAGE_KEY]: "neon" }) }).env,
      ).getState().committed,
    ).toEqual({ kind: "builtin", id: "system" });
  });

  it("applies a trial at once, and its countdown only ever ends its own trial", () => {
    const { env, fire, storage } = makeEnv({});
    const store = createThemeStoreCore(env);
    const first = store.startThemeTrial({
      choice: library(HASH_A, "Aurora"),
      manifest: manifest("Aurora"),
    });
    expect(first.expiresAt).toBe(1_000 + THEME_TRIAL_MS);
    expect(store.getState().active).toMatchObject({ hash: HASH_A, base: "dark", name: "Aurora" });

    const second = store.startThemeTrial({
      choice: { kind: "builtin", id: "light" },
      manifest: null,
    });
    expect(second.manifest).toBeNull();
    // The first trial's countdown comes due: it may not end the second.
    fire(0);
    expect(store.getState().trial?.id).toBe(second.id);
    expect(store.getState().active).toMatchObject({ choice: { kind: "builtin", id: "light" } });

    fire(1);
    expect(store.getState().trial).toBeNull();
    expect(store.getState().active.choice).toEqual({ kind: "builtin", id: "system" });
    // A trial never reaches storage: a reload keeps the committed theme.
    expect(storage.values.get(THEME_STORAGE_KEY)).toBeUndefined();
  });

  it("commits a kept trial, remembers its hash, and ignores an ended trial's id", () => {
    const { env, storage } = makeEnv({});
    const store = createThemeStoreCore(env);
    const trial = store.startThemeTrial({
      choice: library(HASH_A, "Aurora"),
      manifest: manifest("Aurora"),
    });
    expect(store.hasKeptTheme(HASH_A)).toBe(false);

    store.commitThemeTrial(trial.id);
    expect(store.getState().trial).toBeNull();
    expect(store.getState().committed).toEqual(library(HASH_A, "Aurora"));
    expect(store.hasKeptTheme(HASH_A)).toBe(true);
    expect(readKeptThemeHashes(storage)).toEqual([HASH_A]);
    expect(JSON.parse(storage.values.get(THEME_STORAGE_KEY)!)).toMatchObject({
      kind: "library",
      hash: HASH_A,
      base: "dark",
    });
    // The pre-paint record follows the committed theme.
    expect(JSON.parse(storage.values.get(THEME_PAINT_STORAGE_KEY)!)).toMatchObject({
      hash: HASH_A,
      base: "dark",
      surface: "#0a1029",
    });

    const later = store.startThemeTrial({
      choice: { kind: "builtin", id: "dark" },
      manifest: null,
    });
    store.endThemeTrial(later.id);
    store.commitThemeTrial(later.id);
    expect(store.getState().committed).toEqual(library(HASH_A, "Aurora"));
  });

  it("ends this window's trial when another window commits a choice, and adopts it", () => {
    const { env, storage } = makeEnv({});
    const store = createThemeStoreCore(env);
    store.startThemeTrial({ choice: library(HASH_A, "Aurora"), manifest: manifest("Aurora") });

    storage.setItem(THEME_STORAGE_KEY, "light");
    store.handleStorageChange(THEME_STORAGE_KEY);
    expect(store.getState().trial).toBeNull();
    expect(store.getState().active).toMatchObject({
      choice: { kind: "builtin", id: "light" },
      base: "light",
    });
  });

  it("falls back to the theme's base when its content is nowhere, and recovers once a computer has it", async () => {
    const saved = library(HASH_A, "Aurora");
    const content: Record<string, ThemeManifest> = {};
    const { env } = makeEnv({
      storage: memoryStorage({ [THEME_STORAGE_KEY]: serializeThemeChoice(saved, "dark") }),
      content,
    });
    const store = createThemeStoreCore(env);
    await flush();
    expect(store.getState().committedState).toEqual({ status: "unavailable", reason: "missing" });
    expect(store.getState().active).toMatchObject({
      choice: saved,
      tokens: null,
      base: "dark",
      name: "Aurora",
    });

    content[HASH_A] = manifest("Aurora");
    store.retryUnavailable();
    await flush();
    expect(store.getState().active).toMatchObject({ hash: HASH_A, base: "dark" });
    expect(store.getState().active.tokens?.background).toBe("#0a1029");
  });
});
