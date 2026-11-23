import type { ServerProviderAccountUsage } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isAccountUsageNearLimit,
  usageLimitForModel,
  usageScopeHoldsModel,
} from "./usageLimits.ts";

const NOW_MS = Date.parse("2026-11-06T12:00:00.000Z");
const reading = (
  window: { readonly usedPercent: number; readonly resetsAt?: number },
  ordinaryUsageAllowed?: boolean,
): ServerProviderAccountUsage => ({
  source: "codex-rate-limits",
  checkedAt: "2026-11-06T11:59:00.000Z",
  ...(ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
  limits: [
    {
      primary: {
        usedPercent: window.usedPercent,
        remainingPercent: 100 - window.usedPercent,
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      },
    },
  ],
});
const inAnHour = Math.floor(NOW_MS / 1000) + 3600;

describe("isAccountUsageNearLimit", () => {
  it("is near from the given percent of a window, until that window resets", () => {
    expect(
      isAccountUsageNearLimit(reading({ usedPercent: 89, resetsAt: inAnHour }), NOW_MS, 90),
    ).toBe(false);
    expect(
      isAccountUsageNearLimit(reading({ usedPercent: 90, resetsAt: inAnHour }), NOW_MS, 90),
    ).toBe(true);
    // The reading is older than the reset it names.
    expect(
      isAccountUsageNearLimit(reading({ usedPercent: 95, resetsAt: inAnHour - 7200 }), NOW_MS, 90),
    ).toBe(false);
  });

  it("takes the backend's word that usage isn't allowed, and goes ahead with no reading", () => {
    expect(isAccountUsageNearLimit(reading({ usedPercent: 10 }, false), NOW_MS, 90)).toBe(true);
    expect(isAccountUsageNearLimit(undefined, NOW_MS, 90)).toBe(false);
  });
});

describe("Antigravity's family limits", () => {
  const gemini = { name: "Gemini", models: ["Gemini"], excludes: ["Argon"] };
  const shared = { name: "Claude & GPT", models: ["Claude", "GPT"] };

  it("hold the models of their family and leave out those with a pool of their own", () => {
    expect(usageScopeHoldsModel(gemini, "Gemini 3.1 Pro")).toBe(true);
    expect(usageScopeHoldsModel(gemini, "Gemini 4 Argon")).toBe(false);
    expect(
      usageScopeHoldsModel({ name: "Gemini 4 Argon", models: ["Argon"] }, "Gemini 4 Argon"),
    ).toBe(true);
    expect(usageScopeHoldsModel(shared, "Claude Sonnet 5.5")).toBe(true);
    expect(usageScopeHoldsModel(shared, "GPT-OSS 120B")).toBe(true);
    expect(usageScopeHoldsModel(shared, "Gemini 3.1 Pro")).toBe(false);
    // A model's own limit (Claude's) still matches its name as whole words.
    expect(usageScopeHoldsModel({ name: "Opus 5" }, "Claude Opus 5.5")).toBe(false);
    expect(usageScopeHoldsModel({ name: "Fable" }, "Claude Fable 5.2")).toBe(true);
  });

  it("stop a model only on its own family's spent window", () => {
    const resetsAt = NOW_MS + 3_600_000;
    const usage: ServerProviderAccountUsage = {
      source: "grok-billing",
      checkedAt: "2026-11-06T11:59:00.000Z",
      limits: [
        {
          limitId: "antigravity",
          scoped: [
            {
              scopeLabel: "Gemini",
              scopeModels: ["Gemini"],
              usedPercent: 40,
              remainingPercent: 60,
            },
            {
              scopeLabel: "Claude & GPT",
              scopeModels: ["Claude", "GPT"],
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt,
              windowDurationMins: 300,
            },
          ],
        },
      ],
    };
    expect(usageLimitForModel(usage, "Claude Opus 5.5", NOW_MS)).toEqual({
      window: "session",
      resetsAt: new Date(resetsAt).toISOString(),
    });
    expect(usageLimitForModel(usage, "Gemini 3.1 Pro", NOW_MS)).toBeUndefined();
    // Past its reset, the reading is older than the window.
    expect(usageLimitForModel(usage, "Claude Opus 5.5", resetsAt + 1)).toBeUndefined();
  });
});
