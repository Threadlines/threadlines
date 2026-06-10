import { describe, expect, it } from "vitest";

import {
  normalizeClaudeAccountUsage,
  normalizeClaudeUsageResetsAt,
  normalizeClaudeUsageWindow,
} from "./ClaudeUsage.ts";

describe("normalizeClaudeUsageResetsAt", () => {
  it("parses ISO 8601 strings to epoch milliseconds", () => {
    expect(normalizeClaudeUsageResetsAt("2026-06-10T12:00:00.000Z")).toBe(
      Date.parse("2026-06-10T12:00:00.000Z"),
    );
  });

  it("passes finite positive numbers through rounded", () => {
    expect(normalizeClaudeUsageResetsAt(1_781_179_200.4)).toBe(1_781_179_200);
  });

  it("returns undefined for null, missing, and unparseable values", () => {
    expect(normalizeClaudeUsageResetsAt(null)).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt(undefined)).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt("not-a-date")).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt(0)).toBeUndefined();
    expect(normalizeClaudeUsageResetsAt(-5)).toBeUndefined();
  });
});

describe("normalizeClaudeUsageWindow", () => {
  it("rounds and clamps utilization and derives remaining percent", () => {
    expect(
      normalizeClaudeUsageWindow({ utilization: 30.6, resets_at: "2026-06-10T12:00:00.000Z" }, 300),
    ).toEqual({
      usedPercent: 31,
      remainingPercent: 69,
      resetsAt: Date.parse("2026-06-10T12:00:00.000Z"),
      windowDurationMins: 300,
    });
  });

  it("clamps utilization above 100", () => {
    expect(normalizeClaudeUsageWindow({ utilization: 130 }, 300)).toEqual({
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationMins: 300,
    });
  });

  it("returns undefined when utilization is missing", () => {
    expect(normalizeClaudeUsageWindow(undefined, 300)).toBeUndefined();
    expect(normalizeClaudeUsageWindow(null, 300)).toBeUndefined();
    expect(
      normalizeClaudeUsageWindow({ resets_at: "2026-06-10T12:00:00.000Z" }, 300),
    ).toBeUndefined();
    expect(normalizeClaudeUsageWindow({ utilization: null }, 300)).toBeUndefined();
  });
});

describe("normalizeClaudeAccountUsage", () => {
  const checkedAt = "2026-06-10T00:00:00.000Z";

  it("maps five_hour and seven_day windows onto one claude limit", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: { utilization: 31, resets_at: "2026-06-10T02:32:00.000Z" },
          seven_day: { utilization: 69, resets_at: "2026-06-10T20:48:00.000Z" },
        },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 31,
            remainingPercent: 69,
            resetsAt: Date.parse("2026-06-10T02:32:00.000Z"),
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 69,
            remainingPercent: 31,
            resetsAt: Date.parse("2026-06-10T20:48:00.000Z"),
            windowDurationMins: 10_080,
          },
        },
      ],
    });
  });

  it("keeps the weekly window when the 5h window is absent", () => {
    expect(
      normalizeClaudeAccountUsage(
        {
          five_hour: null,
          seven_day: { utilization: 12 },
        },
        checkedAt,
      ),
    ).toEqual({
      source: "claude-oauth-usage",
      checkedAt,
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          secondary: {
            usedPercent: 12,
            remainingPercent: 88,
            windowDurationMins: 10_080,
          },
        },
      ],
    });
  });

  it("returns undefined when no window carries utilization data", () => {
    expect(normalizeClaudeAccountUsage({}, checkedAt)).toBeUndefined();
    expect(
      normalizeClaudeAccountUsage({ five_hour: null, seven_day: null }, checkedAt),
    ).toBeUndefined();
  });
});
