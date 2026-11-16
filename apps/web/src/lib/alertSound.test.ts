import { describe, expect, it } from "vite-plus/test";

import {
  type AlertSoundPhase,
  type AlertSoundSnapshot,
  type AlertSoundThread,
  alertSoundChanges,
  dueAlertSound,
} from "./alertSound";

const thread = (
  phase: AlertSoundPhase,
  overrides: Partial<AlertSoundThread> = {},
): AlertSoundThread => ({ phase, turnId: "turn-1", filed: false, snapshot: 1, ...overrides });

const snapshot = (threads: Record<string, AlertSoundThread>): AlertSoundSnapshot =>
  new Map(Object.entries(threads));

const nobodyWatching = () => false;

describe("alert sound", () => {
  it("plays only for changes seen happen, needing the user over finishing", () => {
    const before = snapshot({
      a: thread("working"),
      b: thread("working"),
      c: thread("finished"),
      d: thread("working"),
    });
    const after = snapshot({
      a: thread("finished"),
      b: thread("needs-you"),
      c: thread("finished"),
      // Its computer reconnected: what changed meanwhile is a fresh start.
      d: thread("finished", { snapshot: 2 }),
      // New to this app: remembered, not announced.
      e: thread("needs-you"),
    });

    // The first reading after the app opens plays nothing.
    expect(alertSoundChanges(null, after).size).toBe(0);

    const changes = alertSoundChanges(before, after);
    expect(changes).toEqual(
      new Map([
        ["a", "done"],
        ["b", "attention"],
      ]),
    );
    expect(dueAlertSound(changes, after, nobodyWatching)).toBe("attention");
    expect(dueAlertSound(new Map([["a", "done"]]), after, nobodyWatching)).toBe("done");
  });

  it("stays quiet for a thread on screen, filed away, or back at work", () => {
    const before = snapshot({ a: thread("working"), b: thread("working") });
    const after = snapshot({ a: thread("finished"), b: thread("finished", { filed: true }) });
    const changes = alertSoundChanges(before, after);
    // A child whose answer went back to its parent wraps up: no sound.
    expect(changes).toEqual(new Map([["a", "done"]]));

    expect(dueAlertSound(changes, after, (threadKey) => threadKey === "a")).toBeNull();
    // Work handed straight on before the sound was due.
    expect(dueAlertSound(changes, snapshot({ a: thread("working") }), nobodyWatching)).toBeNull();
  });

  it("reads a newer finished turn as news, but not a plan that cleared on the same turn", () => {
    expect(
      alertSoundChanges(
        snapshot({ a: thread("needs-you"), b: thread("needs-you") }),
        snapshot({ a: thread("finished", { turnId: "turn-2" }), b: thread("finished") }),
      ),
    ).toEqual(new Map([["a", "done"]]));
  });
});
