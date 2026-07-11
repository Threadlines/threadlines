import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveContinueInProjectHeaderState, shouldShowOpenInEditor } from "./ChatHeader";

describe("shouldShowOpenInEditor", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInEditor({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInEditor({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInEditor({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInEditor({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("resolveContinueInProjectHeaderState", () => {
  it("uses the default tooltip when continuation is available", () => {
    expect(resolveContinueInProjectHeaderState(null)).toEqual({
      disabled: false,
      tooltip: "Start a project thread seeded with this chat",
    });
  });

  it("uses the disabled reason as the tooltip when continuation is blocked", () => {
    expect(
      resolveContinueInProjectHeaderState(
        "Wait for the current response to finish before continuing into a project.",
      ),
    ).toEqual({
      disabled: true,
      tooltip: "Wait for the current response to finish before continuing into a project.",
    });
  });
});
