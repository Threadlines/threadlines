import { describe, expect, it } from "vite-plus/test";

import { effectiveRuntimeMode, runtimeModeOnAgent } from "./runtimeMode.ts";

describe("effectiveRuntimeMode", () => {
  it("keeps a level the agent has and steps down, never up, to one it lacks", () => {
    const pi = ["approval-required", "auto-accept-edits", "full-access"] as const;
    expect(effectiveRuntimeMode("full-access", pi)).toBe("full-access");
    expect(effectiveRuntimeMode("auto", pi)).toBe("auto-accept-edits");

    const grok = ["approval-required", "auto", "full-access"] as const;
    expect(effectiveRuntimeMode("auto-accept-edits", grok)).toBe("approval-required");

    // Nothing as safe on offer: Supervised, never a more permissive level.
    expect(effectiveRuntimeMode("auto-accept-edits", ["auto", "full-access"])).toBe(
      "approval-required",
    );
  });
});

describe("runtimeModeOnAgent", () => {
  it("reads a driver without a list as the three legacy levels, narrowed by its model", () => {
    // A driver that lists nothing (Pi) has no Auto.
    expect(
      runtimeModeOnAgent({ requested: "auto", providerModes: undefined, modelModes: undefined }),
    ).toBe("auto-accept-edits");
    // A model without Auto on a driver that has it runs at the next safer level.
    expect(
      runtimeModeOnAgent({
        requested: "auto",
        providerModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
        modelModes: ["approval-required", "auto-accept-edits", "full-access"],
      }),
    ).toBe("auto-accept-edits");
  });
});
