import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderAccountUsage,
} from "@threadlines/contracts";

import {
  deriveProviderAccountUsagePresentation,
  deriveProviderAccountUsagePresentationForProvider,
  formatProviderTokenCount,
  isProviderUsageNearLimit,
  providerRateLimitResetCreditsExpirationUrgency,
  providerRateLimitResetCreditExpirationUrgency,
  providerUsageNearLimitColor,
  usageMeterColor,
} from "./providerUsage";

describe("deriveProviderAccountUsagePresentation", () => {
  it("formats billion-scale token counts without million overflow", () => {
    expect(formatProviderTokenCount(6_220_800_000)).toBe("6.22B");
    expect(formatProviderTokenCount(279_500_000)).toBe("279.5m");
  });

  it("formats Codex rate limit usage with used percent and reset time", () => {
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
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "37% used · resets in 1h",
          usedPercent: 37,
          remainingPercent: 63,
          reachedLimit: false,
          warning: false,
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
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "37% used · resets in 1h",
          usedPercent: 37,
          remainingPercent: 63,
          reachedLimit: false,
          warning: false,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "64% used · resets in 7d",
          usedPercent: 64,
          remainingPercent: 36,
          reachedLimit: false,
          warning: false,
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
        credits: [
          {
            id: "reset-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: 1_800_000_000,
            expiresAt: 1_802_592_000,
          },
        ],
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
        shortLabel: "2 available",
        detail: "next expires in 30d",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "95% used",
          usedPercent: 95,
          remainingPercent: 5,
          reachedLimit: false,
          warning: true,
        },
      ],
    });
  });

  it("flags reset credits as expiring soon when a usable credit is near expiration", () => {
    const nowMs = Date.UTC(2026, 6, 14);
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: new Date(nowMs).toISOString(),
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [
          {
            id: "reset-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: Math.floor(nowMs / 1000),
            expiresAt: Math.floor((nowMs + 3 * 24 * 60 * 60 * 1000) / 1000),
          },
        ],
      },
      limits: [],
    };

    expect(deriveProviderAccountUsagePresentation(usage, nowMs)?.resetCredits).toMatchObject({
      expirationUrgency: "soon",
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
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      tokenUsage: {
        label: "Token history",
        checkedAt: "2026-06-18T00:00:00.000Z",
        scope: "account",
        completeLifetimeHistory: true,
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

  it("labels machine-scoped Claude token history honestly", () => {
    const usage: ServerProviderAccountUsage = {
      source: "claude-oauth-usage",
      checkedAt: "2026-08-12T12:00:00.000Z",
      limits: [],
      tokenUsage: {
        checkedAt: "2026-08-12T12:00:00.000Z",
        scope: "local",
        coverageStartDate: "2025-08-12",
        coverageEndDate: "2026-08-12",
        completeLifetimeHistory: false,
        dailyBuckets: [{ startDate: "2026-08-11", tokens: 4200 }],
        summary: { lifetimeTokens: 4200, peakDailyTokens: 4200 },
      },
    };

    expect(deriveProviderAccountUsagePresentation(usage)?.tokenUsage).toMatchObject({
      label: "Local token activity",
      scope: "local",
      coverageStartDate: "2025-08-12",
      coverageEndDate: "2026-08-12",
      completeLifetimeHistory: false,
      summary: [
        { key: "lifetimeTokens", label: "Tracked tokens", value: "4.2k" },
        { key: "peakDailyTokens", label: "Peak tokens", value: "4.2k" },
      ],
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
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "37% used · resets in 1h",
          usedPercent: 37,
          remainingPercent: 63,
          reachedLimit: false,
          warning: false,
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
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "limit reached",
          usedPercent: 100,
          remainingPercent: 0,
          reachedLimit: true,
          warning: true,
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
      externalResets: { label: "Use on claude.ai", url: "https://claude.ai/settings/usage" },
      reachedLimit: false,
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "31% used · resets in 2h 32m",
          usedPercent: 31,
          remainingPercent: 69,
          reachedLimit: false,
          warning: false,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "69% used · resets in 7d",
          usedPercent: 69,
          remainingPercent: 31,
          reachedLimit: false,
          warning: false,
        },
      ],
    });
  });

  it("appends scoped Claude limits as extra windows honoring provider severity", () => {
    const usage: ServerProviderAccountUsage = {
      source: "claude-oauth-usage",
      checkedAt: "2026-07-03T00:00:00.000Z",
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 35,
            remainingPercent: 65,
            resetsAt: 1_800_009_120_000,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 39,
            remainingPercent: 61,
            resetsAt: 1_800_604_800_000,
            windowDurationMins: 10_080,
          },
          scoped: [
            {
              scopeLabel: "Fable",
              usedPercent: 78,
              remainingPercent: 22,
              resetsAt: 1_800_604_800_000,
              windowDurationMins: 10_080,
              severity: "warning",
            },
          ],
        },
      ],
    };

    const presentation = deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000);
    expect(presentation?.windows).toEqual([
      {
        key: "primary",
        label: "5h",
        detail: "35% used · resets in 2h 32m",
        usedPercent: 35,
        remainingPercent: 65,
        reachedLimit: false,
        warning: false,
      },
      {
        key: "secondary",
        label: "Weekly",
        detail: "39% used · resets in 7d",
        usedPercent: 39,
        remainingPercent: 61,
        reachedLimit: false,
        warning: false,
      },
      {
        key: "scoped-0",
        label: "Fable (weekly)",
        detail: "78% used · resets in 7d",
        usedPercent: 78,
        remainingPercent: 22,
        reachedLimit: false,
        warning: true,
      },
    ]);
    expect(presentation?.reachedLimit).toBe(false);
    expect(isProviderUsageNearLimit(presentation ?? null)).toBe(true);
  });

  it("marks reached scoped limits without blocking sibling windows", () => {
    const usage: ServerProviderAccountUsage = {
      source: "claude-oauth-usage",
      checkedAt: "2026-07-03T00:00:00.000Z",
      primaryLimitId: "claude",
      limits: [
        {
          limitId: "claude",
          primary: {
            usedPercent: 35,
            remainingPercent: 65,
            windowDurationMins: 300,
          },
          scoped: [
            {
              scopeLabel: "Fable",
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: 1_800_604_800_000,
              windowDurationMins: 10_080,
              severity: "exceeded",
            },
          ],
        },
      ],
    };

    const presentation = deriveProviderAccountUsagePresentation(usage, 1_800_000_000_000);
    expect(presentation?.windows).toEqual([
      {
        key: "primary",
        label: "5h",
        detail: "35% used",
        usedPercent: 35,
        remainingPercent: 65,
        reachedLimit: false,
        warning: false,
      },
      {
        key: "scoped-0",
        label: "Fable (weekly)",
        detail: "limit reached · resets in 7d",
        usedPercent: 100,
        remainingPercent: 0,
        reachedLimit: true,
        warning: true,
      },
    ]);
    expect(presentation?.reachedLimit).toBe(true);
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
      externalResets: { label: "Use on claude.ai", url: "https://claude.ai/settings/usage" },
      reachedLimit: true,
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "limit reached \u00b7 resets in 3h 20m",
          usedPercent: 100,
          remainingPercent: 0,
          reachedLimit: true,
          warning: true,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "9% used \u00b7 blocked by 5h limit \u00b7 resets in 1d 11h",
          usedPercent: 9,
          remainingPercent: 91,
          reachedLimit: false,
          warning: false,
        },
      ],
    });
  });

  it("keeps weekly usage available when the provider reports the 5h cap as reached", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-10T15:00:00.000Z",
      primaryLimitId: "codex",
      limits: [
        {
          limitId: "codex",
          rateLimitReachedType: "rate_limit_reached",
          primary: {
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: 1_781_116_200,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 64,
            remainingPercent: 36,
            resetsAt: 1_781_233_200,
            windowDurationMins: 10_080,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_781_104_200_000)).toEqual({
      label: "Codex usage",
      reachedLimit: true,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "limit reached \u00b7 resets in 3h 20m",
          usedPercent: 100,
          remainingPercent: 0,
          reachedLimit: true,
          warning: true,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "64% used \u00b7 blocked by 5h limit \u00b7 resets in 1d 11h",
          usedPercent: 64,
          remainingPercent: 36,
          reachedLimit: false,
          warning: false,
        },
      ],
    });
  });

  it("keeps 5h usage available when the provider reports the weekly cap as reached", () => {
    const usage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-06-10T15:00:00.000Z",
      primaryLimitId: "codex",
      limits: [
        {
          limitId: "codex",
          rateLimitReachedType: "rate_limit_reached",
          primary: {
            usedPercent: 42,
            remainingPercent: 58,
            resetsAt: 1_781_116_200,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: 1_781_233_200,
            windowDurationMins: 10_080,
          },
        },
      ],
    };

    expect(deriveProviderAccountUsagePresentation(usage, 1_781_104_200_000)).toEqual({
      label: "Codex usage",
      reachedLimit: true,
      resetCredits: {
        availableCount: 0,
        label: "0 resets available",
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      windows: [
        {
          key: "primary",
          label: "5h",
          detail: "42% used \u00b7 blocked by weekly limit \u00b7 resets in 3h 20m",
          usedPercent: 42,
          remainingPercent: 58,
          reachedLimit: false,
          warning: false,
        },
        {
          key: "secondary",
          label: "Weekly",
          detail: "limit reached \u00b7 resets in 1d 11h",
          usedPercent: 100,
          remainingPercent: 0,
          reachedLimit: true,
          warning: true,
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
        shortLabel: "None available",
        detail: "expiration dates unavailable",
      },
      spendControl: {
        label: "Monthly",
        detail: "$35.00 used of $100.00 - 35% used - resets in 1d",
        usedPercent: 35,
        remainingPercent: 65,
        reachedLimit: false,
        warning: false,
      },
      windows: [],
    });
  });
});

describe("deriveProviderAccountUsagePresentationForProvider", () => {
  const nowMs = Date.parse("2026-07-09T12:00:00.000Z");
  const claude = ProviderDriverKind.make("claudeAgent");
  const readingFrom = (checkedAt: string): ServerProviderAccountUsage => ({
    source: "claude-oauth-usage",
    checkedAt,
    primaryLimitId: "claude",
    limits: [
      {
        limitId: "claude",
        primary: { usedPercent: 31, remainingPercent: 69, windowDurationMins: 300, checkedAt },
      },
    ],
  });
  const tokenAuth = (
    reason?: "signed_out" | "rate_limited" | "unreachable",
  ): ServerProvider["auth"] => ({
    status: "authenticated",
    type: "longLivedOAuthToken",
    capabilities: { usage: { status: "unavailable", ...(reason ? { reason } : {}) } },
  });

  it("asks for sign-in only when Claude is signed out, and keeps the numbers it has", () => {
    // Signed out with no numbers at all: one line and the offer, no empty meters.
    expect(
      deriveProviderAccountUsagePresentationForProvider(
        { driver: claude, auth: tokenAuth("signed_out") },
        nowMs,
      ),
    ).toEqual({
      label: "Claude usage",
      reachedLimit: false,
      windows: [],
      notice: { signIn: true, text: "Claude is signed out. Sign in to see usage." },
    });

    // Signed out, but chats keep the meter fed.
    const fed = deriveProviderAccountUsagePresentationForProvider(
      {
        driver: claude,
        auth: tokenAuth("signed_out"),
        accountUsage: readingFrom("2026-07-09T11:58:00.000Z"),
      },
      nowMs,
    );
    expect(fed?.windows).toEqual([expect.objectContaining({ key: "primary", detail: "31% used" })]);
    expect(fed?.notice).toEqual({
      signIn: true,
      text: "Claude is signed out. Usage updates only when you chat.",
    });
  });

  it("stays quiet about a failed check while the kept numbers are recent", () => {
    for (const reason of ["rate_limited", "unreachable"] as const) {
      const recent = deriveProviderAccountUsagePresentationForProvider(
        {
          driver: claude,
          auth: tokenAuth(reason),
          accountUsage: readingFrom("2026-07-09T11:55:00.000Z"),
        },
        nowMs,
      );
      expect(recent?.notice).toBeUndefined();
      expect(recent?.windows[0]?.detail).toBe("31% used");
    }

    // Once the reading is old, each row says how old and the reason is named.
    const old = deriveProviderAccountUsagePresentationForProvider(
      {
        driver: claude,
        auth: tokenAuth("rate_limited"),
        accountUsage: readingFrom("2026-07-09T09:00:00.000Z"),
      },
      nowMs,
    );
    expect(old?.windows[0]?.detail).toBe("31% used · as of 3h ago");
    expect(old?.notice).toEqual({
      signIn: false,
      text: "Claude is limiting usage checks. Trying again soon.",
    });

    // Nothing to show yet: say it is temporary, and do not offer sign-in.
    expect(
      deriveProviderAccountUsagePresentationForProvider(
        { driver: claude, auth: tokenAuth("unreachable") },
        nowMs,
      )?.notice,
    ).toEqual({ signIn: false, text: "Couldn't check usage just now. Trying again soon." });
  });

  it("shows the notice when only token history exists, which has no meters of its own", () => {
    const presentation = deriveProviderAccountUsagePresentationForProvider(
      {
        driver: claude,
        auth: tokenAuth("signed_out"),
        accountUsage: {
          source: "claude-oauth-usage",
          checkedAt: "2026-07-09T11:58:00.000Z",
          limits: [],
          tokenUsage: {
            checkedAt: "2026-07-09T11:58:00.000Z",
            dailyBuckets: [{ startDate: "2026-07-08", tokens: 42 }],
            summary: { lifetimeTokens: 42 },
          },
        },
      },
      nowMs,
    );

    expect(presentation?.windows).toEqual([]);
    expect(presentation?.tokenUsage).toBeDefined();
    expect(presentation?.notice).toEqual({
      signIn: true,
      text: "Claude is signed out. Sign in to see usage.",
    });
  });

  it("uses the server's own words when it gives no reason, and never for API keys", () => {
    expect(
      deriveProviderAccountUsagePresentationForProvider(
        {
          driver: claude,
          auth: {
            status: "unauthenticated",
            type: "maxplan",
            capabilities: {
              chat: { status: "unavailable" },
              usage: { status: "unavailable", detail: "Usage was not checked." },
            },
          },
        },
        nowMs,
      )?.notice,
    ).toEqual({ signIn: false, text: "Usage was not checked." });

    // Nothing known to be wrong: no numbers and no claim about sign-in.
    expect(
      deriveProviderAccountUsagePresentationForProvider(
        { driver: claude, auth: { status: "authenticated", type: "maxplan" } },
        nowMs,
      ),
    ).toBeNull();
    expect(
      deriveProviderAccountUsagePresentationForProvider(
        {
          driver: claude,
          auth: {
            status: "authenticated",
            type: "apiKey",
            capabilities: { usage: { status: "unavailable" } },
          },
        },
        nowMs,
      ),
    ).toBeNull();
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
    expect(isProviderUsageNearLimit(deriveProviderAccountUsagePresentation(makeUsage(74)))).toBe(
      false,
    );
  });

  it("is true once any window crosses the threshold", () => {
    expect(isProviderUsageNearLimit(deriveProviderAccountUsagePresentation(makeUsage(75)))).toBe(
      true,
    );
  });

  it("blends the meter color from amber at the threshold to red at 100%", () => {
    expect(usageMeterColor(60, false)).toBeUndefined();
    expect(usageMeterColor(75, true)).toBe(
      "color-mix(in oklab, var(--color-destructive) 0%, var(--color-warning))",
    );
    expect(usageMeterColor(87.5, true)).toBe(
      "color-mix(in oklab, var(--color-destructive) 50%, var(--color-warning))",
    );
    expect(usageMeterColor(100, true)).toBe(
      "color-mix(in oklab, var(--color-destructive) 100%, var(--color-warning))",
    );
    // Provider-reported severity below the threshold stays amber.
    expect(usageMeterColor(40, true)).toBe(
      "color-mix(in oklab, var(--color-destructive) 0%, var(--color-warning))",
    );
  });

  it("colors the near-limit dot by the hottest meter and fully red when a limit is reached", () => {
    expect(providerUsageNearLimitColor(deriveProviderAccountUsagePresentation(makeUsage(50)))).toBe(
      undefined,
    );
    expect(providerUsageNearLimitColor(deriveProviderAccountUsagePresentation(makeUsage(80)))).toBe(
      "color-mix(in oklab, var(--color-destructive) 20%, var(--color-warning))",
    );
    const reached: ServerProviderAccountUsage = {
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
    expect(providerUsageNearLimitColor(deriveProviderAccountUsagePresentation(reached))).toBe(
      "color-mix(in oklab, var(--color-destructive) 100%, var(--color-warning))",
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

describe("providerRateLimitResetCreditExpirationUrgency", () => {
  const nowMs = Date.UTC(2026, 6, 14);
  const daysFromNow = (days: number) => (nowMs + days * 24 * 60 * 60 * 1000) / 1000;

  it("grades expiration urgency from remaining time", () => {
    expect(providerRateLimitResetCreditExpirationUrgency(undefined, nowMs)).toBe("normal");
    expect(providerRateLimitResetCreditExpirationUrgency(daysFromNow(-1), nowMs)).toBe("expired");
    expect(providerRateLimitResetCreditExpirationUrgency(daysFromNow(1), nowMs)).toBe("critical");
    expect(providerRateLimitResetCreditExpirationUrgency(daysFromNow(4), nowMs)).toBe("soon");
    expect(providerRateLimitResetCreditExpirationUrgency(daysFromNow(30), nowMs)).toBe("normal");
  });

  it("reports the highest urgency among usable credits only", () => {
    const credit = (status: "available" | "redeemed", expiresInDays: number) =>
      ({
        id: `reset-${status}-${expiresInDays}`,
        resetType: "codexRateLimits",
        status,
        grantedAt: daysFromNow(-30),
        expiresAt: daysFromNow(expiresInDays),
      }) as const;

    expect(providerRateLimitResetCreditsExpirationUrgency(undefined, nowMs)).toBeUndefined();
    expect(
      providerRateLimitResetCreditsExpirationUrgency([credit("available", 30)], nowMs),
    ).toBeUndefined();
    expect(
      providerRateLimitResetCreditsExpirationUrgency([credit("redeemed", 3)], nowMs),
    ).toBeUndefined();
    expect(
      providerRateLimitResetCreditsExpirationUrgency([credit("available", -1)], nowMs),
    ).toBeUndefined();
    expect(
      providerRateLimitResetCreditsExpirationUrgency(
        [credit("available", 30), credit("available", 3)],
        nowMs,
      ),
    ).toBe("soon");
    expect(
      providerRateLimitResetCreditsExpirationUrgency(
        [credit("available", 3), credit("available", 1)],
        nowMs,
      ),
    ).toBe("critical");
  });
});
