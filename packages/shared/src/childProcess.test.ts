import { describe, expect, it } from "vitest";

import { hideWindowsConsole, type WindowsHiddenCommandOptions } from "./childProcess.ts";

describe("hideWindowsConsole", () => {
  it("adds windowsHide on Windows", () => {
    const options = hideWindowsConsole({ shell: true }, "win32") as WindowsHiddenCommandOptions;

    expect(options).toEqual({ shell: true, windowsHide: true });
  });

  it("leaves non-Windows options untouched", () => {
    const input = { shell: true } as const;

    expect(hideWindowsConsole(input, "linux")).toBe(input);
  });
});
