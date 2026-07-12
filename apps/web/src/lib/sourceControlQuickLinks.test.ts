import { describe, expect, it } from "vite-plus/test";

import { deriveSourceControlQuickLinks } from "./sourceControlQuickLinks";

const githubStatus = {
  isRepo: true,
  sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
  remoteWebUrl: "https://github.com/Threadlines/threadlines",
  refName: "feature/open-menu",
  isDefaultRef: false,
  hasUpstream: true,
  pr: null,
} as const;

describe("deriveSourceControlQuickLinks", () => {
  it("builds repository, change-request, automation, and branch links for GitHub", () => {
    expect(deriveSourceControlQuickLinks(githubStatus)).toEqual({
      provider: githubStatus.sourceControlProvider,
      repository: "https://github.com/Threadlines/threadlines",
      changeRequests: "https://github.com/Threadlines/threadlines/pulls",
      automation: {
        label: "Actions",
        url: "https://github.com/Threadlines/threadlines/actions",
      },
      currentBranch: "https://github.com/Threadlines/threadlines/tree/feature/open-menu",
      changeRequest: null,
    });
  });

  it("builds GitLab merge-request and pipeline links", () => {
    expect(
      deriveSourceControlQuickLinks({
        ...githubStatus,
        sourceControlProvider: {
          kind: "gitlab",
          name: "GitLab",
          baseUrl: "https://gitlab.com",
        },
        remoteWebUrl: "https://gitlab.com/Threadlines/threadlines",
      }),
    ).toEqual({
      provider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" },
      repository: "https://gitlab.com/Threadlines/threadlines",
      changeRequests: "https://gitlab.com/Threadlines/threadlines/-/merge_requests",
      automation: {
        label: "Pipelines",
        url: "https://gitlab.com/Threadlines/threadlines/-/pipelines",
      },
      currentBranch: "https://gitlab.com/Threadlines/threadlines/-/tree/feature/open-menu",
      changeRequest: null,
    });
  });

  it("builds Bitbucket pull-request, pipeline, and source links", () => {
    const links = deriveSourceControlQuickLinks({
      ...githubStatus,
      sourceControlProvider: {
        kind: "bitbucket",
        name: "Bitbucket",
        baseUrl: "https://bitbucket.org",
      },
      remoteWebUrl: "https://bitbucket.org/threadlines/threadlines",
    });

    expect(links?.changeRequests).toBe(
      "https://bitbucket.org/threadlines/threadlines/pull-requests",
    );
    expect(links?.automation).toEqual({
      label: "Pipelines",
      url: "https://bitbucket.org/threadlines/threadlines/pipelines",
    });
    expect(links?.currentBranch).toBe(
      "https://bitbucket.org/threadlines/threadlines/src/feature%2Fopen-menu/",
    );
  });

  it("builds Azure DevOps pull-request, pipeline, and branch links", () => {
    const links = deriveSourceControlQuickLinks({
      ...githubStatus,
      sourceControlProvider: {
        kind: "azure-devops",
        name: "Azure DevOps",
        baseUrl: "https://dev.azure.com",
      },
      remoteWebUrl: "https://dev.azure.com/acme/project/_git/threadlines",
    });

    expect(links?.changeRequests).toBe(
      "https://dev.azure.com/acme/project/_git/threadlines/pullrequests",
    );
    expect(links?.automation).toEqual({
      label: "Pipelines",
      url: "https://dev.azure.com/acme/project/_build",
    });
    expect(links?.currentBranch).toBe(
      "https://dev.azure.com/acme/project/_git/threadlines?version=GBfeature%2Fopen-menu",
    );
  });

  it("keeps branch path slashes while encoding unsafe GitHub segment characters", () => {
    const links = deriveSourceControlQuickLinks({ ...githubStatus, refName: "fix/#12 attach" });
    expect(links?.currentBranch).toBe(
      "https://github.com/Threadlines/threadlines/tree/fix/%2312%20attach",
    );
  });

  it("surfaces the branch change request when status carries one", () => {
    const links = deriveSourceControlQuickLinks({
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
    expect(links?.changeRequest).toEqual({
      number: 52,
      state: "open",
      url: "https://github.com/Threadlines/threadlines/pull/52",
    });
  });

  it("omits branch links when they would be dead", () => {
    expect(
      deriveSourceControlQuickLinks({ ...githubStatus, hasUpstream: false })?.currentBranch,
    ).toBeNull();
    expect(
      deriveSourceControlQuickLinks({ ...githubStatus, isDefaultRef: true })?.currentBranch,
    ).toBeNull();
    expect(
      deriveSourceControlQuickLinks({ ...githubStatus, refName: null })?.currentBranch,
    ).toBeNull();
  });

  it("keeps a repository-only menu for unknown providers", () => {
    expect(
      deriveSourceControlQuickLinks({
        ...githubStatus,
        sourceControlProvider: {
          kind: "unknown",
          name: "Code Forge",
          baseUrl: "https://code.example.com",
        },
        remoteWebUrl: "https://code.example.com/team/repo",
      }),
    ).toMatchObject({
      repository: "https://code.example.com/team/repo",
      changeRequests: null,
      automation: null,
      currentBranch: null,
    });
  });

  it("returns null for missing providers, missing remotes, and non-repositories", () => {
    expect(
      deriveSourceControlQuickLinks({ ...githubStatus, sourceControlProvider: undefined }),
    ).toBeNull();
    expect(deriveSourceControlQuickLinks({ ...githubStatus, remoteWebUrl: null })).toBeNull();
    expect(deriveSourceControlQuickLinks({ ...githubStatus, isRepo: false })).toBeNull();
    expect(deriveSourceControlQuickLinks(null)).toBeNull();
  });
});
