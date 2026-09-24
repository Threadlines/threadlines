import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import { unsupportedNodeMessage } from "./nodeVersionCheck.ts";

const supportedRange = packageJson.engines.node;

describe("unsupportedNodeMessage", () => {
  it("lets every supported Node line through", () => {
    for (const version of ["22.22.2", "24.15.0", "24.18.0", "26.1.0"]) {
      expect(unsupportedNodeMessage(version, supportedRange)).toBeNull();
    }
  });

  it("names the running version and the supported range for older or odd-numbered Node", () => {
    for (const version of ["22.13.1", "23.11.0", "24.13.1", "20.19.0"]) {
      const message = unsupportedNodeMessage(version, supportedRange);
      expect(message).toContain(`This is ${version}`);
      expect(message).toContain(supportedRange);
      expect(message).toContain("https://nodejs.org");
    }
  });
});
