import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("SETTINGS_NAV_ITEMS", () => {
  it("keeps remote connections out of the visible settings navigation", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).not.toContain("Connections");
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).not.toContain("/settings/connections");
  });
});
