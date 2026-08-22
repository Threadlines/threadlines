import { assert, describe, it } from "@effect/vitest";

import { resolveTelemetryConsent, scrubUserPaths, truncateTail } from "./DesktopCrashReport.ts";

describe("scrubUserPaths", () => {
  it("replaces the home directory in both separator styles and any casing", () => {
    const text =
      "Error: EACCES at C:\\Users\\wilfredo\\.threadlines\\userdata\\state.sqlite " +
      "(also seen as c:/users/wilfredo/.threadlines/logs)";
    const scrubbed = scrubUserPaths(text, "C:\\Users\\wilfredo");
    assert.equal(
      scrubbed,
      "Error: EACCES at ~\\.threadlines\\userdata\\state.sqlite (also seen as ~/.threadlines/logs)",
    );
  });

  it("handles posix home directories and leaves unrelated text alone", () => {
    const scrubbed = scrubUserPaths("failed at /Users/will/x; port 3773 busy", "/Users/will");
    assert.equal(scrubbed, "failed at ~/x; port 3773 busy");
  });

  it("is a no-op for an empty home directory", () => {
    assert.equal(scrubUserPaths("text", ""), "text");
  });
});

describe("truncateTail", () => {
  it("keeps the end of oversized output, where the fatal error lands", () => {
    assert.equal(truncateTail("abcdef", 4), "cdef");
    assert.equal(truncateTail("abc", 4), "abc");
  });
});

describe("resolveTelemetryConsent", () => {
  it("defaults to enabled without settings", () => {
    assert.isTrue(resolveTelemetryConsent({ envOverride: undefined, rawSettingsJson: undefined }));
  });

  it("honors usageAnalyticsEnabled from settings", () => {
    assert.isFalse(
      resolveTelemetryConsent({
        envOverride: undefined,
        rawSettingsJson: JSON.stringify({ usageAnalyticsEnabled: false }),
      }),
    );
    assert.isTrue(
      resolveTelemetryConsent({
        envOverride: undefined,
        rawSettingsJson: JSON.stringify({ usageAnalyticsEnabled: true }),
      }),
    );
  });

  it("lets the env override win in both directions", () => {
    assert.isFalse(
      resolveTelemetryConsent({
        envOverride: "false",
        rawSettingsJson: JSON.stringify({ usageAnalyticsEnabled: true }),
      }),
    );
    assert.isTrue(
      resolveTelemetryConsent({
        envOverride: "true",
        rawSettingsJson: JSON.stringify({ usageAnalyticsEnabled: false }),
      }),
    );
  });

  it("keeps the default when settings are unreadable", () => {
    assert.isTrue(resolveTelemetryConsent({ envOverride: undefined, rawSettingsJson: "not json" }));
  });
});
