import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@threadlines/contracts";

import {
  canUseProviderRateLimitResetCredit,
  canRequestProviderRateLimitResetCredit,
  formatProviderRateLimitResetCreditDate,
  formatProviderRateLimitResetCreditRelativeExpiration,
  formatProviderRateLimitResetCreditTooltip,
  isProviderUsageLimitErrorMessage,
  sortProviderRateLimitResetCreditsByExpiration,
  toastForProviderRateLimitResetCreditOutcome,
} from "./ProviderRateLimitResetCredit";

describe("ProviderRateLimitResetCredit", () => {
  it("only enables reset credit actions for Codex providers with available credits", () => {
    expect(
      canRequestProviderRateLimitResetCredit({ driver: ProviderDriverKind.make("codex") }, 1),
    ).toBe(true);
    expect(
      canRequestProviderRateLimitResetCredit({ driver: ProviderDriverKind.make("codex") }, 0),
    ).toBe(false);
    expect(
      canRequestProviderRateLimitResetCredit({ driver: ProviderDriverKind.make("claudeAgent") }, 1),
    ).toBe(false);
  });

  it("formats reset grant and expiration timestamps as readable dates", () => {
    const timestamp = Date.UTC(2026, 6, 17) / 1000;
    expect(formatProviderRateLimitResetCreditDate(timestamp, "en-US", "UTC")).toBe("Jul 17, 2026");
    expect(
      formatProviderRateLimitResetCreditRelativeExpiration(
        timestamp,
        Date.UTC(2026, 6, 14),
        "en-US",
      ),
    ).toBe("in 3 days");
  });

  it("only allows available, unexpired detailed credits to be used", () => {
    const credit = {
      id: "reset-1",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: Date.UTC(2026, 5, 17) / 1000,
      expiresAt: Date.UTC(2026, 6, 17) / 1000,
    } as const;
    expect(canUseProviderRateLimitResetCredit(credit, Date.UTC(2026, 6, 16))).toBe(true);
    expect(canUseProviderRateLimitResetCredit(credit, Date.UTC(2026, 6, 18))).toBe(false);
    expect(
      canUseProviderRateLimitResetCredit({ ...credit, status: "redeemed" }, Date.UTC(2026, 6, 16)),
    ).toBe(false);
  });

  it("sorts credits soonest-expiring first with non-expiring credits last", () => {
    const credit = (id: string, expiresAt?: number) =>
      ({
        id,
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: Date.UTC(2026, 5, 17) / 1000,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }) as const;

    const sorted = sortProviderRateLimitResetCreditsByExpiration([
      credit("no-expiry"),
      credit("late", Date.UTC(2026, 7, 12) / 1000),
      credit("soon", Date.UTC(2026, 6, 17) / 1000),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["soon", "late", "no-expiry"]);
  });

  it("uses reset tooltip copy that names both Codex usage windows", () => {
    expect(formatProviderRateLimitResetCreditTooltip(1)).toBe(
      "Use your reset credit to refresh the current Codex 5h and weekly usage windows.",
    );
    expect(formatProviderRateLimitResetCreditTooltip(3)).toContain("1 of your 3 reset credits");
  });

  it("recognizes provider usage-limit failures", () => {
    expect(
      isProviderUsageLimitErrorMessage(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage",
      ),
    ).toBe(true);
    expect(isProviderUsageLimitErrorMessage("usageLimitExceeded")).toBe(true);
    expect(isProviderUsageLimitErrorMessage("Sandbox setup failed")).toBe(false);
  });

  it("maps reset outcomes to compact toast messages", () => {
    expect(toastForProviderRateLimitResetCreditOutcome("reset")).toMatchObject({
      type: "success",
      title: "Codex usage reset",
    });
    expect(toastForProviderRateLimitResetCreditOutcome("noCredit")).toMatchObject({
      type: "warning",
      title: "No reset credit available",
    });
  });
});
