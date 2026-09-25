import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageHourBucket,
  type UsageProviderKind,
} from "@threadlines/contracts";
import { mergeUsage, type MergedUsage } from "@threadlines/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  assignUsageModelSlots,
  buildDayWindowView,
  buildHourWindowView,
  buildUsageBarChart,
  buildUsageStats,
  visibleUsageModels,
} from "./usageView.logic";

function bucket(input: {
  readonly day: string;
  readonly provider?: UsageProviderKind;
  readonly model: string;
  readonly cached: number;
  readonly uncached: number;
}): UsageBucket {
  return {
    day: input.day as UsageDay,
    provider: input.provider ?? "claude",
    model: input.model,
    totals: {
      uncachedInputTokens: input.uncached,
      cachedInputTokens: input.cached,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 1,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  };
}

function merge(
  buckets: readonly UsageBucket[],
  hourlyBuckets: readonly UsageHourBucket[] = [],
): MergedUsage {
  return mergeUsage(
    [
      {
        environmentId: "env-a" as EnvironmentId,
        label: "Studio",
        summary: {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-09-25T00:00:00.000Z",
          timeZone: "UTC",
          sinceDay: "2026-06-28" as UsageDay,
          untilDay: "2026-09-25" as UsageDay,
          buckets,
          hourlyBuckets,
          sources: (["claude", "codex"] as const).map((provider) => ({
            fingerprint: {
              hostId: "studio",
              provider,
              resolvedHomePath: `/${provider}`,
              volumeId: "1",
            },
            status: "ok" as const,
            lastScannedAt: "2026-09-25T00:00:00.000Z",
            scannedFiles: 1,
            skippedFiles: 0,
            distinctSessions: 1,
            message: null,
          })),
          pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
          scanDurationMs: 1,
        },
      },
    ],
    USAGE_CONTRACT_VERSION,
  );
}

describe("assignUsageModelSlots", () => {
  it("gives the leading Claude model the first slot and folds models past six", () => {
    const merged = merge([
      bucket({
        day: "2026-09-25",
        provider: "codex",
        model: "gpt-6-astra",
        cached: 900,
        uncached: 100,
      }),
      bucket({ day: "2026-09-25", model: "claude-fable-5-1", cached: 500, uncached: 100 }),
      ...["a", "b", "c", "d", "e"].map((suffix, index) =>
        bucket({ day: "2026-09-25", model: `claude-${suffix}`, cached: 0, uncached: 50 - index }),
      ),
    ]);

    const slots = assignUsageModelSlots(visibleUsageModels(merged));

    // Terracotta stays with Claude even when a Codex model used more.
    expect(slots.get("claude claude-fable-5-1")).toBe(0);
    expect(slots.get("codex gpt-6-astra")).toBe(1);
    expect(slots.get("claude claude-d")).toBe(5);
    expect(slots.has("claude claude-e")).toBe(false);
  });
});

describe("buildUsageBarChart", () => {
  it("takes cache reads out of every bar when they are left out", () => {
    const merged = merge([
      bucket({ day: "2026-09-25", model: "claude-fable-5-1", cached: 9_000, uncached: 1_000 }),
      bucket({
        day: "2026-09-25",
        provider: "codex",
        model: "gpt-6-astra",
        cached: 0,
        uncached: 500,
      }),
    ]);
    const view = buildDayWindowView({
      merged,
      scanDaily: merged.daily,
      scanSinceDay: "2026-06-28",
      sinceDay: "2026-09-25",
      untilDay: "2026-09-25",
    });
    const chartFor = (includeCacheReads: boolean) =>
      buildUsageBarChart({
        view,
        group: "models",
        metric: "tokens",
        includeCacheReads,
        modelSlots: assignUsageModelSlots(visibleUsageModels(merged)),
      }).columns[0];

    expect(chartFor(true)?.totalLabel).toBe("10.5K");
    expect(chartFor(true)?.entries.map((entry) => entry.label)).toEqual([
      "claude-fable-5-1",
      "gpt-6-astra",
    ]);
    expect(chartFor(false)?.totalLabel).toBe("1.5K");
    expect(chartFor(false)?.entries.map((entry) => entry.valueLabel)).toEqual(["1K", "500"]);
  });
});

describe("buildUsageStats", () => {
  const scan = merge([
    bucket({ day: "2026-09-15", model: "claude-fable-5-1", cached: 0, uncached: 1_000 }),
    bucket({ day: "2026-09-20", model: "claude-fable-5-1", cached: 0, uncached: 1_500 }),
  ]);
  const previousStat = (sinceDay: string) => {
    const window = merge(
      [bucket({ day: "2026-09-20", model: "claude-fable-5-1", cached: 0, uncached: 1_500 })].filter(
        (entry) => entry.day >= sinceDay,
      ),
    );
    const view = buildDayWindowView({
      merged: window,
      scanDaily: scan.daily,
      scanSinceDay: "2026-06-28",
      sinceDay,
      untilDay: "2026-09-25",
    });
    return buildUsageStats(view).at(-1);
  };

  it("compares with the same number of days right before the window", () => {
    expect(previousStat("2026-09-19")).toEqual({
      label: "vs previous 7 days",
      value: "+50%",
      context: "1K from Sep 12 to Sep 18",
    });
  });

  it("says n/a rather than compare against days the scan never read", () => {
    expect(previousStat("2026-06-28")?.value).toBe("n/a");
  });

  it("counts the last 24 hours by hour and compares with the 24 before", () => {
    const hour = (iso: string, uncached: number): UsageHourBucket => ({
      hourStartMs: Date.parse(iso),
      provider: "claude",
      model: "claude-fable-5-1",
      totals: {
        uncachedInputTokens: uncached,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 1,
      records: 1,
    });
    const merged = merge(
      [],
      [
        // Too old for either stretch.
        hour("2026-09-23T10:00:00Z", 9_000),
        // The 24 hours before the window.
        hour("2026-09-24T13:00:00Z", 1_000),
        hour("2026-09-25T13:00:00Z", 500),
        hour("2026-09-25T14:00:00Z", 1_000),
      ],
    );

    const view = buildHourWindowView({
      hourly: merged.hourly,
      anchorMs: Date.parse("2026-09-25T14:20:00Z"),
    });

    expect(view.periods).toHaveLength(24);
    expect(view.periods.at(-1)?.isCurrent).toBe(true);
    expect(view.breakdown.totalTokens).toBe(1_500);
    expect(buildUsageStats(view).map((stat) => [stat.label, stat.value, stat.context])).toEqual([
      ["Hourly average", "750", "2 of 24 hours active"],
      ["Busiest hour", "1K", expect.any(String)],
      ["This hour so far", "1K", "133% of an average hour"],
      ["Cache hit rate", "0.0%", "of input came from cache"],
      ["vs previous 24 hours", "+50%", "1K in the 24 hours before"],
    ]);
  });
});
