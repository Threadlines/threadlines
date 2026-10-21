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

describe("a cadence across a fall-back", () => {
  const custom = (cron: string) => ({ kind: "custom", cron }) as const;
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
