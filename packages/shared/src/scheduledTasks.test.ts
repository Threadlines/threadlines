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
