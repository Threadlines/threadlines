import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  VcsCommitGraphInput,
  VcsCommitGraphResult,
  VcsCommitDetailsInput,
  VcsCommitDetailsResult,
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsMergeRefResult,
} from "./git.ts";

const decodeCommitGraphInput = Schema.decodeUnknownSync(VcsCommitGraphInput);
const decodeCommitGraphResult = Schema.decodeUnknownSync(VcsCommitGraphResult);
const decodeCommitDetailsInput = Schema.decodeUnknownSync(VcsCommitDetailsInput);
const decodeCommitDetailsResult = Schema.decodeUnknownSync(VcsCommitDetailsResult);
const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeMergeRefResult = Schema.decodeUnknownSync(VcsMergeRefResult);

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });
});

describe("VcsCommitGraph", () => {
  it("accepts a bounded commit graph request and result", () => {
    const input = decodeCommitGraphInput({
      cwd: "/repo",
      limit: 24,
    });
    const result = decodeCommitGraphResult({
      commits: [
        {
          sha: "89abcdef0123456789abcdef0123456789abcdef",
          shortSha: "89abcde",
          parents: ["0123456789abcdef0123456789abcdef01234567"],
          refs: ["source-control-panel", "origin/source-control-panel"],
          subject: "Add source control panel",
          authorName: "Threadlines",
          committedAt: "2026-05-25T12:00:00.000Z",
        },
      ],
      truncated: false,
    });

    expect(input.limit).toBe(24);
    expect(result.commits[0]?.shortSha).toBe("89abcde");
  });
});

describe("VcsCommitDetails", () => {
  it("accepts a commit details request and full message result", () => {
    const input = decodeCommitDetailsInput({
      cwd: "/repo",
      sha: "89abcdef0123456789abcdef0123456789abcdef",
    });
    const result = decodeCommitDetailsResult({
      sha: "89abcdef0123456789abcdef0123456789abcdef",
      shortSha: "89abcde",
      subject: "Add source control panel",
      body: "Show full commit bodies in pinned graph details.",
      message: "Add source control panel\n\nShow full commit bodies in pinned graph details.",
      commitUrl:
        "https://github.com/threadlines/threadlines/commit/89abcdef0123456789abcdef0123456789abcdef",
    });

    expect(input.sha).toBe("89abcdef0123456789abcdef0123456789abcdef");
    expect(result.message).toContain(result.body);
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("VcsMergeRefResult", () => {
  it("accepts merge results with a follow-up push outcome", () => {
    const parsed = decodeMergeRefResult({
      refName: "main",
      push: {
        status: "pushed",
        branch: "main",
        upstreamBranch: "origin/main",
        setUpstream: false,
      },
    });

    expect(parsed.push?.upstreamBranch).toBe("origin/main");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/Threadlines/threadlines/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});
