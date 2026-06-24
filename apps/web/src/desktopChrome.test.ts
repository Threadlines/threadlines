import { describe, expect, it } from "vitest";

import {
  MAC_SIDEBAR_WORDMARK_ROW_CLASS,
  MAC_SIDEBAR_WORDMARK_SPACER_CLASS,
  WINDOWS_SIDEBAR_WORDMARK_ROW_CLASS,
  resolveElectronSidebarWordmarkLayout,
} from "./desktopChrome";

describe("resolveElectronSidebarWordmarkLayout", () => {
  it("keeps the traffic-light clearance row on macOS", () => {
    expect(resolveElectronSidebarWordmarkLayout("MacIntel")).toEqual({
      spacerClassName: MAC_SIDEBAR_WORDMARK_SPACER_CLASS,
      wordmarkRowClassName: MAC_SIDEBAR_WORDMARK_ROW_CLASS,
    });
  });

  it("places the wordmark in the titlebar row on Windows", () => {
    const layout = resolveElectronSidebarWordmarkLayout("Win32");

    expect(layout).toEqual({
      spacerClassName: null,
      wordmarkRowClassName: WINDOWS_SIDEBAR_WORDMARK_ROW_CLASS,
    });
    expect(layout.wordmarkRowClassName).toContain("pl-[var(--workspace-titlebar-content-left)]");
  });
});
