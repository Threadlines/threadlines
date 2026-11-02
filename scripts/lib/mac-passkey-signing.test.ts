import { assert, describe, it } from "@effect/vitest";

import {
  validateMacPasskeyProfile,
  withPasskeyEntitlements,
  type MacProvisioningProfileFacts,
} from "./mac-passkey-signing.ts";

const APP_ID = "dev.threadlines.app";
const NOW = new Date("2026-11-02T00:00:00Z");
const PROFILE: MacProvisioningProfileFacts = {
  teamId: "ABCDE12345",
  applicationIdentifier: "ABCDE12345.dev.threadlines.app",
  keychainAccessGroups: ["ABCDE12345.*"],
  provisionsAllDevices: true,
  expiresAt: new Date("2027-11-02T00:00:00Z"),
};

describe("validateMacPasskeyProfile", () => {
  it("names the passkey keychain group a Developer ID profile authorizes", () => {
    assert.deepStrictEqual(validateMacPasskeyProfile(PROFILE, APP_ID, NOW), {
      teamId: "ABCDE12345",
      applicationIdentifier: "ABCDE12345.dev.threadlines.app",
      keychainAccessGroup: "ABCDE12345.dev.threadlines.app.webauthn",
    });
  });

  it("refuses a profile the signed app could not launch with", () => {
    for (const [profile, reason] of [
      [{ ...PROFILE, applicationIdentifier: "ABCDE12345.dev.threadlines.app.dev" }, /not "/u],
      [{ ...PROFILE, provisionsAllDevices: false }, /Developer ID/u],
      [{ ...PROFILE, expiresAt: new Date("2026-11-01T00:00:00Z") }, /expired/u],
      [{ ...PROFILE, keychainAccessGroups: ["ZZZZZ99999.*"] }, /does not authorize/u],
    ] as const) {
      assert.throws(() => validateMacPasskeyProfile(profile, APP_ID, NOW), reason);
    }
  });
});

describe("withPasskeyEntitlements", () => {
  it("adds the passkey claims to the base entitlements, keeping the rest", () => {
    const base = [
      "<plist>",
      "<dict>",
      "  <key>com.apple.security.cs.allow-jit</key>",
      "  <true/>",
      "</dict>",
      "</plist>",
    ].join("\n");
    const merged = withPasskeyEntitlements(base, validateMacPasskeyProfile(PROFILE, APP_ID, NOW));
    assert.include(merged, "<key>com.apple.security.cs.allow-jit</key>");
    assert.include(
      merged,
      "<key>keychain-access-groups</key>\n  <array>\n    <string>ABCDE12345.dev.threadlines.app.webauthn</string>",
    );
    assert.include(
      merged,
      "<key>com.apple.application-identifier</key>\n  <string>ABCDE12345.dev.threadlines.app</string>",
    );
    assert.isTrue(merged.trimEnd().endsWith("</dict>\n</plist>"));
  });
});
