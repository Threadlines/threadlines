import { describe, expect, it } from "vite-plus/test";

import { isHostInjectedConsoleEntry } from "./previewConsoleNoise.ts";

describe("isHostInjectedConsoleEntry", () => {
  it("drops Electron's injected security warning", () => {
    expect(
      isHostInjectedConsoleEntry({
        level: "warning",
        text: "%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; This renderer process has either no Content Security Policy set...",
      }),
    ).toBe(true);
  });

  it("keeps warnings the page itself produced", () => {
    expect(isHostInjectedConsoleEntry({ level: "warning", text: "deprecated prop `size`" })).toBe(
      false,
    );
  });

  it("never drops errors, even if the page mentions Electron", () => {
    // A page debugging its own Electron integration must still see its errors.
    expect(
      isHostInjectedConsoleEntry({
        level: "error",
        text: "Electron Security Warning handling failed",
      }),
    ).toBe(false);
  });
});
