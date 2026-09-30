import { describe, expect, it } from "vite-plus/test";

import {
  formatRetirementDate,
  modelRetirementMetaLabel,
  readModelRetirement,
  retirementRecheckDelayMs,
} from "./modelRetirement";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const RETIRES_AT = Date.parse("2026-10-14T19:00:00.000Z");
const US_UTC = { locale: "en-US", timeZone: "UTC" };
const retiring = {
  upgradeInfo: { model: "gpt-5.6-sol", retiresAt: "2026-10-14T19:00:00.000Z" },
};

describe("readModelRetirement", () => {
  it("names the date and a replacement the user can pick", () => {
    const retirement = readModelRetirement(
      retiring,
      [
        { slug: "gpt-5.5", name: "GPT-5.5" },
        { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      ],
      NOW,
      US_UTC,
    );

    expect(retirement).toEqual({
      retiresAtMs: RETIRES_AT,
      retired: false,
      dateLabel: "Oct 14",
      replacement: { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    });
    expect(retirement && modelRetirementMetaLabel(retirement)).toBe("Retires Oct 14");
  });

  it("offers no replacement the picker doesn't list", () => {
    expect(
      readModelRetirement(retiring, [{ slug: "gpt-5.5", name: "GPT-5.5" }], NOW)?.replacement,
    ).toBeNull();
  });

  it("reads a past date as retired, and a model without one as not retiring", () => {
    const retired = readModelRetirement(retiring, [], Date.parse("2026-11-01T00:00:00Z"), US_UTC);
    expect(retired && modelRetirementMetaLabel(retired)).toBe("Retired Oct 14");
    expect(readModelRetirement({ upgradeInfo: { model: "gpt-5.6-sol" } }, [], NOW)).toBeNull();
    expect(readModelRetirement({}, [], NOW)).toBeNull();
  });
});

describe("formatRetirementDate", () => {
  it("adds the year only when the date falls in another year", () => {
    expect(formatRetirementDate(RETIRES_AT, NOW, US_UTC)).toBe("Oct 14");
    expect(formatRetirementDate(RETIRES_AT, Date.parse("2025-12-01T00:00:00Z"), US_UTC)).toBe(
      "Oct 14, 2026",
    );
  });
});

describe("retirementRecheckDelayMs", () => {
  it("re-reads the clock just after the deadline, capped to what a timer can wait", () => {
    expect(retirementRecheckDelayMs(RETIRES_AT, RETIRES_AT - 60_000)).toBe(61_000);
    expect(retirementRecheckDelayMs(RETIRES_AT, NOW - 90 * 86_400_000)).toBe(2 ** 31 - 1);
    expect(retirementRecheckDelayMs(RETIRES_AT, RETIRES_AT)).toBeNull();
  });
});
