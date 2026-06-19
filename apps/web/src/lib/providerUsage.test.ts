import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderAccountUsage,
} from "@t3tools/contracts";

import {
  deriveProviderAccountUsagePresentation,
  deriveProviderAccountUsagePresentationForProvider,
  formatProviderTokenCount,
  isProviderUsageNearLimit,
} from "./providerUsage";

describe("deriveProviderAccountUsagePresentation", () => {
  it("formats billion-scale token counts without million overflow", () => {
    expect(formatProviderTokenCount(6_220_800_000)).toBe("6.22B");
    expect(formatProviderTokenCount(279_500_000)).toBe("279.5m");
  });

  it("formats Codex rate limit usage with remaining percent and reset time", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-04-10T00:00:00.000Z",
      primaryLimitId: "codex",
      limits: [
        {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 37,
            remainingPercent: 63,
            resetsAt: 1_800_003_600,
            windowDurationMins: 300,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex",
      reachedLimit: false,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        detail: "usable for 30 days after grant",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "63% remaining · resets in 1h",
          usedPercent: 37,
          remainingPercent: 63,
          reachedLimit: false,
        },
      ],
    });
  });

  it("formats both Codex 5h and weekly usage windows", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-04-10T00:00:00.000Z",
      primaryLimitId: "codex",
      limits: [
        {
          limitId: "codex",
          primary: {
            usedPercent: 37,
            remainingPercent: 63,
            resetsAt: 1_800_003_600,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 64,
            remainingPercent: 36,
            resetsAt: 1_800_604_800,
            windowDurationMins: 10_080,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex usage",
      reachedLimit: false,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        detail: "usable for 30 days after grant",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "63% remaining · resets in 1h",
          usedPercent: 37,
          remainingPercent: 63,
          reachedLimit: false,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "36% remaining · resets in 7d",
          usedPercent: 64,
          remainingPercent: 36,
          reachedLimit: false,
        },
      ],
    });
  });

  it("formats available Codex rate-limit reset credits", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-16T00:00:00.000Z",
      primaryLimitId: "codex",
      rateLimitResetCredits: {
        availableCount: 2,
      },
      limits: [
        {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 95,
            remainingPercent: 5,
            windowDurationMins: 300,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex",
      reachedLimit: false,
      resetCredits: {
        availableCount: 2,
        label: "2 resets available",
        detail: "usable for 30 days after grant",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "5% remaining",
          usedPercent: 95,
          remainingPercent: 5,
          reachedLimit: false,
        },
      ],
    });
  });

  it("formats Codex token usage history", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-18T00:00:00.000Z",
      limits: [],
      tokenUsage: {
        checkedAt: "2026-06-18T00:00:00.000Z",
        dailyBuckets: [
          { startDate: "2026-06-16", tokens: 1200 },
          { startDate: "2026-06-17", tokens: 3400 },
        ],
        summary: {
          currentStreakDays: 2,
          lifetimeTokens: 4600,
          longestRunningTurnSec: 660,
          longestStreakDays: 5,
          peakDailyTokens: 3400,
        },
      },
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex usage",
      reachedLimit: false,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        detail: "usable for 30 days after grant",
      },
      tokenUsage: {
        label: "Token history",
        summary: [
          { key: "lifetimeTokens", label: "Lifetime tokens", value: "4.6k" },
          { key: "peakDailyTokens", label: "Peak tokens", value: "3.4k" },
          { key: "longestRunningTurnSec", label: "Longest task", value: "11m" },
          { key: "currentStreakDays", label: "Current streak", value: "2d" },
          { key: "longestStreakDays", label: "Longest streak", value: "5d" },
        ],
        buckets: [
          {
            startDate: "2026-06-16",
            label: "Jun 16",
            tokens: 1200,
            tokenLabel: "1.2k",
            intensityPercent: 35,
          },
          {
            startDate: "2026-06-17",
            label: "Jun 17",
            tokens: 3400,
            tokenLabel: "3.4k",
            intensityPercent: 100,
          },
        ],
      },
      windows: [],
    });
  });

  it("does not add a monthly spend-control row to normal Codex usage windows", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-04T00:00:00.000Z",
      limits: [
        {
          limitId: "codex",
          limitName: "Codex",
          planType: "pro",
          primary: {
            usedPercent: 37,
            remainingPercent: 63,
            resetsAt: 1_800_003_600,
            windowDurationMins: 300,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex",
      reachedLimit: false,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        detail: "usable for 30 days after grant",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "63% remaining · resets in 1h",
          usedPercent: 37,
          remainingPercent: 63,
          reachedLimit: false,
        },
      ],
    });
  });

  it("marks reached Codex limits", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-04-10T00:00:00.000Z",
      limits: [
        {
          limitId: "codex",
          rateLimitReachedType: "rate_limit_reached",
          primary: {
            usedPercent: 100,
            remainingPercent: 0,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex usage",
      reachedLimit: true,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        detail: "usable for 30 days after grant",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "limit reached",
          usedPercent: 100,
          remainingPercent: 0,
          reachedLimit: true,
        },
      ],
    });
  });

  it("formats Claude 5h and weekly usage windows from the oauth usage source", () => {
    const usage: ServerProviderAccountUsage = {
      source: "claude-oauth-usage",
      checkedAt: "2026-06-10T00:00:00.000Z",
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 31,
            remainingPercent: 69,
            resetsAt: 1_800_009_120_000,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 69,
            remainingPercent: 31,
            resetsAt: 1_800_604_800_000,
            windowDurationMins: 10_080,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Claude usage",
      reachedLimit: false,
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "69% remaining · resets in 2h 32m",
          usedPercent: 31,
          remainingPercent: 69,
          reachedLimit: false,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "31% remaining · resets in 7d",
          usedPercent: 69,
          remainingPercent: 31,
          reachedLimit: false,
        },
      ],
    });
  });

  it("marks a capped Claude 5h window as limit reached while keeping weekly usage", () => {
    const usage: ServerProviderAccountUsage = {
      source: "claude-oauth-usage",
      checkedAt: "2026-06-10T15:00:00.000Z",
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: 1_781_116_200_000,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 9,
            remainingPercent: 91,
            resetsAt: 1_781_233_200_000,
            windowDurationMins: 10_080,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_781_104_200_000)).toEqual({
      label: "Claude usage",
      reachedLimit: true,
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "limit reached \u00b7 resets in 3h 20m",
          usedPercent: 100,
          remainingPercent: 0,
          reachedLimit: true,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "91% remaining \u00b7 resets in 1d 11h",
          usedPercent: 9,
          remainingPercent: 91,
          reachedLimit: false,
        },
      ],
    });
  });

  it("formats Codex monthly spend-control limits", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-04T00:00:00.000Z",
      limits: [
        {
          limitId: "codex",
          limitName: "Codex",
          planType: "enterprise",
          individualLimit: {
            limit: "$100.00",
            used: "$35.00",
            remainingPercent: 65,
            resetsAt: 1_800_086_400,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000)).toEqual({
      label: "Codex",
      reachedLimit: false,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        detail: "usable for 30 days after grant",
      },
      spendControl: {
        label: "Monthly",
        detail: "$35.00 used of $100.00 - 65% remaining - resets in 1d",
        usedPercent: 35,
        remainingPercent: 65,
        reachedLimit: false,
      },
      windows: [],
    });
  });
});

describe("deriveProviderAccountUsagePresentationForProvider", () => {
  it("shows empty Claude usage windows when authenticated usage is unavailable", () => {
    const provider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: {
        status: "authenticated",
        type: "maxplan",
        label: "Claude Max Subscription",
      },
    } satisfies Pick<ServerProvider, "accountUsage" | "auth" | "driver">;

    expect(deriveProviderAccountUsagePresentationForProvider(provider)).toEqual({
      label: "Claude usage",
      reachedLimit: false,
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "usage unavailable",
          usedPercent: 0,
          remainingPercent: 100,
          reachedLimit: false,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "usage unavailable",
          usedPercent: 0,
          remainingPercent: 100,
          reachedLimit: false,
        },
      ],
    });
  });

  it("does not show Claude subscription usage placeholders for API-key auth", () => {
    const provider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: {
        status: "authenticated",
        type: "apiKey",
        label: "Claude API Key",
      },
    } satisfies Pick<ServerProvider, "accountUsage" | "auth" | "driver">;

    expect(deriveProviderAccountUsagePresentationForProvider(provider)).toBeNull();
  });
});

const makeUsage = (usedPercent: number): ServerProviderAccountUsage => ({
  source: "claude-oauth-usage",
  checkedAt: "2026-06-10T00:00:00.000Z",
  limits: [
    {
      limitId: "claude",
      primary: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        windowDurationMins: 300,
      },
    },
  ],
});

describe("isProviderUsageNearLimit", () => {
  it("is false for null presentations and usage below the threshold", () => {
    expect(isProviderUsageNearLimit(null)).toBe(false);
    expect(isProviderUsageNearLimit(deriveProviderAccountUsagePresentation(makeUsage(89)))).toBe(
      false,
    );
  });

  it("is true once any window crosses the threshold", () => {
    expect(isProviderUsageNearLimit(deriveProviderAccountUsagePresentation(makeUsage(90)))).toBe(
      true,
    );
  });

  it("is true when the limit is reached even with low window percentages", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-04-10T00:00:00.000Z",
      limits: [
        {
          limitId: "codex",
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 12, remainingPercent: 88 },
        },
      ],
    };
    expect(isProviderUsageNearLimit(deriveProviderAccountUsagePresentation(usage))).toBe(true);
  });

  it("is true when the monthly spend control crosses the threshold", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-04T00:00:00.000Z",
      limits: [
        {
          limitId: "codex",
          individualLimit: {
            limit: "$100.00",
            used: "$95.00",
            remainingPercent: 5,
          },
        },
      ],
    };
    expect(isProviderUsageNearLimit(deriveProviderAccountUsagePresentation(usage))).toBe(true);
  });
});
