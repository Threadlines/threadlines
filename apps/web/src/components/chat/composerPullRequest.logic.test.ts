import type { PullRequestCheck, PullRequestDetail } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadPullRequest } from "../pull-requests/pullRequests.logic";
import {
  composerAutoFixOffered,
  composerAutoMergeControl,
  composerPullRequestCheckBuckets,
  composerPullRequestChip,
  composerPullRequestRow,
} from "./composerPullRequest.logic";

const THREAD_PULL_REQUEST: ThreadPullRequest = {
  number: 234,
  state: "open",
  isDraft: false,
  title: "fix(server): migration 050 no longer stalls startup",
  url: "https://github.com/Threadlines/threadlines/pull/234",
  repository: "Threadlines/threadlines",
  settledAt: null,
  autoMergeEnabled: false,
  headBranch: null,
  diffStat: null,
};

function check(status: PullRequestCheck["status"], name: string): PullRequestCheck {
  return { name, status, description: null, url: null } as PullRequestCheck;
}

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    provider: "github",
    projectId: "project-1",
    projectTitle: "threadlines",
    workspaceRoot: "/repo/project",
    repository: "Threadlines/threadlines",
    number: 234,
    title: "fix(server): migration 050 no longer stalls startup on large databases",
    body: "",
    url: "https://github.com/Threadlines/threadlines/pull/234",
    author: { login: "badcuban", isBot: false, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 26,
    deletions: 25,
    changedFiles: 2,
    headBranch: "fix/migration-050-backfill-speed",
    baseBranch: "main",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T01:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    viewerIsAuthor: true,
    reviewers: [],
    labels: [],
    checks: [],
    viewer: { canWrite: true, canReview: false, canManage: true },
    mergeMethods: ["squash"],
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "close", "enable-auto-merge", "disable-auto-merge"],
      mergeMethods: ["squash"],
      updateMethods: ["merge"],
      reactions: true,
      review: {
        inlineComment: true,
        reply: true,
        resolve: true,
        verdicts: ["approve", "comment"],
      },
      reviewers: { request: true, listCandidates: true },
      edit: { pullRequest: true, comment: true },
    },
    baseComparison: "up-to-date",
    behindBy: 0,
    autoMergeEnabled: false,
    isStacked: false,
    defaultBranch: "main",
    ...overrides,
  } as PullRequestDetail;
}

describe("composerPullRequestRow", () => {
  it("renders whole from the thread's own pull request before the detail arrives", () => {
    const row = composerPullRequestRow({
      pullRequest: {
        ...THREAD_PULL_REQUEST,
        headBranch: "fix/migration-050-backfill-speed",
        diffStat: { additions: 26, deletions: 25 },
      },
      projectTitle: "threadlines",
      detail: undefined,
    });

    expect(row.number).toBe(234);
    expect(row.state).toBe("open");
    expect(row.title).toBe(THREAD_PULL_REQUEST.title);
    // The listing and the project already know these, so the row does not
    // fill in a beat after it appears.
    expect(row.headBranch).toBe("fix/migration-050-backfill-speed");
    expect(row.projectTitle).toBe("threadlines");
    expect(row.diffStat).toEqual({ additions: 26, deletions: 25 });
    // Only the detail knows how the checks are going.
    expect(row.chip).toEqual({ label: "CI", tone: "unknown", interactive: true });
  });

  it("leaves blank what no source has said rather than guessing", () => {
    const row = composerPullRequestRow({
      pullRequest: THREAD_PULL_REQUEST,
      projectTitle: null,
      detail: undefined,
    });
    expect(row.headBranch).toBeNull();
    expect(row.projectTitle).toBeNull();
    expect(row.diffStat).toBeNull();
  });

  it("takes the branch, project, size and state from the detail once it lands", () => {
    const row = composerPullRequestRow({
      pullRequest: THREAD_PULL_REQUEST,
      projectTitle: null,
      // The listing behind the thread's resolution polls slowly, so a merge
      // shows up on the detail first and the row has to follow it.
      detail: detail({ state: "merged", checks: [check("success", "build")] }),
    });

    expect(row.state).toBe("merged");
    expect(row.headBranch).toBe("fix/migration-050-backfill-speed");
    expect(row.projectTitle).toBe("threadlines");
    expect(row.diffStat).toEqual({ additions: 26, deletions: 25 });
    expect(row.chip).toEqual({ label: "Merged", tone: "merged", interactive: false });
  });
});

describe("composerPullRequestChip", () => {
  it("reads the check rollup while the pull request is open", () => {
    expect(
      composerPullRequestChip({ state: "open", detail: detail({ checksState: "failure" }) }),
    ).toEqual({ label: "CI", tone: "failure", interactive: true });
  });

  it("leads with the merge queue, which moves without anyone asking", () => {
    expect(
      composerPullRequestChip({
        state: "open",
        detail: detail({ checksState: "success", mergeQueue: { position: 2 } }),
      }),
    ).toEqual({ label: "Queued", tone: "queued", interactive: true });
  });

  it("says so when the host reported no checks at all", () => {
    expect(composerPullRequestChip({ state: "open", detail: detail() })).toEqual({
      label: "No checks",
      tone: "none",
      interactive: true,
    });
  });

  it("states the outcome for a settled pull request and stops being a control", () => {
    expect(
      composerPullRequestChip({ state: "closed", detail: detail({ state: "closed" }) }),
    ).toEqual({ label: "Closed", tone: "closed", interactive: false });
  });
});

describe("composerPullRequestCheckBuckets", () => {
  it("counts each status once, worst first, and drops the empty buckets", () => {
    expect(
      composerPullRequestCheckBuckets([
        check("success", "lint"),
        check("failure", "test"),
        check("pending", "build"),
        check("success", "typecheck"),
        check("pending", "e2e"),
      ]),
    ).toEqual([
      { id: "pending", label: "In progress", count: 2 },
      { id: "failure", label: "Failed", count: 1 },
      { id: "success", label: "Passed", count: 2 },
    ]);
  });
});

describe("composerAutoMergeControl", () => {
  it("is hidden where the host does not say whether the pull request is armed", () => {
    expect(composerAutoMergeControl(detail({ autoMergeEnabled: null }))).toEqual({
      kind: "hidden",
    });
    expect(composerAutoMergeControl(undefined)).toEqual({ kind: "hidden" });
  });

  it("is hidden where the host offers neither action", () => {
    expect(
      composerAutoMergeControl(
        detail({
          capabilities: { ...detail().capabilities, actions: ["merge", "close"] },
        }),
      ),
    ).toEqual({ kind: "hidden" });
  });

  it("is a switch carrying the standing instruction where the host offers one of them", () => {
    expect(composerAutoMergeControl(detail())).toEqual({ kind: "toggle", checked: false });
    expect(composerAutoMergeControl(detail({ autoMergeEnabled: true }))).toEqual({
      kind: "toggle",
      checked: true,
    });
  });

  it("stops being a switch once the host has taken the pull request into its queue", () => {
    // GitHub drops the instruction on entry to the queue, so a switch would
    // read as off while the merge is in motion, and flipping it would re-arm
    // and disarm an entry that no longer needs it.
    expect(
      composerAutoMergeControl(detail({ autoMergeEnabled: false, mergeQueue: { position: 1 } })),
    ).toEqual({ kind: "queued" });
  });
});

describe("composerAutoFixOffered", () => {
  it("is offered on GitHub only, and not before the detail says which host it is", () => {
    expect(composerAutoFixOffered(detail())).toBe(true);
    expect(composerAutoFixOffered(detail({ provider: "gitlab" }))).toBe(false);
    expect(composerAutoFixOffered(undefined)).toBe(false);
  });
});
