import { describe, expect, it } from "vitest";

import { normalizeTerminalActivityCommand } from "./terminalCommandTracker.ts";

describe("normalizeTerminalActivityCommand", () => {
  it("removes absolute executable paths from detected terminal activity commands", () => {
    expect(
      normalizeTerminalActivityCommand(
        `"C:\\Users\\wilfr\\OneDrive\\Desktop\\GitHubCode\\badcode\\.codex-local\\toolchain\\node.exe" -e "let n=0"`,
      ),
    ).toBe(`node -e "let n=0"`);
    expect(
      normalizeTerminalActivityCommand(
        `C:\\Users\\wilfr\\OneDrive\\Desktop\\GitHubCode\\badcode\\node_modules\\.bin\\vp.cmd run dev:desktop`,
      ),
    ).toBe("vp run dev:desktop");
  });
});
