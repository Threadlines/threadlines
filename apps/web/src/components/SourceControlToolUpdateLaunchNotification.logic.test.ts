import type {
  SourceControlDiscoveryResult,
  SourceControlToolVersionAdvisory,
} from "@threadlines/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  collectSourceControlToolUpdateNotices,
  sourceControlToolUpdateToastCopy,
} from "./SourceControlToolUpdateLaunchNotification.logic";

function advisory(
  overrides: Partial<SourceControlToolVersionAdvisory>,
): SourceControlToolVersionAdvisory {
  return {
    status: "behind_latest",
    severity: "info",
    currentVersion: "2.97.0",
    latestVersion: "2.98.0",
    recommendedVersion: "2.98.0",
    checkedAt: null,
    message: null,
    notificationKey: "github-cli:2.98.0",
    actions: [],
    ...overrides,
  };
}

function discovery(
  input: {
    readonly git?: SourceControlToolVersionAdvisory;
    readonly github?: SourceControlToolVersionAdvisory;
  } = {},
): SourceControlDiscoveryResult {
  return {
    versionControlSystems: [
      {
        kind: "git",
        label: "Git",
        implemented: true,
        status: "available",
        version: Option.some("git version 2.55.0.windows.3"),
        installHint: "Install Git.",
        detail: Option.none(),
        ...(input.git ? { versionAdvisory: input.git } : {}),
      },
    ],
    sourceControlProviders: [
      {
        kind: "github",
        label: "GitHub",
        status: "available",
        version: Option.some("gh version 2.97.0"),
        installHint: "Install GitHub CLI.",
        detail: Option.none(),
        auth: {
          status: "authenticated",
          account: Option.some("octocat"),
          host: Option.some("github.com"),
          detail: Option.none(),
        },
        ...(input.github ? { versionAdvisory: input.github } : {}),
      },
    ],
  };
}

describe("collectSourceControlToolUpdateNotices", () => {
  it("notifies for plain newer releases, not only security floors", () => {
    const notices = collectSourceControlToolUpdateNotices({
      discovery: discovery({
        github: advisory({}),
        git: advisory({ status: "current", notificationKey: null }),
      }),
      environmentKey: "environment:env-1",
    });

    expect(notices.map((notice) => notice.dismissalKey)).toEqual([
      "environment:env-1:github-cli:2.98.0",
    ]);
  });
});

describe("sourceControlToolUpdateToastCopy", () => {
  it("reads as available for plain releases and recommended once a security floor is involved", () => {
    const github = {
      label: "GitHub",
      advisory: advisory({}),
      dismissalKey: "environment:env-1:github-cli:2.98.0",
    };
    const git = {
      label: "Git",
      advisory: advisory({
        status: "recommended_update",
        severity: "warning",
        message: "This Git for Windows version is below the recommended security-fix release.",
        notificationKey: "git-for-windows:2.56.0.windows.1",
      }),
      dismissalKey: "environment:env-1:git-for-windows:2.56.0.windows.1",
    };

    expect(sourceControlToolUpdateToastCopy([github])).toEqual({
      type: "info",
      title: "GitHub update available",
      description: "A newer GitHub release is available.",
    });
    expect(sourceControlToolUpdateToastCopy([git])).toEqual({
      type: "warning",
      title: "Git update recommended",
      description: "This Git for Windows version is below the recommended security-fix release.",
    });
    expect(sourceControlToolUpdateToastCopy([git, github])).toEqual({
      type: "warning",
      title: "2 source control updates recommended",
      description: "Git and GitHub have newer releases, including a recommended security fix.",
    });
  });
});
