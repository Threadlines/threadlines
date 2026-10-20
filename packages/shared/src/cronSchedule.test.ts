import { describe, expect, it } from "vite-plus/test";

import { nextCronMatch, parseCronExpression } from "./cronSchedule.ts";

const at = (iso: string) => new Date(iso);

describe("nextCronMatch", () => {
  it("finds the next minute a schedule fires, in the given time zone", () => {
    expect(nextCronMatch("*/5 * * * *", at("2026-10-20T15:07:30Z"), "UTC")?.toISOString()).toBe(
      "2026-10-20T15:10:00.000Z",
    );
    // A one-shot pinned to 15:10 local fires today, never moved to tomorrow
    // while it is still ahead.
    expect(nextCronMatch("10 15 * * *", at("2026-10-20T15:08:00Z"), "UTC")?.toISOString()).toBe(
      "2026-10-20T15:10:00.000Z",
    );
    // Weekdays at 9 in New York, from a Saturday: Monday 9:00 EDT.
    expect(
      nextCronMatch("0 9 * * 1-5", at("2026-10-24T12:00:00Z"), "America/New_York")?.toISOString(),
    ).toBe("2026-10-26T13:00:00.000Z");
    // Across the clocks going back (Nov 1 2026 in New York).
    expect(
      nextCronMatch("30 1 * * *", at("2026-10-31T12:00:00Z"), "America/New_York")?.toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
    // Across the clocks going forward (Mar 8 2026, a 23-hour day): Monday's
    // midnight, not a week later.
    expect(
      nextCronMatch("0 0 * * 1", at("2026-03-08T05:00:00Z"), "America/New_York")?.toISOString(),
    ).toBe("2026-03-09T04:00:00.000Z");
    expect(nextCronMatch("0-30/10 8 * * *", at("2026-10-20T08:11:00Z"), "UTC")?.toISOString()).toBe(
      "2026-10-20T08:20:00.000Z",
    );
    // Both day fields restricted: either one matches (the 1st, or a Monday).
    expect(nextCronMatch("0 0 1 * 1", at("2026-10-20T00:00:00Z"), "UTC")?.toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
  });

  it("gives null for a schedule that doesn't parse or never fires", () => {
    expect(nextCronMatch("not a cron", at("2026-10-20T00:00:00Z"), "UTC")).toBe(null);
    expect(nextCronMatch("0 0 30 2 *", at("2026-10-20T00:00:00Z"), "UTC")).toBe(null);
    expect(nextCronMatch("* * * * *", at("2026-10-20T00:00:00Z"), "Not/AZone")).toBe(null);
    expect(parseCronExpression("61 * * * *")).toBe(null);
  });
});
