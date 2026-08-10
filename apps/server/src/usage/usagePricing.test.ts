import { describe, expect, it } from "vite-plus/test";

import { lookupRate, parseRateTable } from "./usagePricing.ts";

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
  });

  it("never prices an ambiguous family name", () => {
    // "opus" spans generations; guessing one would be a fabricated number.
    const table = parseRateTable({
      opus: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });

    expect(lookupRate(table, "opus")).toBeNull();
  });
});
