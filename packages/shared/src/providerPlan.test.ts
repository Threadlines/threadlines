import { describe, expect, it } from "vite-plus/test";

import { isProviderPlanGateMessage } from "./providerPlan.ts";

describe("isProviderPlanGateMessage", () => {
  it("matches the short plan-gate replies providers actually send", () => {
    expect(isProviderPlanGateMessage("\n\nUpgrade your plan to continue")).toBe(true);
    expect(isProviderPlanGateMessage("Error: Payment Required")).toBe(true);
    expect(isProviderPlanGateMessage("This model requires a Pro plan.")).toBe(true);
    expect(isProviderPlanGateMessage("Insufficient credits for this request")).toBe(true);
    expect(
      isProviderPlanGateMessage(
        "fx returned no output. Provider status: ⚠ Rate limited · HTTP 429 · rate_limit_exceeded: Free tier requests on this model are rate-limited. Upgrade to paid credits at https://vercel.com/d for unrestricted access. · recovery paused after 10/10 attempts",
      ),
    ).toBe(true);
  });

  it("ignores ordinary content that merely mentions plans or upgrades", () => {
    expect(isProviderPlanGateMessage(null)).toBe(false);
    expect(isProviderPlanGateMessage("Here is the plan: 1. upgrade the dependency …")).toBe(false);
    expect(
      isProviderPlanGateMessage(
        `To migrate, upgrade your plan file first. ${"x".repeat(400)} Then run the tests.`,
      ),
    ).toBe(false);
  });
});
