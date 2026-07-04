import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import type { ProviderAccountUsagePresentation } from "../../lib/providerUsage";
import { ContextWindowMeter } from "./ContextWindowMeter";

const TEST_CONTEXT_WINDOW: ContextWindowSnapshot = {
  usedTokens: 50_000,
  totalProcessedTokens: 80_000,
  maxTokens: 200_000,
  remainingTokens: 150_000,
  usedPercentage: 25,
  remainingPercentage: 75,
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
  updatedAt: "2026-06-19T12:00:00.000Z",
};

const TEST_ACCOUNT_USAGE: ProviderAccountUsagePresentation = {
  label: "Codex usage",
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
      detail: "2% used - resets in 4h 32m",
      usedPercent: 2,
      remainingPercent: 98,
      reachedLimit: false,
      warning: false,
    },
    {
      key: "secondary",
      label: "Weekly",
      detail: "36% used - resets in 6d",
      usedPercent: 36,
      remainingPercent: 64,
      reachedLimit: false,
      warning: false,
    },
  ],
  tokenUsage: {
    label: "Token history",
    summary: [{ key: "lifetimeTokens", label: "Lifetime tokens", value: "6.35B" }],
    buckets: [
      {
        startDate: "2026-06-18",
        label: "Jun 18",
        tokens: 279_500_000,
        tokenLabel: "279.5m",
        intensityPercent: 100,
      },
    ],
  },
};

describe("ContextWindowMeter", () => {
  it("keeps the composer usage popout compact and dismissible", async () => {
    const screen = await render(
      <div>
        <button type="button" style={{ position: "fixed", bottom: 8, left: 8, zIndex: 1000 }}>
          Outside target
        </button>
        <ContextWindowMeter usage={TEST_CONTEXT_WINDOW} accountUsage={TEST_ACCOUNT_USAGE} />
      </div>,
    );

    try {
      await page.getByRole("button", { name: /Context window/ }).click();

      await expect.element(page.getByText("Codex usage")).toBeVisible();
      await expect.element(page.getByText(/2 available/)).toBeVisible();
      await expect.element(page.getByText(/30-day grant window/)).toBeVisible();
      await expect.element(page.getByText("Token history")).not.toBeInTheDocument();
      await expect.element(page.getByText(/Lifetime tokens/)).not.toBeInTheDocument();

      await page.getByRole("button", { name: "Outside target" }).click();

      await expect.element(page.getByText("Codex usage")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps manual compaction enabled at low context usage", async () => {
    const onCompactContext = vi.fn();
    const usedPercentage = (44_272 / 258_400) * 100;
    const screen = await render(
      <ContextWindowMeter
        usage={{
          ...TEST_CONTEXT_WINDOW,
          usedTokens: 44_272,
          maxTokens: 258_400,
          remainingTokens: 214_128,
          usedPercentage,
          remainingPercentage: 100 - usedPercentage,
          compactsAutomatically: true,
        }}
        onCompactContext={onCompactContext}
        contextCompactDisabled={false}
      />,
    );

    try {
      await page.getByRole("button", { name: /Context window/ }).click();

      const compactButton = page.getByRole("button", { name: "Compact now" });
      await expect.element(compactButton).toBeVisible();
      await expect.element(compactButton).not.toBeDisabled();

      await compactButton.click();
      expect(onCompactContext).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
