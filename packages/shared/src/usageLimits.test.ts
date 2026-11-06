import type { ServerProviderAccountUsage } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isAccountUsageNearLimit } from "./usageLimits.ts";

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
