import {
  EnvironmentId,
  type ThemeLibrarySnapshot,
  type ThemeMergePickInput,
  type ThemePick,
  type ThemePickInput,
} from "@threadlines/contracts";
import { compareThemeRevisions, sameThemePickTheme } from "@threadlines/shared/themeLibrary";
import { describe, expect, it } from "vite-plus/test";

import type { ThemeChoice } from "../theme/themeTypes";
import {
  choiceOfPickTheme,
  createThemePickSync,
  nextThemePickStep,
  pickThemeOf,
  THEME_PICK_RETRY_MS,
  THEME_PICK_STORAGE_PREFIX,
  type ThemePickSync,
} from "./themePickSync";

const mac = EnvironmentId.make("env-mac");

const pick = (revision: number, id: "dark" | "light" = "dark", pickId?: string): ThemePick => ({
  theme: { kind: "builtin", id, ...(pickId === undefined ? {} : { pickId }) },
  revision,
  revisedBy: "env-mac",
  updatedAt: "2026-11-09T12:00:00.000Z",
});

type StepInput = Parameters<typeof nextThemePickStep>[0];

const step = (
  input: Partial<Omit<StepInput, "state">> & { state?: Partial<StepInput["state"]> } = {},
) =>
  nextThemePickStep({
    hydrated: true,
    on: true,
    bypass: false,
    trialRunning: false,
    winning: null,
    canPublish: true,
    canOffer: true,
    allReported: true,
    shown: { kind: "builtin", id: "dark" },
    ...input,
    state: { device: "dev", seen: null, pending: null, join: null, ...input.state },
  });

const light = { kind: "builtin", id: "light" };
const builtin = (id: "dark" | "light"): ThemeChoice => ({ kind: "builtin", id });

describe("same theme on all my devices: the next step", () => {
  it("follows a newer pick, but never an older one or one already taken", () => {
    expect(step({ winning: pick(5) })).toEqual({ kind: "apply", pick: pick(5) });
    const seen = pick(5);
    expect(step({ winning: pick(5), state: { seen } })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(3, "light"), state: { seen } })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(6), state: { seen } })).toMatchObject({ kind: "apply" });
  });

  it("does nothing before settings load, with the switch off, under ?theme=default, or while a trial shows", () => {
    expect(step({ winning: pick(5), hydrated: false })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), on: false })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), bypass: true })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), trialRunning: true })).toEqual({ kind: "wait" });
  });

  it("shares a pick made here unless someone else's newer one overtook it", () => {
    const pending = { id: "p1", theme: light, known: { revision: 5, revisedBy: "env-mac" } };
    expect(step({ winning: pick(5), state: { pending } })).toMatchObject({
      kind: "publish",
      id: "p1",
      onlyIfNone: false,
    });
    // No computer keeps picks yet (older servers): it waits for one.
    expect(step({ canPublish: false, state: { pending } })).toEqual({ kind: "wait" });
    // Someone picked elsewhere after this device did: theirs wins, this one is put aside.
    expect(step({ winning: pick(7, "dark", "other.x"), state: { pending } })).toEqual({
      kind: "finish",
      id: "p1",
    });
    // It came back carrying this device's id and its own: done.
    expect(step({ winning: pick(6, "light", "dev.p1"), state: { pending } })).toMatchObject({
      kind: "landed",
      id: "p1",
    });
    // An earlier pick of this device's came back first, however long ago it was sent: this one still goes.
    expect(step({ winning: pick(6, "dark", "dev.p0"), state: { pending } })).toMatchObject({
      kind: "publish",
    });
    // A pick from the first build names no device: it is someone else's.
    expect(step({ winning: pick(6), state: { pending } })).toEqual({ kind: "finish", id: "p1" });
    // A theme kept on this device only puts aside what was waiting.
    expect(step({ state: { pending: { ...pending, theme: null } } })).toEqual({
      kind: "finish",
      id: "p1",
    });
  });

  it("joins once every computer has reported: the newest pick known, else its own theme where that can't replace one", () => {
    const join = { id: "j1", theme: light };
    expect(step({ allReported: false, winning: pick(5), state: { join } })).toEqual({
      kind: "wait",
    });
    // A pick it had taken before turning the switch off is taken all the same.
    expect(step({ winning: pick(5), state: { join, seen: pick(5) } })).toEqual({
      kind: "apply",
      pick: pick(5),
      finish: "j1",
    });
    // The pick it remembers is newer than what the computers left hold: that one.
    expect(step({ winning: pick(5), state: { join, seen: pick(9, "light") } })).toMatchObject({
      kind: "apply",
      pick: { revision: 9 },
    });
    expect(step({ state: { join } })).toMatchObject({ kind: "publish", onlyIfNone: true });
    // A computer from the first build would let it replace a pick: it doesn't offer.
    expect(step({ canOffer: false, state: { join } })).toEqual({ kind: "wait" });
    // A device whose own theme can't be shared has nothing to offer.
    expect(step({ state: { join: { id: "j1", theme: null } } })).toEqual({
      kind: "finish",
      id: "j1",
    });
    // A theme picked since supersedes joining.
    const pending = { id: "p1", theme: light, known: null };
    expect(step({ state: { join, pending } })).toEqual({ kind: "finish", id: "j1" });
  });

  it("takes the pick again when the device shows another theme with nothing waiting to be shared", () => {
    const seen = pick(6, "light");
    expect(step({ winning: seen, state: { seen } })).toEqual({ kind: "apply", pick: seen });
    // Not a theme the user keeps on this device only, and not the theme it should show.
    expect(step({ winning: seen, shown: null, state: { seen } })).toEqual({ kind: "wait" });
    expect(step({ winning: seen, shown: light, state: { seen } })).toEqual({ kind: "wait" });
  });

  it("shares built-ins, starters and library themes with their base, never one kept on this device only", () => {
    const library = {
      kind: "library",
      entryId: "e1",
      hash: "a".repeat(64),
      name: "Night",
      environmentId: null,
    } as const;
    const theme = pickThemeOf(library, "dark");
    expect(theme).toEqual({
      kind: "library",
      entryId: "e1",
      hash: "a".repeat(64),
      name: "Night",
      base: "dark",
    });
    expect(choiceOfPickTheme(theme!)).toEqual({ choice: library, base: "dark" });
    expect(
      pickThemeOf({ kind: "unsaved", hash: "a".repeat(64), name: "Night" }, "dark"),
    ).toBeNull();
    // A kind a later build added, or a value this one can't show: passed over.
    expect(choiceOfPickTheme({ kind: "showcase", id: "x" })).toBeNull();
    expect(choiceOfPickTheme({ kind: "library", entryId: "e1", hash: "not-a-hash" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A device (its windows share storage, a lock and the theme storage holds), a
// computer that keeps the pick, and answers that arrive when the test lets them.

function makeWorld(options: { readonly pickVersion?: number } = {}) {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
  // The computer, as ThemeLibrary.pick and mergePick decide.
  const server = { pick: null as ThemePick | null, counter: 0 };
  const decide = (input: ThemePickInput): ThemePick => {
    const current = server.pick;
    if (current !== null && input.onlyIfNone === true) return current;
    if (
      current !== null &&
      sameThemePickTheme(current.theme, input.theme) &&
      current.revision > input.atLeast
    ) {
      return current;
    }
    server.counter = Math.max(server.counter + 1, input.atLeast + 1);
    server.pick = {
      theme: input.theme,
      revision: server.counter,
      revisedBy: "env-mac",
      updatedAt: "2026-11-09T12:00:00.000Z",
    };
    return server.pick;
  };
  const merge = (input: ThemeMergePickInput): ThemePick => {
    if (server.pick === null || compareThemeRevisions(input.pick, server.pick) > 0) {
      server.pick = input.pick;
      server.counter = Math.max(server.counter, input.pick.revision);
    }
    return server.pick;
  };
  /** Another device's pick, straight onto the computer. */
  const pickElsewhere = (id: "dark" | "light") =>
    decide({ theme: { kind: "builtin", id, pickId: `other.${server.counter}` }, atLeast: 0 });

  // What this device has been sent of the computer's library.
  let snapshot: ThemeLibrarySnapshot | undefined;
  const deliver = () => {
    snapshot = {
      entries: [],
      pick: server.pick,
      ...(options.pickVersion === undefined ? { pickVersion: 2 } : {}),
    };
  };
  deliver();
  // Sends wait here until the test answers them.
  const sends: Array<{ input: ThemePickInput; answer: () => void; fail: () => void }> = [];
  let throwOnSend = false;

  // The device's theme, as storage holds it for every window.
  const theme = {
    committed: builtin("dark") as ThemeChoice,
    trialRunning: false,
    bypass: false,
  };
  const lock = { holder: null as (() => void) | null, waiting: [] as Array<() => void> };
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  let now = 0;
  let ids = 0;
  const windows: ThemePickSync[] = [];

  const openWindow = (
    settings: { hydrated: boolean; on: boolean } = { hydrated: true, on: true },
  ) => {
    const sync = createThemePickSync({
      storage,
      now: () => now,
      setTimer: (callback, ms) => {
        const timer = { at: now + ms, callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      randomId: () => `id-${(ids += 1)}`,
      requestLead: (lead) => {
        if (lock.holder === null) {
          lock.holder = lead;
          lead();
        } else {
          lock.waiting.push(lead);
        }
        return () => {
          if (lock.holder !== lead) return;
          lock.holder = lock.waiting.shift() ?? null;
          lock.holder?.();
        };
      },
      theme: {
        state: () => ({ ...theme, committedBase: null }),
        applyPick: (choice) => {
          theme.committed = choice;
        },
        manifestOf: () => null,
      },
      library: {
        followed: () => [mac],
        snapshots: () => (snapshot === undefined ? {} : { [mac]: snapshot }),
        pick: (_environmentId, input) => {
          if (throwOnSend) throw new Error("That computer isn't connected right now.");
          return new Promise((resolve, reject) => {
            sends.push({
              input,
              answer: () => resolve(decide(input)),
              fail: () => reject(new Error("connection dropped")),
            });
          });
        },
        mergePick: async (_environmentId, input) => merge(input),
      },
      warn: () => {},
    });
    sync.setSettings(settings);
    windows.push(sync);
    return sync;
  };

  /** Lets promises settle and every window hear what changed, as storage and library events would. */
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const sync of windows) sync.run();
    }
  };
  /** The user picks a theme in a window: the store saves it and the sync writes the pick down, together. */
  const userPicks = (sync: ThemePickSync, choice: "dark" | "light" | ThemeChoice) => {
    theme.committed = typeof choice === "string" ? builtin(choice) : choice;
    sync.userCommitted(theme.committed, null);
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
      timer.cancelled = true;
      timer.callback();
    }
    await settle();
  };

  return {
    server,
    sends,
    theme,
    storage,
    openWindow,
    settle,
    userPicks,
    pickElsewhere,
    deliver,
    advance,
    hideSnapshots: () => {
      snapshot = undefined;
    },
    throwOnSend: (value: boolean) => {
      throwOnSend = value;
    },
    showing: () => (theme.committed.kind === "builtin" ? theme.committed.id : theme.committed.kind),
    note: (name: string) => {
      const raw = stored.get(`${THEME_PICK_STORAGE_PREFIX}${name}`);
      return raw === undefined ? null : (JSON.parse(raw) as unknown);
    },
  };
}

describe("same theme on all my devices: a device and its computer", () => {
  it("sends a pick made while an earlier one is still out, whatever order the answers come in", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    world.userPicks(window, "dark");
    await world.settle();
    // The first pick lands, and its snapshot arrives before its answer does.
    world.sends[0]!.answer();
    world.deliver();
    await world.settle();
    expect(world.sends).toHaveLength(2);
    world.sends[1]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ kind: "builtin", id: "dark" });
    expect(world.showing()).toBe("dark");
  });

  it("shows its own pick when it lands late, after another device's pick was followed meanwhile", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    // Another device picks dark before this one's light reaches the computer.
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
    // The light pick was already on its way: it lands above dark, and every device shows it.
    world.sends[0]!.answer();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.showing()).toBe("light");
  });

  it("doesn't let an old answer stand in for a newer pick of the same theme", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    // The user picks light again; the first light's answer is only now coming back.
    world.userPicks(window, "light");
    await world.settle();
    world.sends[0]!.answer();
    await world.settle();
    for (const send of world.sends.slice(1)) send.answer();
    world.deliver();
    await world.settle();
    expect(world.sends).toHaveLength(2);
    expect(world.server.pick?.theme).toMatchObject({ id: "light", pickId: expect.any(String) });
    expect(world.showing()).toBe("light");
    // Nothing is left waiting: the next pick from elsewhere is followed.
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
  });

  it("shares a pick made in a second window through the one window that runs the sync, once", async () => {
    const world = makeWorld();
    world.openWindow();
    const second = world.openWindow();
    world.userPicks(second, "light");
    await world.settle();
    expect(world.sends).toHaveLength(1);
    world.sends[0]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.sends).toHaveLength(1);
  });

  it("follows a pick from elsewhere that arrives just as a second window picks, and shows what the others show", async () => {
    const world = makeWorld();
    world.openWindow();
    const second = world.openWindow();
    world.pickElsewhere("light");
    world.deliver();
    await world.settle();
    // The other device's dark is already on the computer when the second window picks light.
    world.pickElsewhere("dark");
    world.userPicks(second, "light");
    world.deliver();
    await world.settle();
    for (const send of world.sends) send.answer();
    world.deliver();
    await world.settle();
    const shared = world.server.pick!.theme.id;
    expect(world.showing()).toBe(shared);
  });

  it("takes the shared pick again when the device ends up showing another theme with nothing to share", async () => {
    const world = makeWorld();
    world.openWindow();
    world.pickElsewhere("light");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("light");
    // Two windows crossed: the device's theme went back without a pick being made.
    world.theme.committed = builtin("dark");
    await world.settle();
    expect(world.showing()).toBe("light");
    // A theme the user keeps on this device only is theirs to keep.
    const window = world.openWindow();
    world.userPicks(window, { kind: "unsaved", hash: "a".repeat(64), name: "Mine" });
    await world.settle();
    expect(world.showing()).toBe("unsaved");
    expect(world.sends).toHaveLength(0);
  });

  it("hands the sync to another window when the one running it closes with a pick unsent", async () => {
    const world = makeWorld();
    const first = world.openWindow();
    world.openWindow();
    world.userPicks(first, "light");
    await world.settle();
    world.sends[0]!.fail();
    await world.settle();
    first.stop();
    await world.advance(THEME_PICK_RETRY_MS);
    expect(world.sends).toHaveLength(2);
    world.sends[1]!.answer();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
  });

  it("tries a failed send again, also when it failed at once or twice in a row", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.throwOnSend(true);
    world.userPicks(window, "light");
    await world.settle();
    world.throwOnSend(false);
    await world.advance(10_000);
    expect(world.sends).toHaveLength(0);
    // A second pick goes at once, and fails too: the retry still comes, counted from this failure.
    world.userPicks(window, "dark");
    await world.settle();
    expect(world.sends).toHaveLength(1);
    world.sends[0]!.fail();
    await world.settle();
    await world.advance(THEME_PICK_RETRY_MS - 5_000);
    expect(world.sends).toHaveLength(1);
    await world.advance(5_000);
    expect(world.sends).toHaveLength(2);
    world.sends[1]!.answer();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "dark" });
  });

  it("joining takes a pick that got there first instead of replacing it", async () => {
    const world = makeWorld();
    const window = world.openWindow({ hydrated: true, on: false });
    world.userPicks(window, "light");
    await world.settle();
    expect(world.sends).toHaveLength(0);
    // The switch turns on while this device still believes nobody has picked.
    window.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.sends[0]!.input).toMatchObject({ theme: { id: "light" }, onlyIfNone: true });
    world.pickElsewhere("dark");
    world.sends[0]!.answer();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "dark" });
    expect(world.showing()).toBe("dark");
  });

  it("doesn't offer its theme when joining a computer from the first build, which would let it replace a pick", async () => {
    const world = makeWorld({ pickVersion: 1 });
    const window = world.openWindow({ hydrated: true, on: false });
    world.userPicks(window, "light");
    window.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.sends).toHaveLength(0);
    // A pick made there later is followed as ever.
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
  });

  it("keeps a pick made after the switch turned on when a second window hears of the switch late", async () => {
    const world = makeWorld();
    const first = world.openWindow({ hydrated: true, on: false });
    const second = world.openWindow({ hydrated: true, on: false });
    first.setSettings({ hydrated: true, on: true });
    await world.settle();
    for (const send of world.sends) send.answer();
    world.deliver();
    await world.settle();
    world.userPicks(first, "light");
    await world.settle();
    world.sends.at(-1)!.fail();
    await world.settle();
    // Only now does the second window learn the switch is on.
    second.setSettings({ hydrated: true, on: true });
    await world.settle();
    await world.advance(THEME_PICK_RETRY_MS);
    world.sends.at(-1)!.answer();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.showing()).toBe("light");
  });

  it("brings the pick it remembers to a computer that fell behind it, and follows what is picked there after", async () => {
    const world = makeWorld();
    // The device took revision 100 from a computer it no longer reaches; this one holds revision 50.
    world.storage.setItem(`${THEME_PICK_STORAGE_PREFIX}seen`, JSON.stringify(pick(100, "light")));
    world.theme.committed = builtin("light");
    world.server.pick = pick(50, "dark", "other.1");
    world.server.counter = 50;
    world.deliver();
    world.openWindow();
    await world.settle();
    expect(world.server.pick).toMatchObject({ revision: 100 });
    expect(world.showing()).toBe("light");
    world.deliver();
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.server.pick).toMatchObject({ revision: 101 });
    expect(world.showing()).toBe("dark");
  });

  it("carries over what the first build left: the pick it showed isn't applied again, one it never sent still goes", async () => {
    const world = makeWorld();
    world.server.pick = pick(7, "dark");
    world.server.counter = 7;
    world.deliver();
    world.theme.committed = builtin("light");
    world.storage.setItem(
      "threadlines:theme-pick",
      JSON.stringify({
        seen: { revision: 7, revisedBy: "env-mac" },
        observed: { revision: 7, revisedBy: "env-mac" },
        pending: { theme: light, known: { revision: 7, revisedBy: "env-mac" } },
        outgoing: [],
      }),
    );
    world.openWindow();
    await world.settle();
    expect(world.storage.getItem("threadlines:theme-pick")).toBeNull();
    expect(world.sends).toHaveLength(1);
    world.sends[0]!.answer();
    await world.settle();
    expect(world.server.pick).toMatchObject({ theme: { id: "light" }, revision: 8 });
    expect(world.showing()).toBe("light");
  });

  it("waits for the computer's library before joining, and never runs under ?theme=default", async () => {
    const world = makeWorld();
    world.hideSnapshots();
    const window = world.openWindow({ hydrated: true, on: false });
    window.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.sends).toHaveLength(0);

    const bypassed = makeWorld();
    bypassed.theme.bypass = true;
    bypassed.openWindow();
    bypassed.pickElsewhere("light");
    bypassed.deliver();
    await bypassed.settle();
    expect(bypassed.showing()).toBe("dark");
  });
});
