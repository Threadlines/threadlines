import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

interface SourceSpec {
  readonly provider: UsageProviderKind;
  readonly hostId: string;
  readonly homePath: string;
  readonly volumeId?: string;
  readonly distinctSessions?: number;
  readonly lastScannedAt?: string;
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly SourceSpec[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      status: "ok" as const,
      lastScannedAt: source.lastScannedAt ?? "2026-08-07T00:00:00.000Z",
      scannedFiles: 1,
      skippedFiles: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

const claudeSource = (hostId: string): SourceSpec => ({
  provider: "claude",
  hostId,
  homePath: "/Users/will/.claude/projects",
});

describe("mergeUsage", () => {
  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [claudeSource("mac")])),
        environment(
          "env-b",
          summary([bucket({ costUsd: 4 })], [{ ...claudeSource("windows"), distinctSessions: 3 }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.records).toBe(10);
    expect(merged.sessions).toBe(4);
    expect(merged.contributingEnvironments).toEqual(["env-a", "env-b"]);
    expect(merged.duplicateSources).toEqual([]);
  });

  it("counts a directory once when two environments on one machine scan it", () => {
    // Worktree servers resolve the same provider home; summing both would
    // double every token on that machine.
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [claudeSource("mac")])),
        environment("env-b", summary([bucket()], [claudeSource("mac")])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.sessions).toBe(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
    expect(merged.duplicateSources).toEqual(["env-b: /Users/will/.claude/projects"]);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac with the default computer name resolves the same path, so only
    // the filesystem identity can tell them apart.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ ...claudeSource("macbook-pro"), volumeId: "1:2" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ ...claudeSource("macbook-pro"), volumeId: "3:4" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toEqual([]);
  });

  it("drops only the duplicated provider, not the whole environment", () => {
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [claudeSource("mac")])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 3 })],
            [claudeSource("mac"), { provider: "codex", hostId: "mac", homePath: "/x/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(13);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["claude", "codex"]);
  });

  it("excludes an environment on an older contract instead of failing", () => {
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [claudeSource("mac")])),
        environment(
          "env-b",
          summary([bucket()], [claudeSource("windows")], USAGE_CONTRACT_VERSION - 1),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("splits cost quality across the three provenances", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ records: 2, costSource: "providerReported" }),
              bucket({
                day: "2026-08-08" as UsageDay,
                records: 6,
                unpricedRecords: 3,
                costSource: "modelPriced",
              }),
            ],
            [claudeSource("mac")],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.records).toBe(8);
    expect(merged.costQuality.providerReportedShare).toBeCloseTo(2 / 8, 9);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(3 / 8, 9);
    expect(merged.costQuality.modelPricedShare).toBeCloseTo(3 / 8, 9);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("reports the oldest scan across contributing sources", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ ...claudeSource("mac"), lastScannedAt: "2026-08-07T09:00:00Z" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ ...claudeSource("windows"), lastScannedAt: "2026-08-07T06:00:00Z" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.oldestScanAt).toBe("2026-08-07T06:00:00Z");
  });

  it("totals tokens without adding reasoning on top of output", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({
                totals: {
                  uncachedInputTokens: 1,
                  cachedInputTokens: 2,
                  cacheCreationTokens: 3,
                  outputTokens: 4,
                  reasoningTokens: 2,
                },
              }),
            ],
            [claudeSource("mac")],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.totalTokens).toBe(10);
    expect(merged.reasoningTokens).toBe(2);
  });
});
