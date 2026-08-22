import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@threadlines/contracts";

import {
  type ContextWindowSnapshot,
  deriveCachedInputRate,
  deriveLatestContextWindowSnapshot,
  formatContextWindowPercentage,
  formatContextWindowTokens,
  formatContextWindowTokensCompact,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

function makeSnapshot(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 22_000,
    totalProcessedTokens: null,
    maxTokens: 200_000,
    remainingTokens: 178_000,
    usedPercentage: 11,
    remainingPercentage: 89,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    contextCategories: null,
    updatedAt: "2026-03-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("formats compact token counts without rounding up", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
    // Truncated at the displayed precision: 96,632 must not read as 97k.
    expect(formatContextWindowTokens(96_632)).toBe("96.6k");
    expect(formatContextWindowTokens(3456)).toBe("3.4k");
    expect(formatContextWindowTokens(999_950)).toBe("999.9k");
    expect(formatContextWindowTokens(1_460_000)).toBe("1.4m");
  });

  it("drops the k-range decimal in the compact variant without rounding up", () => {
    expect(formatContextWindowTokensCompact(48_120)).toBe("48k");
    expect(formatContextWindowTokensCompact(48_999)).toBe("48k");
    expect(formatContextWindowTokensCompact(3456)).toBe("3.4k");
    expect(formatContextWindowTokensCompact(1_460_000)).toBe("1.4m");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("keeps well-formed context categories and drops malformed entries", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 22_000,
        maxTokens: 200_000,
        contextCategories: [
          { name: "System prompt", tokens: 3000 },
          { name: "  ", tokens: 500 },
          { name: "Messages", tokens: Number.NaN },
          { name: "MCP tools", tokens: -10 },
          { name: "Skills", tokens: 19_000 },
        ],
      }),
    ]);

    expect(snapshot?.contextCategories).toEqual([
      { name: "System prompt", tokens: 3000 },
      { name: "Skills", tokens: 19_000 },
    ]);
  });

  it("reports no context categories when the provider sends none", () => {
    const withoutField = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", { usedTokens: 22_000 }),
    ]);
    const withEmptyList = deriveLatestContextWindowSnapshot([
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 22_000,
        contextCategories: [],
      }),
    ]);

    expect(withoutField?.contextCategories).toBeNull();
    expect(withEmptyList?.contextCategories).toBeNull();
  });

  it("derives the cached input rate only when input tokens are known", () => {
    const withRate = deriveCachedInputRate(
      makeSnapshot({ inputTokens: 1300, cachedInputTokens: 1200 }),
    );

    expect(withRate?.percentage).toBeCloseTo(92.3, 1);
    expect(withRate?.cachedTokens).toBe(1200);
    expect(withRate?.inputTokens).toBe(1300);

    expect(deriveCachedInputRate(null)).toBeNull();
    expect(deriveCachedInputRate(makeSnapshot({ inputTokens: 1300 }))).toBeNull();
    expect(deriveCachedInputRate(makeSnapshot({ cachedInputTokens: 1200 }))).toBeNull();
    expect(
      deriveCachedInputRate(makeSnapshot({ inputTokens: 0, cachedInputTokens: 0 })),
    ).toBeNull();
  });

  it("truncates percentages instead of rounding them", () => {
    expect(formatContextWindowPercentage(99.97)).toBe("99.9%");
    expect(formatContextWindowPercentage(99.5)).toBe("99.5%");
    expect(formatContextWindowPercentage(100)).toBe("100%");
    expect(formatContextWindowPercentage(99)).toBe("99%");
    expect(formatContextWindowPercentage(45.48)).toBe("45.4%");
    expect(formatContextWindowPercentage(7.2)).toBe("7.2%");
    expect(formatContextWindowPercentage(0)).toBe("0%");
    expect(formatContextWindowPercentage(null)).toBeNull();
    expect(formatContextWindowPercentage(Number.NaN)).toBeNull();
  });

  it("clamps a cached rate that exceeds the reported input tokens", () => {
    const rate = deriveCachedInputRate(makeSnapshot({ inputTokens: 100, cachedInputTokens: 400 }));

    expect(rate?.percentage).toBe(100);
  });

  it("derives low context usage without treating it as unavailable", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 44_272,
        maxTokens: 258_400,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedPercentage).toBeCloseTo(17.13, 2);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });
});
