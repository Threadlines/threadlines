import { assert, describe, it } from "@effect/vitest";

import {
  halfAwakeFromSystemState,
  type HalfAwakeStreak,
  lastSleepFromSysctl,
  nextHalfAwakeStreak,
  STREAK_LIMIT_MS,
  type WakeReading,
  waitsForFullWake,
} from "./systemWakeState.ts";

/** The streak after these readings, from none. */
const streakAfter = (readings: ReadonlyArray<WakeReading>) =>
  readings.reduce<HalfAwakeStreak | null>(nextHalfAwakeStreak, null);

/** Half-awake readings `stepMs` apart for `spanMs`; `sleepsBetween` puts a short sleep before each. */
const halfAwakeReadings = (spanMs: number, stepMs: number, sleepsBetween: boolean) =>
  Array.from({ length: spanMs / stepMs + 1 }, (_, i) => ({
    halfAwake: true,
    wallMs: i * stepMs,
    lastSleepMs: sleepsBetween ? i * stepMs - 20_000 : -60_000,
  }));

describe("systemWakeState", () => {
  it("reads a dark wake from pmset's capabilities, and the last sleep from sysctl", () => {
    assert.isFalse(
      halfAwakeFromSystemState(
        "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n",
      ),
    );
    assert.isTrue(
      halfAwakeFromSystemState(
        "Current System Capabilities are: CPU Network \nCurrent Power State: 4\n",
      ),
    );
    assert.isNull(halfAwakeFromSystemState("pmset: unknown option"));
    assert.equal(
      lastSleepFromSysctl("{ sec = 1794237662, usec = 241955 } Mon Nov  9 10:21:02 2026\n"),
      1_794_237_662_241,
    );
    assert.isNull(lastSleepFromSysctl(""));
  });

  it("waits through upkeep wakes however close together, but not past a reading too long to trust", () => {
    const minute = 60_000;
    // Upkeep wakes 90 seconds apart for 15 minutes, with a short sleep before each.
    assert.isTrue(waitsForFullWake(streakAfter(halfAwakeReadings(15 * minute, 90_000, true))));
    // A full wake ends the wait.
    assert.isFalse(
      waitsForFullWake(
        streakAfter([
          { halfAwake: true, wallMs: 0, lastSleepMs: -1 },
          { halfAwake: false, wallMs: 30_000, lastSleepMs: -1 },
        ]),
      ),
    );
    // A reading that couldn't say when the last sleep was still lets the
    // next one show the sleep: the streak starts again at 12 minutes.
    const unreadable = [
      ...halfAwakeReadings(6 * minute, 30_000, false),
      { halfAwake: true, wallMs: 7 * minute, lastSleepMs: null },
      { halfAwake: true, wallMs: 12 * minute, lastSleepMs: 11 * minute },
      { halfAwake: true, wallMs: 13 * minute, lastSleepMs: 11 * minute },
    ];
    assert.equal(streakAfter(unreadable)?.sinceWallMs, 12 * minute);
    assert.isTrue(waitsForFullWake(streakAfter(unreadable)));
    // Half awake for 10 minutes with no sleep at all: distrusted, so work starts.
    assert.isTrue(waitsForFullWake(streakAfter(halfAwakeReadings(9 * minute, 30_000, false))));
    assert.isFalse(
      waitsForFullWake(streakAfter(halfAwakeReadings(STREAK_LIMIT_MS, 30_000, false))),
    );
  });
});
