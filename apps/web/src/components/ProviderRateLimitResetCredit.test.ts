import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@threadlines/contracts";

import {
  canRequestProviderRateLimitResetCredit,
  formatProviderRateLimitResetCreditConfirmation,
  formatProviderRateLimitResetCreditTooltip,
  isProviderUsageLimitErrorMessage,
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

  it("keeps reset confirmation copy explicit about spending one credit", () => {
    expect(formatProviderRateLimitResetCreditConfirmation(2)).toContain(
      "spends 1 of your 2 reset credits",
    );
    expect(formatProviderRateLimitResetCreditConfirmation(1)).toContain("spends your reset credit");
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
