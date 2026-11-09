import type { ThemePick } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { choiceOfPickTheme, nextThemePickStep, pickThemeOf } from "./themePickSync";

const pick = (revision: number, id: "dark" | "light" = "dark"): ThemePick => ({
  theme: { kind: "builtin", id },
  revision,
  revisedBy: "env-mac",
  updatedAt: "2026-11-09T12:00:00.000Z",
});

const step = (input: Partial<Parameters<typeof nextThemePickStep>[0]> = {}) =>
  nextThemePickStep({
    hydrated: true,
    on: true,
    bypass: false,
    trialRunning: false,
    winning: null,
    canPublish: true,
    state: { seen: null, pending: null },
    ...input,
  });

describe("same theme on all my devices", () => {
  it("follows a newer pick, but never an older one or one already seen", () => {
    expect(step({ winning: pick(5) })).toEqual({ kind: "apply", pick: pick(5) });
    const seen = { revision: 5, revisedBy: "env-mac" };
    expect(step({ winning: pick(5), state: { seen, pending: null } })).toEqual({ kind: "wait" });
    // The computer with the newest pick dropped off: the older one left doesn't roll it back.
    expect(step({ winning: pick(3), state: { seen, pending: null } })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(6), state: { seen, pending: null } })).toMatchObject({
      kind: "apply",
    });
  });

  it("does nothing before settings load, under ?theme=default, or while a trial shows", () => {
    expect(step({ winning: pick(5), hydrated: false })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), bypass: true })).toEqual({ kind: "wait" });
    expect(step({ winning: pick(5), trialRunning: true })).toEqual({ kind: "wait" });
  });

  it("shares a pick made here unless a newer one overtook it, and drops it when switched off", () => {
    const pending = {
      theme: { kind: "builtin", id: "light" },
      known: { revision: 5, revisedBy: "env-mac" },
    };
    expect(step({ winning: pick(5), state: { seen: null, pending } })).toEqual({
      kind: "publish",
      pending,
    });
    // No computer keeps picks yet (older servers): it waits for one.
    expect(step({ winning: null, canPublish: false, state: { seen: null, pending } })).toEqual({
      kind: "wait",
    });
    // Someone picked elsewhere after this device did: theirs wins, this one goes.
    expect(step({ winning: pick(7), state: { seen: null, pending } })).toEqual({
      kind: "drop-pending",
    });
    expect(step({ on: false, state: { seen: null, pending } })).toEqual({ kind: "drop-pending" });
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
