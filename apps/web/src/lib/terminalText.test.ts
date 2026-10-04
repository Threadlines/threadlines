import { describe, expect, it } from "vite-plus/test";

import { lastPrintedLine } from "./terminalText";

describe("lastPrintedLine", () => {
  it("reads the newest line as the screen shows it", () => {
    const esc = String.fromCharCode(0x1b);
    const output = [
      `${esc}]0;vite${String.fromCharCode(0x07)}  VITE v8.0.3  ready`,
      `  ${esc}[32m➜${esc}[39m  Local:   http://localhost:5173/`,
      "Building 10%\rBuilding 55%\rBuilding 100%",
      "",
      "",
    ].join("\r\n");

    expect(lastPrintedLine(output)).toBe("Building 100%");
    expect(lastPrintedLine(output.replace(/Building[^\n]*/u, ""))).toBe(
      "➜  Local:   http://localhost:5173/",
    );
  });

  it("has nothing to say about empty output", () => {
    expect(lastPrintedLine("\r\n\r\n")).toBeNull();
    expect(lastPrintedLine(null)).toBeNull();
  });
});
