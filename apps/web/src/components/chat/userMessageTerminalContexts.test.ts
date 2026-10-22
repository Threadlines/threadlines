import { describe, expect, it } from "vite-plus/test";

import {
  buildInlineTerminalContextText,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

describe("userMessageTerminalContexts", () => {
  it("builds plain inline terminal text labels", () => {
    expect(
      buildInlineTerminalContextText([
        { header: "Terminal 1 lines 12-13" },
        { header: "Terminal 2 line 4" },
      ]),
    ).toBe("@terminal-1:12-13 @terminal-2:4");
  });

  it("detects inline terminal labels embedded in user message text", () => {
    expect(
      textContainsInlineTerminalContextLabels("yo @terminal-1:12-13 whats up", [
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe(true);
    expect(
      textContainsInlineTerminalContextLabels("yo whats up", [
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe(false);
  });
});
