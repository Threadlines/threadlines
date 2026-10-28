import { describe, expect, it } from "vite-plus/test";

import {
  museAccountUsage,
  museAuth,
  museModelCapabilities,
  museModelName,
} from "./MuseProvider.ts";

describe("Muse Code provider snapshot", () => {
  it("shows the plan's 5-hour window and weekly block as usage limits", () => {
    const usage = museAccountUsage(
      {
        tier: "high",
        window: { usedPercent: 40, resetsAtMs: 1_800_000_000_000, windowDurationMins: 300 },
        weekly: { usedPercent: 12, resetsAtMs: 1_800_500_000_000 },
      },
      "2026-10-15T12:00:00.000Z",
    );
    expect(usage?.limits[0]).toMatchObject({
      planType: "high",
      primary: {
        usedPercent: 40,
        remainingPercent: 60,
        resetsAt: 1_800_000_000,
        windowDurationMins: 300,
      },
      secondary: { usedPercent: 12, remainingPercent: 88, resetsAt: 1_800_500_000 },
    });
    expect(museAccountUsage({}, "2026-10-15T12:00:00.000Z")).toBeUndefined();
    // The tier Muse 1.4.9 really sends is an internal number, not a plan name.
    const numbered = museAccountUsage(
      { tier: "27681393394859588", window: { usedPercent: 2, windowDurationMins: 300 } },
      "2026-10-15T12:00:00.000Z",
    );
    expect(numbered?.limits[0]?.planType).toBeUndefined();
  });

  it("marks an API key as billed per use, and a Meta sign-in as the plan", () => {
    // The account's email goes where Settings hides it, not in the label.
    expect(museAuth({ state: "accountLogin", label: " me@example.com " })).toEqual({
      status: "authenticated",
      type: "metaAccount",
      label: "Meta account",
      email: "me@example.com",
    });
    expect(museAuth({ state: "apiKey" }).type).toBe("apiKey");
    expect(museAuth({ state: "loggedOut", credentialRequired: true }).status).toBe(
      "unauthenticated",
    );
    expect(museAuth(undefined).status).toBe("unknown");
  });

  it("names a model readably when Muse's label is just its id", () => {
    expect(museModelName({ modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3" })).toBe(
      "Muse Spark 1.3",
    );
    expect(museModelName({ modelId: "muse-wonder-1.0" })).toBe("Muse Wonder 1.0");
    expect(museModelName({ modelId: "muse-x", displayLabel: "Muse X (preview)" })).toBe(
      "Muse X (preview)",
    );
  });

  it("offers the reasoning tiers a model reports, without `none`", () => {
    const capabilities = museModelCapabilities({
      variants: ["none", "low", "high", "max"],
      defaultReasoningEffort: "high",
      reasoningEffortVariants: [{ tier: "max", description: "Deepest" }],
    });
    const select = capabilities.optionDescriptors?.[0];
    expect(select?.type === "select" && select.options.map((option) => option.id)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(select?.type === "select" && select.currentValue).toBe("high");
  });
});
