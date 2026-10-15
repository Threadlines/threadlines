import { describe, expect, it } from "vite-plus/test";

import {
  museBillingRefusal,
  museHostEnvironment,
  museHostProfile,
  refreshMuseHostEnvironment,
} from "./MuseLaunch.ts";

describe("museHostProfile", () => {
  it("gives each kind of work its own flags, profile and approval mode", () => {
    const profile = (input: Partial<Parameters<typeof museHostProfile>[0]>) =>
      museHostProfile({
        purpose: "chat",
        runtimeMode: "approval-required",
        contributorMode: false,
        sandboxAvailable: true,
        ...input,
      });
    expect(profile({})).toMatchObject({
      args: ["serve", "--trust-workspace", "--contributor-mode", "off"],
      permissionProfile: ":ask-me",
      approvalMode: "promptUnmatched",
      autoApproveWorkspaceWrites: false,
    });
    expect(profile({ runtimeMode: "auto-accept-edits" })).toMatchObject({
      permissionProfile: ":ask-me",
      autoApproveWorkspaceWrites: true,
    });
    expect(profile({ runtimeMode: "auto" }).permissionProfile).toBe(":auto-review");
    expect(profile({ runtimeMode: "full-access", contributorMode: true })).toMatchObject({
      args: ["serve", "--trust-workspace", "--disable-sandbox", "--contributor-mode", "on"],
      permissionProfile: ":unrestricted",
      approvalMode: "allowAll",
      autoApproveSubagents: true,
    });
    // Plan mode is read-only whatever the access level, and never auto-approves.
    expect(profile({ purpose: "plan", runtimeMode: "full-access" })).toMatchObject({
      args: ["serve", "--trust-workspace", "--disable-write", "--contributor-mode", "off"],
      permissionProfile: ":read-only",
      autoApproveSubagents: false,
    });
    // A sandbox that may not hold turns the shell off too.
    expect(profile({ purpose: "plan", sandboxAvailable: undefined }).args).toContain(
      "--disable-shell",
    );
    // Ephemeral hosts refuse a profile; nothing they start can act.
    expect(profile({ purpose: "utility", contributorMode: undefined })).toMatchObject({
      args: ["serve", "--no-session-log", "--disable-shell", "--disable-write"],
      permissionProfile: undefined,
      approvalMode: "denyUnmatched",
    });
  });
});

describe("museHostEnvironment", () => {
  it("drops an inherited API key, keeps one the instance sets, and stops auto-updates", () => {
    const inherited = museHostEnvironment(undefined, { PATH: "/bin", meta_api_key: "inherited" });
    expect(inherited).toEqual({ PATH: "/bin", MUSE_NO_AUTO_UPDATE: "1" });
    const explicit = museHostEnvironment(
      [{ name: "META_API_KEY", value: "chosen", sensitive: true }],
      { META_API_KEY: "inherited" },
    );
    expect(explicit.META_API_KEY).toBe("chosen");
  });

  it("keeps an inherited API key out when the shared environment is refreshed", () => {
    const shared = museHostEnvironment(undefined, { PATH: "/bin", OLD: "gone" });
    refreshMuseHostEnvironment(shared, undefined, { PATH: "/usr/bin", META_API_KEY: "inherited" });
    expect(shared).toEqual({ PATH: "/usr/bin", MUSE_NO_AUTO_UPDATE: "1" });
  });
});

describe("museBillingRefusal", () => {
  it("never runs on a key, or on a sign-in it cannot read, unless per-use billing is on", () => {
    const refusal = (
      accountState: string | undefined,
      extra: Partial<Parameters<typeof museBillingRefusal>[0]> = {},
    ) =>
      museBillingRefusal({
        allowApiKeyBilling: false,
        accountState,
        instanceEnvironment: undefined,
        ...extra,
      });
    expect(refusal("accountLogin")).toBeUndefined();
    expect(refusal("loggedOut")).toBeUndefined();
    expect(refusal("apiKey")).toBe("apiKey");
    expect(refusal("envKey")).toBe("apiKey");
    expect(refusal(undefined)).toBe("unknown");
    expect(refusal("someNewState")).toBe("unknown");
    expect(
      refusal("accountLogin", {
        instanceEnvironment: [{ name: "META_API_KEY", value: "k", sensitive: true }],
      }),
    ).toBe("apiKey");
    expect(refusal(undefined, { allowApiKeyBilling: true })).toBeUndefined();
  });
});
