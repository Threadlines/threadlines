import {
  EnvironmentId,
  type ThemeLibrarySnapshot,
  type ThemePick,
  type ThemePickInput,
} from "@threadlines/contracts";
import { sameThemePickTheme } from "@threadlines/shared/themeLibrary";
import { describe, expect, it } from "vite-plus/test";

import type { ThemeChoice } from "../theme/themeTypes";
import {
  choiceOfPickTheme,
  createThemePickSync,
  nextThemePickStep,
  pickThemeOf,
  THEME_PICK_RETRY_MS,
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
    allReported: true,
    ...input,
    state: { seen: null, pending: null, mine: [], ...input.state },
  });

const light = { kind: "builtin", id: "light" };
const builtin = (id: "dark" | "light"): ThemeChoice => ({ kind: "builtin", id });

describe("same theme on all my devices: the next step", () => {
  it("follows a newer pick, but never an older one or one already seen", () => {
    expect(step({ winning: pick(5) })).toMatchObject({ kind: "apply", pick: pick(5) });
    const seen = { revision: 5, revisedBy: "env-mac" };
    expect(step({ winning: pick(5), state: { seen } })).toEqual({ kind: "wait" });
    // The computer with the newest pick dropped off: the older one left doesn't roll it back.
    expect(step({ winning: pick(3), state: { seen } })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(6), state: { seen } })).toMatchObject({ kind: "apply" });
  });

  it("does nothing before settings load, under ?theme=default, or while a trial shows", () => {
    expect(step({ winning: pick(5), hydrated: false })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), bypass: true })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), trialRunning: true })).toEqual({ kind: "wait" });
  });

  it("shares a pick made here unless someone else's newer one overtook it", () => {
    const pending = { id: "p1", theme: light, known: { revision: 5, revisedBy: "env-mac" } };
    expect(step({ winning: pick(5), state: { pending } })).toMatchObject({ kind: "publish" });
    // No computer keeps picks yet (older servers): it waits for one.
    expect(step({ canPublish: false, state: { pending } })).toEqual({ kind: "wait" });
    // Someone picked elsewhere after this device did: theirs wins, this one goes.
    expect(step({ winning: pick(7, "dark", "theirs"), state: { pending } })).toEqual({
      kind: "drop-pending",
    });
    expect(step({ on: false, state: { pending } })).toEqual({ kind: "drop-pending" });
    // It came back carrying its own id: done.
    expect(step({ winning: pick(6, "light", "p1"), state: { pending } })).toMatchObject({
      kind: "landed",
    });
    // An earlier pick of this device's came back first: this one still goes.
    expect(
      step({ winning: pick(6, "dark", "p0"), state: { pending, mine: ["p0"] } }),
    ).toMatchObject({ kind: "publish" });
    // A send a crash left behind names only itself: another device's pick of that theme isn't this device's.
    expect(step({ winning: pick(6, "dark", "theirs"), state: { pending, mine: ["p0"] } })).toEqual({
      kind: "drop-pending",
    });
  });

  it("joins once every computer has reported: their pick if any, else its own theme, if none got there first", () => {
    const pending = { id: "j1", theme: light, known: null, join: true };
    expect(step({ allReported: false, winning: pick(5), state: { pending } })).toEqual({
      kind: "wait",
    });
    // A pick it had seen before turning the switch off is taken all the same.
    expect(
      step({ winning: pick(5), state: { pending, seen: { revision: 5, revisedBy: "env-mac" } } }),
    ).toEqual({ kind: "apply", pick: pick(5), clearPending: true });
    expect(step({ state: { pending } })).toMatchObject({ kind: "publish", onlyIfNone: true });
    // A device whose own theme can't be shared has nothing to offer.
    expect(step({ state: { pending: { ...pending, theme: null } } })).toEqual({
      kind: "drop-pending",
    });
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
// A device (its windows share storage, a lock and a theme), a computer that
// keeps the pick, and answers that arrive when the test lets them.

function makeWorld() {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
  // The computer, as ThemeLibrary.pick decides.
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
  /** Another device's pick, straight onto the computer. */
  const pickElsewhere = (id: "dark" | "light") =>
    decide({ theme: { kind: "builtin", id, pickId: `other-${id}-${server.counter}` }, atLeast: 0 });

  // What this device has been sent of the computer's library.
  let snapshot: ThemeLibrarySnapshot | undefined = { entries: [], pick: null };
  const deliver = () => {
    snapshot = { entries: [], pick: server.pick };
  };
  // Sends wait here until the test answers them.
  const sends: Array<{ input: ThemePickInput; answer: () => void; fail: () => void }> = [];
  let throwOnSend = false;

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

  const openWindow = (): ThemePickSync => {
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
      },
      warn: () => {},
    });
    sync.setSettings({ hydrated: true, on: true });
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
  /** The user picks a theme in a window: the store commits it, then the sync hears. */
  const userPicks = (sync: ThemePickSync, id: "dark" | "light") => {
    theme.committed = builtin(id);
    sync.userCommitted(builtin(id), null);
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
    world.deliver();
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
    world.deliver();
    await world.settle();
    for (const send of world.sends.slice(1)) send.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.showing()).toBe("light");
    // Nothing is left waiting: the second pick was taken as landed, not forgotten.
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
  });

  it("shares a pick made in a second window through the one window that runs the sync", async () => {
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
    // One send, not one a window.
    expect(world.sends).toHaveLength(1);
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
    const window = world.openWindow();
    window.setSettings({ hydrated: true, on: false });
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
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "dark" });
    expect(world.showing()).toBe("dark");
  });

  it("waits for the computer's library before joining, and never runs under ?theme=default", async () => {
    const world = makeWorld();
    world.hideSnapshots();
    const window = world.openWindow();
    window.setSettings({ hydrated: true, on: false });
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
