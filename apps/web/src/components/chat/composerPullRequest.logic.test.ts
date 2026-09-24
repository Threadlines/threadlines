import type {
  PullRequestCheck,
  PullRequestDetail,
  PullRequestMergeMethod,
} from "@threadlines/contracts";
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
      threadAutoMerge: false,
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
      threadAutoMerge: false,
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
      threadAutoMerge: false,
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
      composerPullRequestChip({
        state: "open",
        detail: detail({ checksState: "failure" }),
        armed: false,
      }),
    ).toEqual({ label: "CI", tone: "failure", interactive: true });
  });

  it("leads with the merge queue, which moves without anyone asking", () => {
    expect(
      composerPullRequestChip({
        state: "open",
        detail: detail({ checksState: "success", mergeQueue: { position: 2 } }),
        armed: true,
      }),
    ).toEqual({ label: "Queued", tone: "queued", interactive: true });
  });

  it("says the merge queue gave it back, until something is set to queue it again", () => {
    const givenBack = detail({
      checksState: "success",
      mergeQueue: {
        position: null,
        removal: {
          id: "RFMQE_1",
          removedAt: "2026-09-22T23:16:04Z",
          failedChecks: [check("failure", "Browser Test")],
        },
      },
    });
    // Its own checks are green, which is exactly why the chip must not say only that.
    expect(composerPullRequestChip({ state: "open", detail: givenBack, armed: false })).toEqual({
      label: "Queue failed",
      tone: "failure",
      interactive: true,
    });
    expect(composerPullRequestChip({ state: "open", detail: givenBack, armed: true })).toEqual({
      label: "CI",
      tone: "success",
      interactive: true,
    });
  });

  it("says so when the host reported no checks at all", () => {
    expect(composerPullRequestChip({ state: "open", detail: detail(), armed: false })).toEqual({
      label: "No checks",
      tone: "none",
      interactive: true,
    });
  });

  it("states the outcome for a settled pull request and stops being a control", () => {
    expect(
      composerPullRequestChip({
        state: "closed",
        detail: detail({ state: "closed" }),
        armed: false,
      }),
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

/** An hour after the fixture's last update, so nothing reads as a fresh push. */
const NOW = Date.parse("2026-09-01T02:00:00.000Z");

function control(
  value: PullRequestDetail | undefined,
  thread: {
    readonly threadAutoMerge?: PullRequestMergeMethod | null;
    readonly autoFix?: boolean;
    readonly agentWorking?: boolean;
    readonly unpushedCommits?: number;
  } = {},
) {
  return composerAutoMergeControl({
    detail: value,
    threadAutoMerge: thread.threadAutoMerge ?? null,
    autoFix: thread.autoFix ?? false,
    agentWorking: thread.agentWorking ?? false,
    unpushedCommits: thread.unpushedCommits ?? 0,
    now: NOW,
  });
}

describe("composerAutoMergeControl", () => {
  it("is hidden where the host does not say whether the pull request is armed", () => {
    expect(control(detail({ provider: "gitlab", autoMergeEnabled: null }))).toEqual({
      kind: "hidden",
    });
    expect(control(undefined)).toEqual({ kind: "hidden" });
  });

  it("explains when a host other than GitHub does not offer auto-merge", () => {
    expect(
      control(
        detail({
          provider: "gitlab",
          capabilities: { ...detail().capabilities, actions: ["merge", "close"] },
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "Auto-merge is not available for this repository" });
  });

  it("is a switch carrying the standing instruction where the host offers the next action", () => {
    expect(control(detail())).toEqual({ kind: "toggle", checked: false });
    expect(control(detail({ autoMergeEnabled: true }))).toEqual({
      kind: "toggle",
      checked: true,
    });
  });

  it("does not mistake permission to cancel for permission to enable auto-merge", () => {
    const capabilities = { ...detail().capabilities, actions: ["disable-auto-merge"] as const };
    expect(control(detail({ capabilities }))).toEqual({
      kind: "unavailable",
      reason: "Auto-merge is not available for this repository",
    });
    expect(control(detail({ capabilities, autoMergeEnabled: true }))).toEqual({
      kind: "toggle",
      checked: true,
    });
  });

  it("hands a ready GitHub PR to the server to merge at once, but still lets it join a queue", () => {
    const passed = [check("success", "build")];
    // GitHub's own switch would merge on the spot instead of arming.
    expect(control(detail({ mergeGate: "clear", checks: passed }))).toEqual({
      kind: "server",
      checked: false,
      status: "Nothing left to wait for, so it merges right away",
    });
    expect(control(detail({ mergeGate: "clear", mergeQueue: { position: null } }))).toEqual({
      kind: "toggle",
      checked: false,
    });
    expect(control(detail({ mergeGate: "blocked" }))).toEqual({
      kind: "toggle",
      checked: false,
    });
  });

  it("does not promise a merge the server would hold back for the thread", () => {
    const ready = detail({ mergeGate: "clear", checks: [check("success", "build")] });
    // The agent may be about to push, so the server waits for its turn to end.
    expect(control(ready, { agentWorking: true })).toEqual({
      kind: "server",
      checked: false,
      status: null,
    });
    expect(control(ready, { agentWorking: true, threadAutoMerge: "squash" })).toEqual({
      kind: "server",
      checked: true,
      status: "Waiting for the agent to finish",
    });
    expect(control(ready, { unpushedCommits: 1, threadAutoMerge: "squash" })).toEqual({
      kind: "server",
      checked: true,
      status: "Waiting for local commits to be pushed",
    });
  });

  it("falls back to the server where GitHub cannot hold the merge itself", () => {
    const running = [check("pending", "build")];
    // Auto-merge switched off on the repository.
    const noAutoMerge = { ...detail().capabilities, actions: ["merge", "close"] as const };
    expect(control(detail({ capabilities: noAutoMerge, checks: running }))).toEqual({
      kind: "server",
      checked: false,
      status: null,
    });
    // No required checks: GitHub would merge at once, so it cannot be asked to wait.
    expect(control(detail({ mergeGate: "clear", checks: running }))).toEqual({
      kind: "server",
      checked: false,
      status: null,
    });
  });

  it("hands the server anything but a failing check nobody is fixing", () => {
    const noAutoMerge = { ...detail().capabilities, actions: ["merge", "close"] as const };
    // No checks at all is nothing to wait for, once GitHub says it would merge.
    expect(control(detail({ capabilities: noAutoMerge, mergeGate: "clear" }))).toEqual({
      kind: "server",
      checked: false,
      status: "Nothing left to wait for, so it merges right away",
    });
    const failed = detail({ capabilities: noAutoMerge, checks: [check("failure", "build")] });
    expect(control(failed)).toEqual({
      kind: "unavailable",
      reason: "A check failed. Turn on fixing below to wait for a fix.",
    });
    // With fixing on, a failure is something the server waits out.
    expect(control(failed, { autoFix: true })).toEqual({
      kind: "server",
      checked: false,
      status: null,
    });
  });

  it("keeps a thread's own request in view, saying what it waits on", () => {
    const running = detail({ mergeGate: "clear", checks: [check("pending", "build")] });
    expect(control(running, { threadAutoMerge: "squash" })).toEqual({
      kind: "server",
      checked: true,
      status: "Waiting for checks",
    });
    // Even where the viewer has since lost the right to merge, so it can be taken back.
    expect(
      control(detail({ viewer: { canWrite: false, canManage: true, canReview: false } }), {
        threadAutoMerge: "squash",
      }),
    ).toEqual({ kind: "server", checked: true, status: "Write access is needed to merge" });
  });

  it.each([
    [{ isDraft: true }, "Mark as ready first"],
    [{ mergeability: "conflicting" }, "Resolve the conflicts first"],
    [
      { viewer: { canWrite: false, canManage: true, canReview: false } },
      "Write access is needed to merge",
    ],
  ] as const)("explains why arming is unavailable: %s", (overrides, reason) => {
    expect(control(detail(overrides))).toEqual({ kind: "unavailable", reason });
  });

  it("still lets an armed draft or conflicting PR cancel auto-merge", () => {
    expect(control(detail({ autoMergeEnabled: true, isDraft: true }))).toEqual({
      kind: "toggle",
      checked: true,
    });
    expect(control(detail({ autoMergeEnabled: true, mergeability: "conflicting" }))).toEqual({
      kind: "toggle",
      checked: true,
    });
  });

  it.each(["merged", "closed"] as const)("offers no merge action for a %s PR", (state) => {
    expect(control(detail({ state }))).toEqual({ kind: "hidden" });
    expect(control(detail({ state }), { threadAutoMerge: "merge" })).toEqual({ kind: "hidden" });
  });

  it("stops being a switch once the host has taken the pull request into its queue", () => {
    // GitHub drops the instruction on entry to the queue, so a switch would
    // read as off while the merge is in motion, and flipping it would re-arm
    // and disarm an entry that no longer needs it.
    expect(control(detail({ autoMergeEnabled: false, mergeQueue: { position: 1 } }))).toEqual({
      kind: "queued",
    });
  });
});

describe("composerAutoFixOffered", () => {
  it("is offered on GitHub only, and not before the detail says which host it is", () => {
    expect(composerAutoFixOffered(detail())).toBe(true);
    expect(composerAutoFixOffered(detail({ provider: "gitlab" }))).toBe(false);
    expect(composerAutoFixOffered(undefined)).toBe(false);
  });
});
