import type { SourceControlToolUpdateResult } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import { sourceControlToolUpdateResultCopy } from "./sourceControlToolUpdateCopy";

const discovery: SourceControlToolUpdateResult["discovery"] = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

describe("sourceControlToolUpdateResultCopy", () => {
  it("describes each outcome the server can report", () => {
    const base = {
      target: "github-cli",
      operation: "update",
      previousVersion: "2.97.0",
      currentVersion: "2.98.0",
      discovery,
    } as const;

    expect(
      sourceControlToolUpdateResultCopy({
        label: "GitHub CLI",
        result: { ...base, status: "succeeded" },
      }),
    ).toEqual({
      type: "success",
      title: "GitHub CLI updated",
      description: "2.97.0 to 2.98.0",
    });
    expect(
      sourceControlToolUpdateResultCopy({
        label: "Git",
        result: { ...base, target: "git", status: "started" },
      }).description,
    ).toContain("flashing shield in the taskbar");
    expect(
      sourceControlToolUpdateResultCopy({
        label: "GitHub CLI",
        result: { ...base, status: "unchanged" },
        managerLabel: "WinGet",
      }),
    ).toEqual({
      type: "info",
      title: "GitHub CLI is unchanged",
      description: "WinGet completed, but the detected version did not change.",
    });
  });
});
