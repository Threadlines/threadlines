import { describe, expect, it } from "vite-plus/test";

import {
  enumerateDays,
  formatDayShort,
  formatTokens,
  formatTokensCompact,
  makeTodayUsageWindow,
  makeUsageWindow,
  windowStartDay,
} from "./usageFormat.ts";

describe("formatTokens", () => {
  it("compacts to three significant figures with a unit suffix", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_040)).toBe("1.04K");
    expect(formatTokens(804_000)).toBe("804K");
    expect(formatTokens(2_400_000)).toBe("2.40M");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(19_900_000_000)).toBe("19.9B");
  });
});

describe("formatTokensCompact", () => {
  it("drops trailing zeros but keeps significant fraction digits", () => {
    expect(formatTokensCompact(2_400_000)).toBe("2.4M");
    expect(formatTokensCompact(2_000_000)).toBe("2M");
    expect(formatTokensCompact(1_040)).toBe("1.04K");
    expect(formatTokensCompact(999)).toBe("999");
  });
});

describe("formatDayShort", () => {
  it("renders a calendar day without shifting it into another zone", () => {
    expect(formatDayShort("2026-08-07")).toBe("Aug 7");
    expect(formatDayShort("2026-01-01")).toBe("Jan 1");
  });
});

describe("enumerateDays", () => {
  it("includes both bounds and spans month ends", () => {
    expect(enumerateDays("2026-01-30", "2026-02-02")).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("returns nothing when the range is inverted", () => {
    expect(enumerateDays("2026-02-02", "2026-01-30")).toEqual([]);
  });
});

describe("windowStartDay", () => {
  it("counts the end day itself and walks back across a month boundary", () => {
    expect(windowStartDay("2026-08-10", 30)).toBe("2026-07-12");
    expect(windowStartDay("2026-03-03", 7)).toBe("2026-02-25");
    expect(windowStartDay("2026-08-10", 1)).toBe("2026-08-10");
  });
});

describe("makeUsageWindow", () => {
  it("ends today and spans the requested number of days inclusively", () => {
    const window = makeUsageWindow(7, new Date("2026-03-10T18:00:00Z"));
    expect(enumerateDays(window.sinceDay, window.untilDay)).toHaveLength(7);
    expect(window.timeZone.length).toBeGreaterThan(0);
  });

  it("walks back across a month boundary", () => {
    const window = makeUsageWindow(7, new Date("2026-03-03T18:00:00Z"));
    expect(enumerateDays(window.sinceDay, window.untilDay)).toHaveLength(7);
    expect(window.sinceDay < window.untilDay).toBe(true);
  });
});

describe("makeTodayUsageWindow", () => {
  it("covers a single day", () => {
    const window = makeTodayUsageWindow(new Date("2026-03-10T18:00:00Z"));
    expect(window.sinceDay).toBe(window.untilDay);
  });
});
