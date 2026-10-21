import { describe, expect, it } from "vite-plus/test";

import { isInStableRelease } from "./agents";

describe("isInStableRelease", () => {
  it("compares versions numerically, so a 0.7.0 agent waits for 0.7.0 and stays after 0.10.0", () => {
    const agent = { since: "0.7.0" };
    expect(isInStableRelease(agent, "0.6.1")).toBe(false);
    expect(isInStableRelease(agent, "0.7.0")).toBe(true);
    expect(isInStableRelease(agent, "0.10.0")).toBe(true);
    expect(isInStableRelease({}, "0.2.4")).toBe(true);
  });
});
