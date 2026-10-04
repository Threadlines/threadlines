import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSourceChangesLabel,
  resolveContinueInProjectHeaderState,
  shouldShowOpenInEditor,
} from "./ChatHeader";

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

describe("formatSourceChangesLabel", () => {
  it("reads the counts and what clicking does", () => {
    expect(
      formatSourceChangesLabel({
        workingTreeChanges: { insertions: 38, deletions: 12, fileCount: 3 },
        remoteBehindCount: 2,
      }),
    ).toBe(
      "Uncommitted changes: 38 added, 12 removed. 2 commits behind the remote. Open the Source tab.",
    );
  });

  it("names files when the changes add no lines, and a lone behind count", () => {
    expect(
      formatSourceChangesLabel({
        workingTreeChanges: { insertions: 0, deletions: 0, fileCount: 1 },
        remoteBehindCount: null,
      }),
    ).toBe("Uncommitted changes in 1 file. Open the Source tab.");
    expect(formatSourceChangesLabel({ workingTreeChanges: null, remoteBehindCount: 1 })).toBe(
      "1 commit behind the remote. Open the Source tab.",
    );
  });
});
