import { describe, expect, it } from "vite-plus/test";

import { deriveGitHubQuickLinks } from "./gitHubQuickLinks";

const githubStatus = {
  isRepo: true,
  sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
  remoteWebUrl: "https://github.com/Threadlines/threadlines",
  refName: "feature/open-menu",
  isDefaultRef: false,
  hasUpstream: true,
  pr: null,
} as const;

describe("deriveGitHubQuickLinks", () => {
  it("builds repository, PR-list, actions, and branch links for GitHub remotes", () => {
    expect(deriveGitHubQuickLinks(githubStatus)).toEqual({
      repository: "https://github.com/Threadlines/threadlines",
      pullRequests: "https://github.com/Threadlines/threadlines/pulls",
      actions: "https://github.com/Threadlines/threadlines/actions",
      currentBranch: "https://github.com/Threadlines/threadlines/tree/feature/open-menu",
      pr: null,
    });
  });

  it("keeps branch path slashes while encoding unsafe segment characters", () => {
    const links = deriveGitHubQuickLinks({ ...githubStatus, refName: "fix/#12 attach" });
    expect(links?.currentBranch).toBe(
      "https://github.com/Threadlines/threadlines/tree/fix/%2312%20attach",
    );
  });

  it("surfaces the branch PR when the status carries one", () => {
    const links = deriveGitHubQuickLinks({
      ...githubStatus,
      pr: {
        number: 52,
        title: "Rework header",
        url: "https://github.com/Threadlines/threadlines/pull/52",
        baseRef: "main",
        headRef: "feature/open-menu",
        state: "open",
      },
    });
    expect(links?.pr).toEqual({
      number: 52,
      state: "open",
      url: "https://github.com/Threadlines/threadlines/pull/52",
    });
  });

  it("omits the branch link for unpushed branches, the default branch, and detached HEAD", () => {
    expect(deriveGitHubQuickLinks({ ...githubStatus, hasUpstream: false })?.currentBranch).toBe(
      null,
    );
    expect(deriveGitHubQuickLinks({ ...githubStatus, isDefaultRef: true })?.currentBranch).toBe(
      null,
    );
    expect(deriveGitHubQuickLinks({ ...githubStatus, refName: null })?.currentBranch).toBe(null);
  });

  it("returns null for non-GitHub providers, missing remotes, and non-repos", () => {
    expect(
      deriveGitHubQuickLinks({
        ...githubStatus,
        sourceControlProvider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" },
      }),
    ).toBeNull();
    expect(deriveGitHubQuickLinks({ ...githubStatus, remoteWebUrl: null })).toBeNull();
    expect(deriveGitHubQuickLinks({ ...githubStatus, isRepo: false })).toBeNull();
    expect(deriveGitHubQuickLinks(null)).toBeNull();
  });
});
