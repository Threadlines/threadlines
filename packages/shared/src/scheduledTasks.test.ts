import type { ScheduledTaskCadence } from "@threadlines/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  cadenceSaveRefusal,
  compileCadence,
  describeCadence,
  dueSlots,
  upcomingSlots,
} from "./scheduledTasks.ts";

const at = (iso: string) => new Date(iso);

const slots = (cadence: ScheduledTaskCadence, timeZone: string, after: string, count = 3) =>
  Result.getOrThrow(upcomingSlots(cadence, timeZone, at(after), count)).map((slot) =>
    slot.toISOString(),
  );

describe("upcomingSlots", () => {
  it("runs each preset at its wall time in the task's zone", () => {
    // Saturday Oct 24 2026, noon UTC.
    expect(slots({ kind: "hourly", minute: 15 }, "UTC", "2026-10-24T12:00:00Z", 2)).toEqual([
      "2026-10-24T12:15:00.000Z",
      "2026-10-24T13:15:00.000Z",
    ]);
    expect(
      slots(
        { kind: "daily", time: { hour: 9, minute: 0 } },
        "Europe/Madrid",
        "2026-10-24T12:00:00Z",
        2,
      ),
    ).toEqual(["2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
    // From a Saturday: Monday and Tuesday, 9:00 New York time.
    expect(
      slots(
        { kind: "weekdays", time: { hour: 9, minute: 0 } },
        "America/New_York",
        "2026-10-24T12:00:00Z",
        2,
      ),
    ).toEqual(["2026-10-26T13:00:00.000Z", "2026-10-27T13:00:00.000Z"]);
    expect(
      slots(
        { kind: "weekly", weekday: 3, time: { hour: 18, minute: 30 } },
        "Asia/Tokyo",
        "2026-10-24T12:00:00Z",
        2,
      ),
    ).toEqual(["2026-10-28T09:30:00.000Z", "2026-11-04T09:30:00.000Z"]);
    expect(slots({ kind: "manual" }, "UTC", "2026-10-24T12:00:00Z")).toEqual([]);
  });

  it("runs a wall time the clocks skip right after the jump, and a repeated one once", () => {
    // Mar 8 2026 in New York: 02:00 jumps to 03:00, so 02:30 runs at 03:30 EDT.
    expect(
      slots(
        { kind: "daily", time: { hour: 2, minute: 30 } },
        "America/New_York",
        "2026-03-07T12:00:00Z",
      ),
    ).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
    // Nov 1 2026: 01:30 happens twice; it runs once, at the first (EDT).
    expect(
      slots(
        { kind: "daily", time: { hour: 1, minute: 30 } },
        "America/New_York",
        "2026-10-31T12:00:00Z",
      ),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
    // Asked during the repeated hour, after its first 01:30 passed: the next
    // run is tomorrow's, never the one already gone.
    expect(
      slots(
        { kind: "daily", time: { hour: 1, minute: 30 } },
        "America/New_York",
        "2026-11-01T06:05:00Z",
        2,
      ),
    ).toEqual(["2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
    expect(
      cadenceSaveRefusal(
        { kind: "custom", cron: "30 1 * * *" },
        "America/New_York",
        at("2026-11-01T06:05:00Z"),
      ),
    ).toBe(null);
  });
});

describe("a cadence across a clock change", () => {
  const custom = (cron: string) => ({ kind: "custom", cron }) as const;
  /**
   * Every whole minute in (after, until] whose own wall clock in `timeZone`
   * reads a minute divisible by `step`: what an every-hour `*\/step` cadence
   * must run at, worked out minute by minute from Intl alone.
   */
  const realMatches = (timeZone: string, after: string, until: string, step: number) => {
    const format = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" });
    const matches: Array<string> = [];
    for (
      let instant = (Math.floor(at(after).getTime() / 60_000) + 1) * 60_000;
      instant <= at(until).getTime();
      instant += 60_000
    ) {
      const minute = format.formatToParts(instant).find((part) => part.type === "minute");
      if (Number(minute?.value) % step === 0) matches.push(new Date(instant).toISOString());
    }
    return matches;
  };
  const sevens = (timeZone: string, after: string, until: string) => {
    const expected = realMatches(timeZone, after, until, 7);
    expect(slots(custom("*/7 * * * *"), timeZone, after, expected.length)).toEqual(expected);
  };
  const gaps = (cadence: ScheduledTaskCadence, timeZone: string, after: string, count: number) => {
    const walked = Result.getOrThrow(upcomingSlots(cadence, timeZone, at(after), count));
    return new Set(
      walked.map(
        (slot, index) => (slot.getTime() - (walked[index - 1] ?? at(after)).getTime()) / 60_000,
      ),
    );
  };

  it("asked inside the repeated hour, runs next after the question, within its own gap", () => {
    // Nov 1 2026, 06:05Z: 01:05 in New York for the second time (EST).
    expect(slots(custom("* * * * *"), "America/New_York", "2026-11-01T06:05:00Z", 2)).toEqual([
      "2026-11-01T06:06:00.000Z",
      "2026-11-01T06:07:00.000Z",
    ]);
    expect(slots(custom("*/15 * * * *"), "America/New_York", "2026-11-01T06:05:00Z", 2)).toEqual([
      "2026-11-01T06:15:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
    // Set hours: 01:30 already ran in the first pass, so tomorrow's.
    expect(slots(custom("30 1 * * *"), "America/New_York", "2026-11-01T06:05:00Z", 1)).toEqual([
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("keeps an every-hour cadence to real time through both passes, in any zone", () => {
    // From 00:00 EDT: every minute, quarter hour and hour, none lost or doubled.
    expect(gaps(custom("* * * * *"), "America/New_York", "2026-11-01T04:00:00Z", 240)).toEqual(
      new Set([1]),
    );
    expect(gaps(custom("*/15 * * * *"), "America/New_York", "2026-11-01T04:00:00Z", 16)).toEqual(
      new Set([15]),
    );
    expect(
      slots({ kind: "hourly", minute: 0 }, "America/New_York", "2026-11-01T04:30:00Z", 3),
    ).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z"]);
    // Oct 25 2026 in Madrid: 03:00 CEST falls back to 02:00 CET.
    expect(gaps(custom("* * * * *"), "Europe/Madrid", "2026-10-24T23:30:00Z", 180)).toEqual(
      new Set([1]),
    );
    // And the spring-forward hour it skips costs it nothing either.
    expect(gaps(custom("*/15 * * * *"), "America/New_York", "2026-03-08T05:00:00Z", 12)).toEqual(
      new Set([15]),
    );
  });

  it("never skips a real match, whatever the size of the change", () => {
    // Lord Howe falls back half an hour: 02:00 (+11) to 01:30 (+10:30) at
    // 15:00Z. From 01:56, the next real 7th minute is the repeated 01:35.
    expect(slots(custom("*/7 * * * *"), "Australia/Lord_Howe", "2026-04-04T14:56:00Z", 1)).toEqual([
      "2026-04-04T15:05:00.000Z",
    ]);
    sevens("Australia/Lord_Howe", "2026-04-04T14:00:00Z", "2026-04-04T16:30:00Z");
    // And springs forward half an hour: 02:00 (+10:30) to 02:30 (+11).
    sevens("Australia/Lord_Howe", "2026-10-03T14:30:00Z", "2026-10-03T17:00:00Z");
    // New York's hour each way.
    sevens("America/New_York", "2027-03-14T06:00:00Z", "2027-03-14T08:30:00Z");
    sevens("America/New_York", "2026-11-01T04:30:00Z", "2026-11-01T07:30:00Z");
  });

  it("asked just after a jump, a set-hour cadence still runs its moved time", () => {
    // Mar 8 2026 in New York: 02:30 is skipped and runs at 03:30 EDT (07:30Z),
    // whether asked before the jump, on it, or after it.
    for (const after of [
      "2026-03-08T06:59:59.999Z",
      "2026-03-08T07:00:00Z",
      "2026-03-08T07:10:00Z",
    ]) {
      expect(slots(custom("30 2 * * *"), "America/New_York", after, 1)).toEqual([
        "2026-03-08T07:30:00.000Z",
      ]);
    }
    expect(slots(custom("30 2 * * *"), "America/New_York", "2026-03-08T07:30:00Z", 1)).toEqual([
      "2026-03-09T06:30:00.000Z",
    ]);
    // Lord Howe skips 02:00 to 02:30 (+10:30 to +11): 02:10 runs at 02:40.
    expect(slots(custom("10 2 * * *"), "Australia/Lord_Howe", "2026-10-03T15:30:00Z", 1)).toEqual([
      "2026-10-03T15:40:00.000Z",
    ]);
    // Troll skips two hours, 01:00 to 03:00 (+00 to +02): 02:30 runs at 04:30.
    expect(slots(custom("30 2 * * *"), "Antarctica/Troll", "2026-03-29T01:00:00Z", 1)).toEqual([
      "2026-03-29T02:30:00.000Z",
    ]);
  });

  it("answers the same wherever it is asked from, minute by minute around each change", () => {
    const cases = [
      ["30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-08T09:00:00Z"],
      ["30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T08:00:00Z"],
      ["10 2 * * *", "Australia/Lord_Howe", "2026-10-03T14:30:00Z", "2026-10-03T17:00:00Z"],
      ["40 1 * * *", "Australia/Lord_Howe", "2026-04-04T13:30:00Z", "2026-04-04T16:30:00Z"],
      ["30 2 * * *", "Antarctica/Troll", "2026-03-28T23:00:00Z", "2026-03-29T04:00:00Z"],
      ["*/7 * * * *", "America/New_York", "2027-03-14T05:30:00Z", "2027-03-14T08:30:00Z"],
      ["*/7 * * * *", "Australia/Lord_Howe", "2026-04-04T13:30:00Z", "2026-04-04T16:30:00Z"],
      ["*/7 * * * *", "Antarctica/Troll", "2026-03-28T23:00:00Z", "2026-03-29T04:00:00Z"],
    ] as const;
    for (const [cron, timeZone, from, until] of cases) {
      // The slots stepped through from a day before; asked at any minute in
      // between, the next one is the first of them after it.
      const stepped = Result.getOrThrow(
        upcomingSlots(custom(cron), timeZone, new Date(at(from).getTime() - 86_400_000), 400),
      ).map((slot) => slot.getTime());
      const schedule = Result.getOrThrow(compileCadence(custom(cron), timeZone))!;
      for (let asked = at(from).getTime(); asked <= at(until).getTime(); asked += 60_000) {
        const expected = stepped.find((slot) => slot > asked);
        const answer = Result.getOrThrow(schedule.next(new Date(asked)))?.getTime();
        if (answer !== expected) {
          expect({ cron, timeZone, asked: new Date(asked).toISOString(), answer }).toEqual({
            cron,
            timeZone,
            asked: new Date(asked).toISOString(),
            answer: expected,
          });
        }
      }
    }
  });

  it("finds a far-off match in a few milliseconds, whatever the distance", () => {
    // Feb 29 that is also a Sunday: 40 years on, across 80 clock changes in
    // New York. The search follows the changes near the answer only.
    const timed = (cron: string, timeZone: string, after: string) => {
      const schedule = Result.getOrThrow(compileCadence(custom(cron), timeZone))!;
      const start = performance.now();
      const slot = Result.getOrThrow(schedule.next(at(after)));
      return { slot: slot?.toISOString(), fast: performance.now() - start < 100 };
    };
    expect(timed("0 * 29 2 */7", "UTC", "2088-03-01T06:00:00Z")).toEqual({
      slot: "2128-02-29T00:00:00.000Z",
      fast: true,
    });
    expect(timed("0 * 29 2 */7", "America/New_York", "2088-03-01T06:00:00Z")).toEqual({
      slot: "2128-02-29T05:00:00.000Z",
      fast: true,
    });
    expect(timed("0 * 29 2 *", "America/New_York", "2026-10-21T00:00:00Z")).toEqual({
      slot: "2028-02-29T05:00:00.000Z",
      fast: true,
    });
  });

  it("asked exactly on the change, runs at the first real match after it", () => {
    // Falling back: 01:00 EST again, then 01:07.
    expect(slots(custom("*/7 * * * *"), "America/New_York", "2026-11-01T06:00:00Z", 1)).toEqual([
      "2026-11-01T06:07:00.000Z",
    ]);
    sevens("America/New_York", "2026-11-01T06:00:00Z", "2026-11-01T08:00:00Z");
    sevens("Australia/Lord_Howe", "2026-04-04T15:00:00Z", "2026-04-04T16:30:00Z");
    // Springing forward: 03:00 EDT, then 03:07.
    expect(slots(custom("*/7 * * * *"), "America/New_York", "2027-03-14T07:00:00Z", 1)).toEqual([
      "2027-03-14T07:07:00.000Z",
    ]);
    sevens("America/New_York", "2027-03-14T07:00:00Z", "2027-03-14T08:30:00Z");
    sevens("Australia/Lord_Howe", "2026-10-03T15:30:00Z", "2026-10-03T17:00:00Z");
  });
});

describe("a one-time cadence", () => {
  const once = (date: string, hour: number, minute = 0) =>
    ({ kind: "once", date, time: { hour, minute } }) as const;

  it("runs once, on its date at its wall time, and then has no more slots", () => {
    expect(slots(once("2026-10-26", 9), "America/New_York", "2026-10-24T12:00:00Z")).toEqual([
      "2026-10-26T13:00:00.000Z",
    ]);
    // A time the clocks skip that day runs right after the jump, as daily does.
    expect(slots(once("2026-03-08", 2, 30), "America/New_York", "2026-03-01T00:00:00Z")).toEqual([
      "2026-03-08T07:30:00.000Z",
    ]);
    const schedule = Result.getOrThrow(compileCadence(once("2026-10-26", 9), "UTC"))!;
    expect(
      Result.getOrThrow(dueSlots(schedule, at("2026-10-26T09:00:00Z"), at("2026-10-27T00:00:00Z"))),
    ).toEqual({ latest: at("2026-10-26T09:00:00Z"), earlier: 0, firstEarlier: null });
    expect(Result.getOrThrow(schedule.next(at("2026-10-26T09:00:00Z")))).toBe(null);
  });

  it("refuses a day that doesn't exist, a time already past, and one over a year away", () => {
    const now = at("2026-10-24T12:00:00Z");
    expect(cadenceSaveRefusal(once("2026-02-30", 9), "UTC", now)).toMatch(/isn't a date/);
    expect(cadenceSaveRefusal(once("2027-02-29", 9), "UTC", now)).toMatch(/isn't a date/);
    expect(cadenceSaveRefusal(once("2026-10-24", 11), "UTC", now)).toMatch(/already passed/);
    expect(cadenceSaveRefusal(once("2028-01-01", 9), "UTC", now)).toMatch(/more than a year/);
    expect(cadenceSaveRefusal(once("2026-10-24", 13), "UTC", now)).toBe(null);
    expect(describeCadence(once("2026-10-26", 9, 5))).toBe("Once, Oct 26, 2026 at 9:05");
  });
});

describe("compileCadence and cadenceSaveRefusal", () => {
  const now = at("2026-10-24T12:00:00Z");

  it("takes a 5-field custom cron and refuses a seconds field", () => {
    expect(cadenceSaveRefusal({ kind: "custom", cron: "*/15 9-17 * * 1-5" }, "UTC", now)).toBe(
      null,
    );
    expect(cadenceSaveRefusal({ kind: "custom", cron: "0 0 9 * * *" }, "UTC", now)).toMatch(
      /5 fields/,
    );
    expect(cadenceSaveRefusal({ kind: "custom", cron: "61 * * * *" }, "UTC", now)).toMatch(
      /isn't a schedule/,
    );
  });

  it("refuses a schedule that never runs, and an unknown zone", () => {
    expect(cadenceSaveRefusal({ kind: "custom", cron: "0 0 31 2 *" }, "UTC", now)).toMatch(
      /never runs|next year/,
    );
    expect(
      cadenceSaveRefusal({ kind: "daily", time: { hour: 9, minute: 0 } }, "Mars/Olympus", now),
    ).toMatch(/time zone/);
    expect(Result.isSuccess(compileCadence({ kind: "manual" }, "UTC"))).toBe(true);
  });
});

describe("dueSlots", () => {
  const hourly = Result.getOrThrow(compileCadence({ kind: "hourly", minute: 0 }, "UTC"))!;

  it("is nothing before the next slot, and the one slot when it is due", () => {
    expect(
      Result.getOrThrow(dueSlots(hourly, at("2026-10-24T13:00:00Z"), at("2026-10-24T12:59:00Z"))),
    ).toBe(null);
    expect(
      Result.getOrThrow(dueSlots(hourly, at("2026-10-24T13:00:00Z"), at("2026-10-24T13:00:20Z"))),
    ).toEqual({ latest: at("2026-10-24T13:00:00Z"), earlier: 0, firstEarlier: null });
  });

  it("finds the latest of many missed slots and counts the rest", () => {
    expect(
      Result.getOrThrow(dueSlots(hourly, at("2026-10-24T13:00:00Z"), at("2026-10-25T01:30:00Z"))),
    ).toEqual({
      latest: at("2026-10-25T01:00:00Z"),
      earlier: 12,
      firstEarlier: at("2026-10-24T13:00:00Z"),
    });
  });

  it("jumps ahead through a long gap of frequent slots", () => {
    const everyMinute = Result.getOrThrow(
      compileCadence({ kind: "custom", cron: "* * * * *" }, "UTC"),
    )!;
    const due = Result.getOrThrow(
      dueSlots(everyMinute, at("2026-09-01T00:00:00Z"), at("2026-10-24T12:00:30Z"), 1_000),
    );
    expect(due?.latest).toEqual(at("2026-10-24T12:00:00Z"));
    expect(due?.firstEarlier).toEqual(at("2026-09-01T00:00:00Z"));
    expect(due?.earlier).toBeGreaterThan(1_000);
  });
});

describe("describeCadence", () => {
  it("names each preset", () => {
    expect(describeCadence({ kind: "weekdays", time: { hour: 9, minute: 0 } })).toBe(
      "Weekdays at 9:00",
    );
    expect(describeCadence({ kind: "hourly", minute: 15 })).toBe("Every hour at :15");
    expect(describeCadence({ kind: "weekly", weekday: 1, time: { hour: 17, minute: 5 } })).toBe(
      "Mondays at 17:05",
    );
    expect(describeCadence({ kind: "manual" })).toBe("Manual");
  });
});
