import { describe, expect, it } from "vite-plus/test";

import { resolveAddProjectUnavailableGuidance } from "./addProject.logic";

describe("resolveAddProjectUnavailableGuidance", () => {
  it("routes an unpaired hosted visitor to Devices instead of reporting a failure", () => {
    const guidance = resolveAddProjectUnavailableGuidance({ isHostedStatic: true });

    expect(guidance.type).toBe("warning");
    expect(guidance.title).toBe("Pair a computer to add projects");
    expect(guidance.action).toEqual({ label: "Open Connections", to: "/settings/connections" });
  });

  it("keeps the plain error for a desktop session that really has no environment", () => {
    expect(resolveAddProjectUnavailableGuidance({ isHostedStatic: false })).toEqual({
      type: "error",
      title: "Can't browse projects",
      description: "No computer is available.",
      action: null,
    });
  });
});
