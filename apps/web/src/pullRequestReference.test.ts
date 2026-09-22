import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestReference, parsePullRequestUrl } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(parsePullRequestReference("https://github.com/Threadlines/threadlines/pull/42")).toBe(
      "https://github.com/Threadlines/threadlines/pull/42",
    );
  });

  it("accepts Azure DevOps pull request URLs", () => {
    expect(
      parsePullRequestReference("https://dev.azure.com/acme/project/_git/t3code/pullrequest/42"),
    ).toBe("https://dev.azure.com/acme/project/_git/t3code/pullrequest/42");
  });

  it("accepts GitLab merge request URLs", () => {
    expect(parsePullRequestReference("https://gitlab.com/group/project/-/merge_requests/42")).toBe(
      "https://gitlab.com/group/project/-/merge_requests/42",
    );
  });

  it("accepts legacy Azure DevOps pull request URLs", () => {
    expect(
      parsePullRequestReference("https://acme.visualstudio.com/project/_git/t3code/pullrequest/42"),
    ).toBe("https://acme.visualstudio.com/project/_git/t3code/pullrequest/42");
  });

  it("accepts raw numbers", () => {
    expect(parsePullRequestReference("42")).toBe("42");
  });

  it("accepts #number references", () => {
    expect(parsePullRequestReference("#42")).toBe("42");
  });

  it("accepts gh pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("gh pr checkout 42")).toBe("42");
  });

  it("accepts gh pr checkout commands with #number references", () => {
    expect(parsePullRequestReference("gh pr checkout #42")).toBe("42");
  });

  it("accepts gh pr checkout commands with GitHub pull request URLs", () => {
    expect(
      parsePullRequestReference(
        "gh pr checkout https://github.com/Threadlines/threadlines/pull/42",
      ),
    ).toBe("https://github.com/Threadlines/threadlines/pull/42");
  });

  it("accepts glab mr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("glab mr checkout 42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("az repos pr checkout --id 42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with equals-style ids", () => {
    expect(parsePullRequestReference("az repos pr checkout --id=42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with extra flags", () => {
    expect(parsePullRequestReference("az repos pr checkout --id 42 --remote-name origin")).toBe(
      "42",
    );
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
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
