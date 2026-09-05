// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodeGitHubPullRequestActivityJson,
  decodeGitHubPullRequestDetailJson,
  decodeGitHubRepositoryJson,
} from "./gitHubPullRequestDetail.ts";

const baseDetail = {
  number: 12,
  title: "Add the pull request detail panel",
  url: "https://github.com/octocat/example-app/pull/12",
  author: { login: "octocat", is_bot: false },
  headRefName: "feature/pull-request-detail",
  baseRefName: "main",
  state: "OPEN",
  mergedAt: null,
  closedAt: null,
  isDraft: false,
  additions: 40,
  deletions: 4,
  changedFiles: 3,
  createdAt: "2026-08-30T10:00:00Z",
  updatedAt: "2026-08-31T10:00:00Z",
  body: "Reads one pull request.",
  mergeable: "MERGEABLE",
  reviewDecision: "",
  reviewRequests: [],
  reviews: [],
  labels: [],
  statusCheckRollup: [],
};

function decodeDetail(row: Record<string, unknown>) {
  const result = decodeGitHubPullRequestDetailJson(JSON.stringify({ ...baseDetail, ...row }));
  if (!Result.isSuccess(result)) {
    return assert.fail("expected the detail payload to decode");
  }
  return result.success;
}

function decodeRepository(payload: Record<string, unknown>) {
  const result = decodeGitHubRepositoryJson(JSON.stringify(payload));
  if (!Result.isSuccess(result)) {
    return assert.fail("expected the repository payload to decode");
  }
  return result.success;
}

function decodeActivity(payload: Record<string, unknown>) {
  const result = decodeGitHubPullRequestActivityJson(JSON.stringify(payload));
  if (!Result.isSuccess(result)) {
    return assert.fail("expected the activity payload to decode");
  }
  return result.success;
}

describe("decodeGitHubPullRequestDetailJson", () => {
  it("reads the host's merge gate the way gh does, and says nothing while it is undecided", () => {
    assert.strictEqual(decodeDetail({ mergeStateStatus: "BLOCKED" }).mergeGate, "blocked");
    assert.strictEqual(decodeDetail({ mergeStateStatus: "BEHIND" }).mergeGate, "behind");
    assert.strictEqual(decodeDetail({ mergeStateStatus: "UNSTABLE" }).mergeGate, "clear");
    assert.strictEqual(decodeDetail({ mergeStateStatus: "UNKNOWN" }).mergeGate, undefined);
    assert.strictEqual(decodeDetail({}).mergeGate, undefined);
  });

  it("lists a re-requested reviewer as pending, keeps a verdict over a later comment, and never the author", () => {
    const detail = decodeDetail({
      author: { login: "octocat", is_bot: false },
      reviewRequests: [
        { __typename: "User", login: "hubot" },
        { __typename: "Team", name: "core", slug: "core" },
      ],
      reviews: [
        {
          author: { login: "hubot" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-08-30T11:00:00Z",
        },
        { author: { login: "monalisa" }, state: "COMMENTED", submittedAt: "2026-08-30T12:00:00Z" },
        { author: { login: "monalisa" }, state: "APPROVED", submittedAt: "2026-08-30T13:00:00Z" },
        { author: { login: "octocat" }, state: "COMMENTED", submittedAt: "2026-08-30T14:00:00Z" },
        { author: { login: "monalisa" }, state: "COMMENTED", submittedAt: "2026-08-30T15:00:00Z" },
      ],
    });

    assert.deepStrictEqual(detail.reviewers, [
      { id: "hubot", kind: "user", login: "hubot", state: "pending", avatarUrl: null },
      { id: "monalisa", kind: "user", login: "monalisa", state: "approved", avatarUrl: null },
    ]);
  });

  it("keeps the last run of a repeated check and reports a skipped one as skipped", () => {
    const detail = decodeDetail({
      statusCheckRollup: [
        { name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1" },
        { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/2" },
        { name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
        { context: "legacy/status", state: "PENDING", targetUrl: "https://ci/legacy" },
      ],
    });

    assert.deepStrictEqual(
      detail.checks.map((check) => [check.name, check.status, check.url]),
      [
        ["build", "success", "https://ci/2"],
        ["lint", "skipped", null],
        ["legacy/status", "pending", "https://ci/legacy"],
      ],
    );
  });

  it("reads mergeability and the settled timestamps", () => {
    const detail = decodeDetail({
      state: "MERGED",
      mergeable: "CONFLICTING",
      mergedAt: "2026-08-31T12:00:00Z",
      closedAt: "2026-08-31T12:00:00Z",
    });

    assert.equal(detail.state, "merged");
    assert.equal(detail.mergeability, "conflicting");
    assert.equal(detail.mergedAt, "2026-08-31T12:00:00Z");
    assert.equal(detail.closedAt, "2026-08-31T12:00:00Z");
  });
});

describe("decodeGitHubPullRequestActivityJson", () => {
  it("keeps a bodiless approval, drops a bodiless comment review, and orders by time", () => {
    const activity = decodeActivity({
      comments: [
        {
          id: "IC_2",
          author: { login: "hubot" },
          body: "Second",
          createdAt: "2026-08-30T12:00:00Z",
          url: "https://github.com/octocat/example-app/pull/12#issuecomment-2",
        },
      ],
      reviews: [
        {
          id: "PRR_1",
          author: { login: "monalisa" },
          body: "",
          state: "APPROVED",
          submittedAt: "2026-08-30T13:00:00Z",
        },
        {
          id: "PRR_2",
          author: { login: "monalisa" },
          body: "",
          state: "COMMENTED",
          submittedAt: "2026-08-30T11:00:00Z",
        },
        {
          id: "PRR_3",
          author: { login: "hubot" },
          body: "Looks off",
          state: "COMMENTED",
          submittedAt: "2026-08-30T10:00:00Z",
        },
      ],
      commits: [
        {
          oid: "abc123",
          messageHeadline: "Add the panel",
          committedDate: "2026-08-30T09:00:00Z",
          authors: [{ login: "octocat" }],
        },
      ],
    });

    assert.deepStrictEqual(
      activity.comments.map((comment) => [comment.id, comment.kind, comment.reviewState]),
      [
        ["PRR_3", "review", "commented"],
        ["IC_2", "issue-comment", null],
        ["PRR_1", "review", "approved"],
      ],
    );
    assert.deepStrictEqual(activity.commits, [
      {
        oid: "abc123",
        messageHeadline: "Add the panel",
        committedDate: "2026-08-30T09:00:00Z",
        authorLogin: "octocat",
      },
    ]);
  });
});

describe("decodeGitHubRepositoryJson", () => {
  it("reads push access, the default branch, and only the merge methods the repository allows", () => {
    assert.deepStrictEqual(
      decodeRepository({
        name: "example-app",
        permissions: { admin: false, push: true, pull: true },
        allow_merge_commit: false,
        allow_squash_merge: true,
        allow_rebase_merge: true,
        allow_auto_merge: false,
        default_branch: "main",
      }),
      {
        canWrite: true,
        mergeMethods: ["squash", "rebase"],
        defaultBranch: "main",
        autoMergeAllowed: false,
      },
    );
  });

  it("reads a repository with no permissions as read-only and an older host as allowing every method", () => {
    assert.deepStrictEqual(decodeRepository({ name: "example-app" }), {
      canWrite: false,
      mergeMethods: ["merge", "squash", "rebase"],
      defaultBranch: null,
    });
  });
});
