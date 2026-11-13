import { describe, expect, it } from "vite-plus/test";

import { buildTextReceiverScript } from "./textReceiverScript.ts";

// The script is a string that only ever runs inside the guest page, where a
// syntax error is invisible: typing would fail on every page with nothing to
// say why. Parsing it here is what makes that loud.
describe("buildTextReceiverScript", () => {
  it("parses as JavaScript with and without clearing", () => {
    expect(() => new Function(`return ${buildTextReceiverScript()}`)).not.toThrow();
    expect(
      () => new Function(`return ${buildTextReceiverScript({ clearBefore: 1 })}`),
    ).not.toThrow();
  });
});
