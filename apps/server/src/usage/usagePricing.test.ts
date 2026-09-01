import { describe, expect, it } from "vite-plus/test";

import type { UsageTokenTotals } from "@threadlines/contracts";

import { lookupRate, parseRateTable, priceUsage } from "./usagePricing.ts";

const NO_TOKENS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

describe("parseRateTable", () => {
  it("prefers the un-prefixed entry over routing-prefixed duplicates", () => {
    // LiteLLM publishes the same model many times over with a routing prefix,
    // sometimes at different rates. They all normalise to one key, so the
    // canonical entry has to win regardless of enumeration order.
    const table = parseRateTable({
      "azure/gpt-5.6-sol": { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
      "gpt-5.6-sol": { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
      "openrouter/gpt-5.6-sol": { input_cost_per_token: 7e-6, output_cost_per_token: 7e-5 },
    });

    expect(lookupRate(table, "gpt-5.6-sol")?.inputCostPerToken).toBe(5e-6);
  });

  it("drops entries missing either half of the base rate", () => {
    // A half-priced model under-reports silently, which is worse than saying
    // the model is unpriced.
    const table = parseRateTable({
      "half-priced": { input_cost_per_token: 1e-6 },
      priced: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });

    expect(lookupRate(table, "half-priced")).toBeNull();
    // Cache rates fall back to the plain input rate rather than to free.
    expect(lookupRate(table, "priced")?.cacheReadCostPerToken).toBe(1e-6);
    expect(lookupRate(table, "priced")?.cacheCreation1hCostPerToken).toBe(1e-6);
  });

  it("never prices an ambiguous family name", () => {
    // "opus" spans generations; guessing one would be a fabricated number.
    const table = parseRateTable({
      opus: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });

    expect(lookupRate(table, "opus")).toBeNull();
  });
});

describe("priceUsage", () => {
  it("prices the 1-hour share of a cache write at the 1-hour rate", () => {
    // Claude Code writes most of its cache with the 1h TTL, which bills at 2x
    // input where the 5m TTL bills at 1.25x. Pricing the flat total at the 5m
    // rate under-reports every long session.
    const table = parseRateTable({
      "claude-fable-5": {
        input_cost_per_token: 1e-5,
        output_cost_per_token: 5e-5,
        cache_read_input_token_cost: 1e-6,
        cache_creation_input_token_cost: 1.25e-5,
        cache_creation_input_token_cost_above_1hr: 2e-5,
      },
    });

    const priced = priceUsage(table, {
      model: "claude-fable-5",
      totals: { ...NO_TOKENS, cacheCreationTokens: 1000 },
      cacheCreation1hTokens: 600,
      reportedCostUsd: null,
    });

    // 400 tokens at the 5m rate plus 600 at the 1h rate.
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(400 * 1.25e-5 + 600 * 2e-5, 12);
  });

  it("prices a model LiteLLM has not published from the built-in rates", () => {
    // Claude Fable 5.1 launched with cache reads at $0.25/MTok, a quarter of
    // Fable 5's. Guessing from the previous generation would be wrong; leaving
    // it unpriced would zero out the most expensive model on the page.
    const priced = priceUsage(new Map(), {
      model: "claude-fable-5-1",
      totals: { ...NO_TOKENS, uncachedInputTokens: 1_000_000, cachedInputTokens: 1_000_000 },
      cacheCreation1hTokens: 0,
      reportedCostUsd: null,
    });

    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(10 + 0.25, 9);

    // Once LiteLLM publishes the model, its entry wins.
    const table = parseRateTable({
      "claude-fable-5-1": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });
    expect(lookupRate(table, "claude-fable-5-1")?.inputCostPerToken).toBe(1e-6);
  });
});
