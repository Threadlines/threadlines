import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import {
  DEFAULT_SETTINGS_SECTION_PATH,
  rememberVisibleSettingsSection,
  resetRememberedSettingsSectionForTest,
  resolveSettingsEntryPath,
  VISIBLE_SETTINGS_SECTION_PATHS,
} from "./settingsNavigation";

describe("SETTINGS_NAV_ITEMS", () => {
  it("keeps remote connections out of the visible settings navigation", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).not.toContain("Connections");
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).not.toContain("/settings/connections");
  });

  it("matches the visible settings section paths", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).toEqual([...VISIBLE_SETTINGS_SECTION_PATHS]);
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
