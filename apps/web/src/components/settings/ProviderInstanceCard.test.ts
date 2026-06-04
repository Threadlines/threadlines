import { describe, expect, it } from "vitest";
import type { ServerProviderAccountUsage, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderAccountUsagePresentation,
  deriveProviderModelsForDisplay,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("deriveProviderAccountUsagePresentation", () => {
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
