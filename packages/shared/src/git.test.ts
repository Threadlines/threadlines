import type { VcsStatusRemoteResult, VcsStatusResult } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import {
  applyGitStatusStreamEvent,
  buildSshRemoteUrl,
  buildTemporaryWorktreeBranchName,
  classifyGitRemoteAuthFailure,
  deriveRepositoryDirectoryName,
  parseGitRemoteEndpoint,
  formatGitErrorMessage,
  gitRemoteAuthFailureFromError,
  isGitRepositoryMetadataCorruptionErrorMessage,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("https://github.com/T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/T3Tools/T3Code")).toBe(
      "github.com/t3tools/t3code",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:T3Tools/T3Code.git"),
    ).toBe("T3Tools/T3Code");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/T3Tools/T3Code.git"),
    ).toBe("T3Tools/T3Code");
  });
});

describe("deriveRepositoryDirectoryName", () => {
  it("uses the final repository path segment from provider identifiers and remotes", () => {
    expect(deriveRepositoryDirectoryName("t3-oss/t3-env")).toBe("t3-env");
    expect(deriveRepositoryDirectoryName("https://github.com/T3Tools/T3Code.git")).toBe("T3Code");
    expect(deriveRepositoryDirectoryName("git@github.com:T3Tools/T3Code.git")).toBe("T3Code");
    expect(deriveRepositoryDirectoryName("git@ssh.dev.azure.com:v3/acme/project/repo")).toBe(
      "repo",
    );
  });

  it("sanitizes values before using them as local directory names", () => {
    expect(deriveRepositoryDirectoryName("https://example.com/team/bad%3Aname.git")).toBe(
      "bad-name",
    );
    expect(deriveRepositoryDirectoryName("   ")).toBeNull();
  });
});

describe("isGitRepositoryMetadataCorruptionErrorMessage", () => {
  it("recognizes broken Git ref and object database failures", () => {
    expect(
      isGitRepositoryMetadataCorruptionErrorMessage(
        "Git command failed in GitVcsDriver.commitGraph: git log --all --topo-order (C:\\repo) - fatal: bad object refs/remotes/origin/HEAD",
      ),
    ).toBe(true);
    expect(
      isGitRepositoryMetadataCorruptionErrorMessage(
        "error: refs/remotes/origin/main: invalid sha1 pointer 3822d219c70a1a5deaee482ca6e796d85f01e8b3",
      ),
    ).toBe(true);
    expect(
      isGitRepositoryMetadataCorruptionErrorMessage("fatal: pack has 87 unresolved deltas"),
    ).toBe(true);
    expect(
      isGitRepositoryMetadataCorruptionErrorMessage(
        "missing tree 32d1aadc5c78d47a77066515ea21fb038d7c85c7",
      ),
    ).toBe(true);
  });

  it("does not classify ordinary Git command failures as repository corruption", () => {
    expect(isGitRepositoryMetadataCorruptionErrorMessage("Branch is behind upstream.")).toBe(false);
    expect(
      isGitRepositoryMetadataCorruptionErrorMessage(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).toBe(false);
  });
});

describe("parseGitRemoteEndpoint", () => {
  it("parses https, ssh, and scp-style remotes", () => {
    expect(parseGitRemoteEndpoint("https://github.com/badcuban/fire-alarm-tycoon.git")).toEqual({
      scheme: "https",
      host: "github.com",
      path: "badcuban/fire-alarm-tycoon",
    });
    expect(parseGitRemoteEndpoint("git@github.com:Threadlines/threadlines.git")).toEqual({
      scheme: "ssh",
      host: "github.com",
      path: "Threadlines/threadlines",
    });
    expect(parseGitRemoteEndpoint("ssh://git@gitlab.company.com:2222/team/project.git")).toEqual({
      scheme: "ssh",
      host: "gitlab.company.com",
      path: "team/project",
    });
  });

  it("rejects local paths and unsupported shapes", () => {
    expect(parseGitRemoteEndpoint("/Users/will/some/local/remote")).toBeNull();
    expect(parseGitRemoteEndpoint("C:\\repos\\local")).toBeNull();
    expect(parseGitRemoteEndpoint("")).toBeNull();
  });

  it("round-trips https endpoints into ssh remote URLs", () => {
    const endpoint = parseGitRemoteEndpoint("https://github.com/badcuban/fire-alarm-tycoon.git");
    expect(endpoint && buildSshRemoteUrl(endpoint)).toBe(
      "git@github.com:badcuban/fire-alarm-tycoon.git",
    );
  });
});

describe("classifyGitRemoteAuthFailure", () => {
  it("classifies HTTPS credential prompt failures with the host", () => {
    const deviceNotConfigured =
      "Git command failed in GitVcsDriver.pullCurrentBranch.fetch: git fetch --no-write-fetch-head origin +refs/heads/main:refs/remotes/origin/main (/repo) - fatal: could not read Username for 'https://github.com': Device not configured";
    expect(classifyGitRemoteAuthFailure(deviceNotConfigured)).toEqual({
      kind: "https_credentials_unavailable",
      scheme: "https",
      host: "github.com",
    });

    const promptsDisabled =
      "fatal: could not read Username for 'https://gitlab.company.com': terminal prompts disabled";
    expect(classifyGitRemoteAuthFailure(promptsDisabled)).toEqual({
      kind: "https_credentials_unavailable",
      scheme: "https",
      host: "gitlab.company.com",
    });
  });

  it("classifies rejected HTTPS credentials", () => {
    expect(
      classifyGitRemoteAuthFailure(
        "fatal: Authentication failed for 'https://github.com/owner/repo.git/'",
      ),
    ).toEqual({
      kind: "https_credentials_rejected",
      scheme: "https",
      host: "github.com",
    });
  });

  it("classifies SSH permission and host key failures", () => {
    expect(
      classifyGitRemoteAuthFailure(
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      ),
    ).toEqual({
      kind: "ssh_permission_denied",
      scheme: "ssh",
      host: "github.com",
    });

    expect(classifyGitRemoteAuthFailure("Host key verification failed.")).toEqual({
      kind: "ssh_host_key_verification_failed",
      scheme: "ssh",
      host: null,
    });
  });

  it("does not classify unrelated git errors", () => {
    expect(classifyGitRemoteAuthFailure("Branch is behind upstream.")).toBeNull();
    expect(
      classifyGitRemoteAuthFailure("fatal: bad object refs/remotes/origin/HEAD"),
    ).toBeNull();
  });
});

describe("gitRemoteAuthFailureFromError", () => {
  it("prefers the structured remoteAuth field when present", () => {
    const error = Object.assign(new Error("opaque message"), {
      _tag: "GitCommandError",
      remoteAuth: { kind: "https_credentials_unavailable", scheme: "https", host: "github.com" },
    });
    expect(gitRemoteAuthFailureFromError(error)).toEqual({
      kind: "https_credentials_unavailable",
      scheme: "https",
      host: "github.com",
    });
  });

  it("falls back to classifying the error message", () => {
    expect(
      gitRemoteAuthFailureFromError(
        new Error("fatal: could not read Username for 'https://github.com': Device not configured"),
      ),
    ).toEqual({
      kind: "https_credentials_unavailable",
      scheme: "https",
      host: "github.com",
    });
    expect(gitRemoteAuthFailureFromError(new Error("Branch is behind upstream."))).toBeNull();
  });
});

describe("formatGitErrorMessage", () => {
  it("describes remote auth failures in plain language", () => {
    const message =
      "Git command failed in GitVcsDriver.pushCurrentBranch.pushUpstream: git push origin HEAD:refs/heads/main (/repo) - fatal: could not read Username for 'https://github.com': Device not configured";

    expect(formatGitErrorMessage(new Error(message))).toBe(
      "Git needs credentials for github.com, but none are configured for non-interactive use. The repository is private or requires sign-in over HTTPS.",
    );
  });

  it("keeps unrelated git errors intact", () => {
    expect(formatGitErrorMessage(new Error("Branch is behind upstream."))).toBe(
      "Branch is behind upstream.",
    );
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(isTemporaryWorktreeBranch(buildTemporaryWorktreeBranchName())).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("keeps matching legacy t3code temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch("t3code/deadbeef")).toBe(true);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});
