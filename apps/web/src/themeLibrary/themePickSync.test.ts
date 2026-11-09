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
  THEME_PICK_CLAIM_MS,
  THEME_PICK_FRESH_MS,
  THEME_PICK_NOTE_KEY,
  THEME_PICK_RETRY_MS,
  type ThemePickNote,
  type ThemePickSync,
} from "./themePickSync";

const mac = EnvironmentId.make("env-mac");

const pick = (revision: number, id: "dark" | "light" = "dark", pickId?: string): ThemePick => ({
  theme: { kind: "builtin", id, ...(pickId === undefined ? {} : { pickId }) },
  revision,
  revisedBy: "env-mac",
  updatedAt: "2026-11-09T12:00:00.000Z",
});
const at = (revision: number) => ({ revision, revisedBy: "env-mac" });
const taken = (revision: number): ThemePickNote => ({ state: "taken", ...at(revision) });
const light = { kind: "builtin", id: "light" };
const dark = { kind: "builtin", id: "dark" };
const builtin = (id: "dark" | "light"): ThemeChoice => ({ kind: "builtin", id });

const step = (input: Partial<Parameters<typeof nextThemePickStep>[0]> = {}) =>
  nextThemePickStep({
    hydrated: true,
    on: true,
    bypass: false,
    trialRunning: false,
    winning: null,
    canPublish: true,
    allReported: true,
    shown: dark,
    note: null,
    joining: false,
    mine: null,
    sending: null,
    retryAt: 0,
    now: 1_000_000,
    ...input,
  });

describe("same theme on all my devices: the next step", () => {
  it("takes a newer pick, never an older one or the one it has", () => {
    expect(step({ winning: pick(5) })).toEqual({ kind: "take", pick: pick(5) });
    expect(step({ winning: pick(5), note: taken(5) })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(3, "light"), note: taken(5) })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(6, "light"), note: taken(5) })).toMatchObject({ kind: "take" });
  });

  it("does nothing before settings load, with the switch off or under ?theme=default; a trial holds a pick that would end it", () => {
    expect(step({ winning: pick(5), hydrated: false })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), on: false })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), bypass: true })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5, "light"), trialRunning: true })).toEqual({ kind: "wait" });
    // A pick the device already shows only needs noting.
    expect(step({ winning: pick(5), trialRunning: true })).toMatchObject({ kind: "take" });
  });

  it("keeps the user's own theme against picks it already knew, and takes a newer one", () => {
    const local: ThemePickNote = { state: "local", known: at(6) };
    expect(step({ winning: pick(6, "light"), note: local, shown: null })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(7, "light"), note: local, shown: null })).toMatchObject({
      kind: "take",
    });
  });

  it("sends the pick made in this window, leaves another window's to it for a while, then takes it over", () => {
    const now = 1_000_000;
    const unsent: ThemePickNote = {
      state: "unsent",
      id: "p1",
      theme: light,
      known: at(5),
      since: now,
      at: now,
    };
    expect(step({ note: unsent, mine: "p1" })).toEqual({ kind: "send", note: unsent });
    expect(step({ note: unsent, mine: "p1", sending: "p1" })).toEqual({ kind: "wait" });
    // An earlier pick of this window's is still out: this one goes after its answer.
    expect(step({ note: unsent, mine: "p1", sending: "p0" })).toEqual({ kind: "wait" });
    expect(step({ note: unsent })).toEqual({ kind: "wait", until: now + THEME_PICK_CLAIM_MS });
    expect(step({ note: unsent, now: now + THEME_PICK_CLAIM_MS })).toMatchObject({ kind: "send" });
    // No computer keeps picks, or this window is waiting out a failure.
    expect(step({ note: unsent, mine: "p1", canPublish: false })).toEqual({ kind: "wait" });
    expect(step({ note: unsent, mine: "p1", retryAt: now + 9 })).toEqual({
      kind: "wait",
      until: now + 9,
    });
    // It came back carrying its id: taken.
    expect(step({ note: unsent, winning: pick(6, "light", "p1"), shown: light })).toMatchObject({
      kind: "take",
    });
    // Someone else's newer pick doesn't stop a fresh one; one that couldn't be sent for a minute gives way.
    expect(step({ note: unsent, mine: "p1", winning: pick(7, "dark", "x") })).toMatchObject({
      kind: "send",
    });
    expect(
      step({
        note: unsent,
        mine: "p1",
        winning: pick(7, "dark", "x"),
        now: now + THEME_PICK_FRESH_MS + 1,
      }),
    ).toMatchObject({ kind: "take", pick: { revision: 7 } });
  });

  it("with the note off, only a window that saw the switch turn on joins, once every computer has reported", () => {
    const off: ThemePickNote = { state: "off" };
    expect(step({ note: off, winning: pick(5, "light") })).toEqual({ kind: "wait" });
    expect(step({ note: off, joining: true, allReported: false, winning: pick(5) })).toEqual({
      kind: "wait",
    });
    expect(step({ note: off, joining: true, winning: pick(5, "light") })).toMatchObject({
      kind: "take",
    });
    expect(step({ note: off, joining: true })).toEqual({ kind: "joined" });
  });

  it("passes over the device's own earlier pick when it lands after the user kept a theme here", () => {
    const local: ThemePickNote = { state: "local", known: at(5), past: "p1" };
    expect(step({ note: local, winning: pick(6, "light", "p1"), shown: null })).toEqual({
      kind: "wait",
    });
    expect(step({ note: local, winning: pick(6, "light", "x"), shown: null })).toMatchObject({
      kind: "take",
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
// A device (its windows share storage and the theme storage holds), a computer
// that keeps the pick, and sends that land and answer when the test lets them.

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
    decide({ theme: { kind: "builtin", id, pickId: `other-${server.counter}` }, atLeast: 0 });

  // What this device has been sent of the computer's library.
  let snapshot: ThemeLibrarySnapshot | undefined;
  const deliver = () => {
    snapshot = { entries: [], pick: server.pick };
  };
  deliver();
  // A send reaches the computer (`land`) and its answer reaches the window (`reply`) separately.
  interface Send {
    readonly input: ThemePickInput;
    readonly land: () => void;
    readonly reply: () => void;
    readonly answer: () => void;
    readonly fail: () => void;
  }
  const sends: Send[] = [];
  let throwOnSend = false;

  // The device's theme, as storage holds it for every window.
  const theme = {
    committed: builtin("dark") as ThemeChoice,
    trialRunning: false,
    bypass: false,
  };
  let applied = 0;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  let now = 1_000_000;
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
      theme: {
        state: () => ({ ...theme, committedBase: null }),
        applyPick: (choice) => {
          applied += 1;
          theme.committed = choice;
        },
      },
      library: {
        followed: () => [mac],
        snapshots: () => (snapshot === undefined ? {} : { [mac]: snapshot }),
        pick: (_environmentId, input) => {
          if (throwOnSend) throw new Error("That computer isn't connected right now.");
          return new Promise((resolve, reject) => {
            let landed: ThemePick | null = null;
            const land = () => {
              landed ??= decide(input);
            };
            const reply = () => {
              land();
              resolve(landed!);
            };
            sends.push({
              input,
              land,
              reply,
              answer: reply,
              fail: () => reject(new Error("connection dropped")),
            });
          });
        },
      },
      warn: () => {},
    });
    sync.setSettings(settings);
    windows.push(sync);
    return sync;
  };

  /** Lets promises settle and every open window hear what changed, as storage and library events would. */
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const sync of windows) sync.run();
    }
  };
  /** The user picks a theme in a window: the commit is announced, then the store writes the theme. */
  const userPicks = (sync: ThemePickSync, choice: "dark" | "light" | ThemeChoice) => {
    const next = typeof choice === "string" ? builtin(choice) : choice;
    sync.userCommitted(next, null);
    theme.committed = next;
    theme.trialRunning = false;
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
      timer.cancelled = true;
      timer.callback();
    }
    await settle();
  };
  const close = (sync: ThemePickSync) => {
    sync.stop();
    windows.splice(windows.indexOf(sync), 1);
  };

  return {
    server,
    sends,
    theme,
    storage,
    openWindow,
    close,
    settle,
    userPicks,
    pickElsewhere,
    deliver,
    advance,
    /** A pick the device hears of that its computer doesn't hold yet (another computer's). */
    hear: (heard: ThemePick) => {
      snapshot = { entries: [], pick: heard };
    },
    hideSnapshots: () => {
      snapshot = undefined;
    },
    throwOnSend: (value: boolean) => {
      throwOnSend = value;
    },
    showing: () => (theme.committed.kind === "builtin" ? theme.committed.id : theme.committed.kind),
    applied: () => applied,
    note: () => JSON.parse(stored.get(THEME_PICK_NOTE_KEY) ?? "null") as ThemePickNote | null,
  };
}

describe("same theme on all my devices: a device and its computer", () => {
  it("follows a pick made elsewhere, in every window, applying it once", async () => {
    const world = makeWorld();
    world.openWindow();
    world.openWindow();
    world.pickElsewhere("light");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("light");
    expect(world.applied()).toBe(1);
    expect(world.note()).toMatchObject({ state: "taken", revision: 1 });
  });

  it("sends a pick made while an earlier one is still out, also when the first landed before its answer came", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    world.userPicks(window, "dark");
    await world.settle();
    // The first pick is on the computer and in its snapshot; its answer is still on the way.
    world.sends[0]!.land();
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
    world.sends[0]!.reply();
    await world.settle();
    expect(world.sends).toHaveLength(2);
    world.sends[1]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ kind: "builtin", id: "dark" });
    expect(world.showing()).toBe("dark");
    expect(world.note()).toMatchObject({ state: "taken", revision: 2 });
  });

  it("sends the user's newer pick at once when the earlier one's send fails", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    world.userPicks(window, "dark");
    await world.settle();
    expect(world.sends).toHaveLength(1);
    world.sends[0]!.fail();
    await world.settle();
    expect(world.sends).toHaveLength(2);
    expect(world.sends[1]!.input.theme).toMatchObject({ id: "dark" });
  });

  it("keeps the user's pick on screen while it is on its way, and it wins over one that reached the computer first", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("light");
    world.sends[0]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.showing()).toBe("light");
  });

  it("sends its pick above a newer one it has heard of since the user picked", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.throwOnSend(true);
    world.userPicks(window, "light");
    await world.settle();
    world.hear(pick(9, "dark", "x"));
    world.throwOnSend(false);
    await world.advance(THEME_PICK_RETRY_MS);
    expect(world.showing()).toBe("light");
    world.sends[0]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick).toMatchObject({ revision: 10, theme: { id: "light" } });
    expect(world.note()).toMatchObject({ state: "taken", revision: 10 });
  });

  it("takes the computer's word when it already held the theme the user picked", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    // Another device picked light already, at a revision this one hasn't been shown.
    world.pickElsewhere("light");
    world.userPicks(window, "light");
    await world.settle();
    world.sends[0]!.answer();
    await world.settle();
    expect(world.note()).toMatchObject({ state: "taken", revision: 1 });
    expect(world.sends).toHaveLength(1);
  });

  it("sends a pick made in a second window once, from that window", async () => {
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

  it("has another window send a pick whose window closed before it went, and a window opened later too", async () => {
    const world = makeWorld();
    const first = world.openWindow();
    const second = world.openWindow();
    world.userPicks(first, "light");
    await world.settle();
    world.sends[0]!.fail();
    await world.settle();
    world.close(first);
    expect(world.sends).toHaveLength(1);
    await world.advance(THEME_PICK_CLAIM_MS);
    expect(world.sends).toHaveLength(2);
    world.sends[1]!.fail();
    await world.settle();
    world.close(second);
    // Every window is gone; the note is there for the next one, which leaves the last attempt its time.
    world.openWindow();
    await world.settle();
    expect(world.sends).toHaveLength(2);
    await world.advance(THEME_PICK_CLAIM_MS);
    expect(world.sends).toHaveLength(3);
    world.sends[2]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.note()).toMatchObject({ state: "taken" });
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
    expect(world.showing()).toBe("dark");
  });

  it("gives way to a pick made elsewhere once its own couldn't be sent for a minute", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.throwOnSend(true);
    world.userPicks(window, "light");
    await world.settle();
    world.pickElsewhere("dark");
    world.deliver();
    await world.advance(THEME_PICK_RETRY_MS);
    expect(world.showing()).toBe("light");
    await world.advance(THEME_PICK_RETRY_MS + 1_000);
    expect(world.showing()).toBe("dark");
    expect(world.note()).toMatchObject({ state: "taken" });
    world.throwOnSend(false);
    await world.advance(THEME_PICK_RETRY_MS);
    expect(world.sends).toHaveLength(0);
  });

  it("doesn't share a theme picked with the switch off, and takes the shared pick when it turns on", async () => {
    const world = makeWorld();
    const first = world.openWindow({ hydrated: true, on: false });
    const second = world.openWindow({ hydrated: true, on: false });
    world.pickElsewhere("light");
    world.deliver();
    world.userPicks(first, "dark");
    await world.settle();
    expect(world.showing()).toBe("dark");
    expect(world.note()).toEqual({ state: "off" });
    first.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("light");
    // The user picks again; the second window only now hears of the switch.
    world.userPicks(first, "dark");
    await world.settle();
    second.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("dark");
    world.sends[0]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "dark" });
    expect(world.sends).toHaveLength(1);
  });

  it("a window that hears of the switch late leaves a theme the user kept on this device since", async () => {
    const world = makeWorld();
    const first = world.openWindow({ hydrated: true, on: false });
    const second = world.openWindow({ hydrated: true, on: false });
    world.pickElsewhere("light");
    world.deliver();
    first.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("light");
    world.userPicks(first, { kind: "unsaved", hash: "a".repeat(64), name: "Mine" });
    second.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("unsaved");
  });

  it("turning the switch off drops a pick that hadn't gone, and turning it on takes the shared one", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.throwOnSend(true);
    world.userPicks(window, "light");
    await world.settle();
    window.setSettings({ hydrated: true, on: false });
    world.throwOnSend(false);
    await world.advance(THEME_PICK_RETRY_MS);
    expect(world.sends).toHaveLength(0);
    expect(world.note()).toEqual({ state: "off" });
    // Picks made elsewhere pass the device by until the switch is back on.
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("light");
    window.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("dark");
    expect(world.sends).toHaveLength(0);
  });

  it("turning the switch on with no shared pick changes nothing and sends nothing", async () => {
    const world = makeWorld();
    const window = world.openWindow({ hydrated: true, on: false });
    world.userPicks(window, "light");
    window.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("light");
    expect(world.sends).toHaveLength(0);
    // Waiting for the computer's library is not "no shared pick".
    const waiting = makeWorld();
    waiting.hideSnapshots();
    const other = waiting.openWindow({ hydrated: true, on: false });
    waiting.pickElsewhere("light");
    other.setSettings({ hydrated: true, on: true });
    await waiting.settle();
    expect(waiting.showing()).toBe("dark");
    waiting.deliver();
    await waiting.settle();
    expect(waiting.showing()).toBe("light");
  });

  it("keeps a theme the user picked before settings loaded", async () => {
    const world = makeWorld();
    world.pickElsewhere("light");
    world.deliver();
    const window = world.openWindow({ hydrated: false, on: true });
    world.userPicks(window, "dark");
    window.setSettings({ hydrated: true, on: true });
    await world.settle();
    expect(world.showing()).toBe("dark");
    expect(world.sends).toHaveLength(0);
  });

  it("holds a pick while a trial runs: taken when it ends, passed over when the user keeps the trial's theme here", async () => {
    const world = makeWorld();
    world.openWindow();
    world.theme.trialRunning = true;
    world.pickElsewhere("light");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
    world.theme.trialRunning = false;
    await world.settle();
    expect(world.showing()).toBe("light");

    const kept = makeWorld();
    const window = kept.openWindow();
    kept.theme.trialRunning = true;
    kept.pickElsewhere("light");
    kept.deliver();
    await kept.settle();
    kept.userPicks(window, { kind: "unsaved", hash: "a".repeat(64), name: "Mine" });
    await kept.settle();
    expect(kept.showing()).toBe("unsaved");
    expect(kept.sends).toHaveLength(0);
    // The next pick from elsewhere is taken as ever.
    kept.pickElsewhere("dark");
    kept.deliver();
    await kept.settle();
    expect(kept.showing()).toBe("dark");
  });

  it("passes over its own pick landing after the user kept a theme on this device", async () => {
    const world = makeWorld();
    const window = world.openWindow();
    world.userPicks(window, "light");
    await world.settle();
    world.userPicks(window, { kind: "unsaved", hash: "a".repeat(64), name: "Mine" });
    await world.settle();
    world.sends[0]!.answer();
    world.deliver();
    await world.settle();
    expect(world.server.pick?.theme).toMatchObject({ id: "light" });
    expect(world.showing()).toBe("unsaved");
    expect(world.sends).toHaveLength(1);
    world.pickElsewhere("dark");
    world.deliver();
    await world.settle();
    expect(world.showing()).toBe("dark");
  });

  it("carries over the pick the first build showed, and never runs under ?theme=default", async () => {
    const world = makeWorld();
    world.server.pick = pick(7, "light");
    world.server.counter = 7;
    world.deliver();
    world.storage.setItem(
      "threadlines:theme-pick",
      JSON.stringify({ seen: at(7), observed: at(7), pending: null, outgoing: [] }),
    );
    world.openWindow();
    await world.settle();
    expect(world.storage.getItem("threadlines:theme-pick")).toBeNull();
    expect(world.applied()).toBe(0);

    const bypassed = makeWorld();
    bypassed.theme.bypass = true;
    bypassed.openWindow();
    bypassed.pickElsewhere("light");
    bypassed.deliver();
    await bypassed.settle();
    expect(bypassed.showing()).toBe("dark");
  });
});
