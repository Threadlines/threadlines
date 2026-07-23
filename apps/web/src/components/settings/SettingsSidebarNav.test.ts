import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SETTINGS_SECTION_PATH,
  HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH,
  HOSTED_STATIC_SETTINGS_NAV_ITEMS,
  HOSTED_STATIC_SETTINGS_SECTION_PATHS,
  rememberVisibleSettingsSection,
  resetRememberedSettingsSectionForTest,
  resolveSettingsEntryPath,
  resolveSettingsEntryRedirect,
  SETTINGS_NAV_ITEMS,
  VISIBLE_SETTINGS_SECTION_PATHS,
} from "./settingsNavigation";

describe("SETTINGS_NAV_ITEMS", () => {
  it("keeps device connection settings visible in the settings navigation", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).toContain("Devices");
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).toContain("/settings/connections");
  });

  it("matches the visible settings section paths", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).toEqual([...VISIBLE_SETTINGS_SECTION_PATHS]);
  });

  it("keeps hosted phone navigation to phone-safe settings sections", () => {
    expect(HOSTED_STATIC_SETTINGS_NAV_ITEMS.map((item) => item.to)).toEqual([
      "/settings/general",
      "/settings/providers",
      "/settings/plugins",
      "/settings/instructions",
      "/settings/source-control",
      "/settings/connections",
      "/settings/archived",
    ]);
    expect(HOSTED_STATIC_SETTINGS_NAV_ITEMS.map((item) => item.to)).toEqual([
      ...HOSTED_STATIC_SETTINGS_SECTION_PATHS,
    ]);
  });
});

describe("settings entry navigation", () => {
  it("defaults generic settings entry to General before a section has been visited", () => {
    resetRememberedSettingsSectionForTest();

    expect(resolveSettingsEntryPath()).toBe(DEFAULT_SETTINGS_SECTION_PATH);
  });

  it("remembers the last visited visible settings section", () => {
    resetRememberedSettingsSectionForTest();

    rememberVisibleSettingsSection("/settings/providers");
    expect(resolveSettingsEntryPath()).toBe("/settings/providers");

    rememberVisibleSettingsSection("/settings/keybindings");
    expect(resolveSettingsEntryPath()).toBe("/settings/keybindings");
  });

  it("does not remember hidden settings routes", () => {
    resetRememberedSettingsSectionForTest();

    rememberVisibleSettingsSection("/settings/providers");
    rememberVisibleSettingsSection("/settings/diagnostics");

    expect(resolveSettingsEntryPath()).toBe("/settings/providers");
  });
});

describe("resolveSettingsEntryRedirect", () => {
  it("redirects the bare settings path to the entry section on desktop", () => {
    resetRememberedSettingsSectionForTest();

    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings",
        isHostedStatic: false,
        isMobileViewport: false,
      }),
    ).toBe(DEFAULT_SETTINGS_SECTION_PATH);

    rememberVisibleSettingsSection("/settings/providers");
    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings",
        isHostedStatic: false,
        isMobileViewport: false,
      }),
    ).toBe("/settings/providers");
  });

  it("keeps the bare settings path on mobile so the section index renders", () => {
    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings",
        isHostedStatic: false,
        isMobileViewport: true,
      }),
    ).toBeNull();

    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings",
        isHostedStatic: true,
        isMobileViewport: true,
      }),
    ).toBeNull();
  });

  it("allows remote-capable hosted sections and redirects desktop-only sections", () => {
    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings/providers",
        isHostedStatic: true,
        isMobileViewport: true,
      }),
    ).toBeNull();

    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings/keybindings",
        isHostedStatic: true,
        isMobileViewport: true,
      }),
    ).toBe(HOSTED_STATIC_DEFAULT_SETTINGS_SECTION_PATH);
  });

  it("renders visible sections without redirecting", () => {
    expect(
      resolveSettingsEntryRedirect({
        pathname: "/settings/keybindings",
        isHostedStatic: false,
        isMobileViewport: false,
      }),
    ).toBeNull();
  });
});
