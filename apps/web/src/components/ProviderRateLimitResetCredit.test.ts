import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@threadlines/contracts";

import {
  canRequestProviderRateLimitResetCredit,
  formatProviderRateLimitResetCreditConfirmation,
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
