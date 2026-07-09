import { describe, expect, it } from "vitest";

import type { ServerProviderAccountUsage } from "@threadlines/contracts";

import { mergeCodexAccountUsageRateLimits } from "./CodexProvider.ts";

describe("mergeCodexAccountUsageRateLimits", () => {
  const checkedAt = "2026-07-09T00:00:00.000Z";
  const currentUsage: ServerProviderAccountUsage = {
    source: "codex-rate-limits",
    checkedAt: "2026-07-08T23:00:00.000Z",
    primaryLimitId: "codex",
    limits: [
      {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 20, remainingPercent: 80, resetsAt: 1_782_000_000 },
        secondary: { usedPercent: 50, remainingPercent: 50, resetsAt: 1_782_500_000 },
      },
      {
        limitId: "gpt",
        primary: { usedPercent: 5, remainingPercent: 95 },
      },
    ],
  };

  it("creates a fresh snapshot when no usage exists yet", () => {
    expect(
      mergeCodexAccountUsageRateLimits(
        undefined,
        {
          limitId: "codex",
          primary: { usedPercent: 33, resetsAt: 1_783_000_000, windowDurationMins: 300 },
        },
        checkedAt,
      ),
    ).toEqual({
      source: "codex-rate-limits",
      checkedAt,
      primaryLimitId: "codex",
      limits: [
        {
          limitId: "codex",
          primary: {
            usedPercent: 33,
            remainingPercent: 67,
            resetsAt: 1_783_000_000,
            windowDurationMins: 300,
          },
        },
      ],
    });
  });

  it("merges a sparse window update into the matching limit", () => {
    const next = mergeCodexAccountUsageRateLimits(
      currentUsage,
      {
        limitId: "codex",
        primary: { usedPercent: 42, resetsAt: 1_783_100_000 },
      },
      checkedAt,
    );
    expect(next).toEqual({
      ...currentUsage,
      checkedAt,
      limits: [
        {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 42, remainingPercent: 58, resetsAt: 1_783_100_000 },
          secondary: { usedPercent: 50, remainingPercent: 50, resetsAt: 1_782_500_000 },
        },
        currentUsage.limits[1]!,
      ],
    });
  });

  it("merges id-less updates into the primary limit", () => {
    const next = mergeCodexAccountUsageRateLimits(
      currentUsage,
      { secondary: { usedPercent: 61 } },
      checkedAt,
    );
    expect(next?.limits[0]?.secondary).toEqual({ usedPercent: 61, remainingPercent: 39 });
    expect(next?.limits[0]?.primary).toEqual(currentUsage.limits[0]?.primary);
    expect(next?.limits[1]).toEqual(currentUsage.limits[1]);
  });

  it("appends updates that reference a limit not seen before", () => {
    const next = mergeCodexAccountUsageRateLimits(
      currentUsage,
      { limitId: "new-limit", primary: { usedPercent: 1 } },
      checkedAt,
    );
    expect(next?.limits).toHaveLength(3);
    expect(next?.limits[2]).toEqual({
      limitId: "new-limit",
      primary: { usedPercent: 1, remainingPercent: 99 },
    });
  });

  it("returns undefined when the notification carries nothing usable", () => {
    expect(mergeCodexAccountUsageRateLimits(currentUsage, {}, checkedAt)).toBeUndefined();
  });
});
