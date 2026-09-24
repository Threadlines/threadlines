import { describe, expect, it } from "vite-plus/test";

import {
  detectSourceControlProviderFromRemoteUrl,
  findPullRequestUrls,
  getChangeRequestTerminologyForKind,
  parsePullRequestUrl,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });

  it("preserves ports while classifying by hostname", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com:8443/group/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.com:8443",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://self-hosted.example.test:8443/group/repo.git",
      ),
    ).toEqual({
      kind: "unknown",
      name: "self-hosted.example.test:8443",
      baseUrl: "https://self-hosted.example.test:8443",
    });
  });
});

describe("parsePullRequestUrl", () => {
  it("names the repository and number a GitHub address points at", () => {
    expect(parsePullRequestUrl("https://github.com/Threadlines/threadlines/pull/234")).toEqual({
      repository: "Threadlines/threadlines",
      number: 234,
    });
  });

  it("resolves a link into one part of the same pull request", () => {
    expect(
      parsePullRequestUrl("https://github.com/Threadlines/threadlines/pull/234/files"),
    ).toEqual({ repository: "Threadlines/threadlines", number: 234 });
  });

  it("names nothing for the hosts whose rows nothing here lists by repository", () => {
    expect(parsePullRequestUrl("https://gitlab.com/group/project/-/merge_requests/42")).toBeNull();
    expect(
      parsePullRequestUrl("https://dev.azure.com/acme/project/_git/t3code/pullrequest/42"),
    ).toBeNull();
  });

  it("names nothing for a GitHub address that is not a pull request", () => {
    expect(parsePullRequestUrl("https://github.com/Threadlines/threadlines/issues/234")).toBeNull();
  });
});

describe("findPullRequestUrls", () => {
  it("finds each pull request a message links to once, bare or as a markdown link", () => {
    const text = [
      "Done. The new PR is [#294](https://github.com/Threadlines/threadlines/pull/294).",
      "It builds on https://github.com/threadlines/Threadlines/pull/292/files, and",
      "(https://github.com/Threadlines/threadlines/pull/294) again, not issue",
      "https://github.com/Threadlines/threadlines/issues/12.",
    ].join("\n");
    expect(findPullRequestUrls(text)).toEqual([
      { repository: "Threadlines/threadlines", number: 294 },
      { repository: "threadlines/Threadlines", number: 292 },
    ]);
  });
});
