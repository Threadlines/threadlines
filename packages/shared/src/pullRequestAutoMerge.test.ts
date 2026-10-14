import { describe, expect, it } from "vite-plus/test";

import {
  PULL_REQUEST_AUTO_MERGE_SETTLE_MS,
  resolvePullRequestAutoMergeStep,
  type PullRequestAutoMergeInput,
} from "./pullRequestAutoMerge.ts";

const UPDATED_AT = "2026-09-01T00:00:00.000Z";
const SETTLED = Date.parse(UPDATED_AT) + PULL_REQUEST_AUTO_MERGE_SETTLE_MS;

function input(
  // Loose so a case can clear a field the host may leave out, such as `mergeGate`.
  detail: Record<string, unknown> = {},
  rest: Partial<Omit<PullRequestAutoMergeInput, "detail">> = {},
): PullRequestAutoMergeInput {
  return {
    detail: {
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      mergeGate: "clear",
      checks: [{ name: "build", status: "success", description: null, url: null }],
      checksState: "success",
      updatedAt: UPDATED_AT,
      viewer: { canWrite: true, canReview: false, canManage: true },
      capabilities: {
        diff: true,
        comment: true,
        actions: ["merge"],
        mergeMethods: ["squash"],
        updateMethods: [],
        reactions: false,
        review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
        edit: { pullRequest: false, comment: false },
      },
      ...detail,
    } as PullRequestAutoMergeInput["detail"],
    autoFix: false,
    unpushedCommits: 0,
    pushedHead: null,
    now: SETTLED,
    ...rest,
  };
}

describe("resolvePullRequestAutoMergeStep", () => {
  it("merges a settled pull request whose checks passed and whose gate is clear", () => {
    expect(resolvePullRequestAutoMergeStep(input())).toEqual({ kind: "merge" });
  });

  it("holds off right after a push, when the host may not have listed every check yet", () => {
    expect(resolvePullRequestAutoMergeStep(input({}, { now: SETTLED - 1 }))).toEqual({
      kind: "wait",
      reason: "Waiting for checks",
    });
  });

  it.each([
    [{ checksState: "pending" as const }, "Waiting for checks"],
    [{ mergeGate: "blocked" as const }, "Waiting for required reviews"],
    [{ mergeGate: "behind" as const }, "Waiting for the branch to be updated"],
    [{ mergeGate: undefined }, "Waiting for GitHub to allow the merge"],
    [{ isDraft: true }, "Waiting for it to be marked ready"],
    [{ mergeability: "conflicting" as const }, "Waiting for the conflicts to be resolved"],
  ])("waits while something only needs time or a person: %o", (detail, reason) => {
    expect(resolvePullRequestAutoMergeStep(input(detail))).toEqual({ kind: "wait", reason });
  });

  it("waits for the thread's own commits to reach the host", () => {
    expect(resolvePullRequestAutoMergeStep(input({}, { unpushedCommits: 2 }))).toEqual({
      kind: "wait",
      reason: "Waiting for local commits to be pushed",
    });
  });

  it("waits for the host to see a push before it believes any check, passed or failed", () => {
    const pushed = { pushedHead: "new" };
    const wait = { kind: "wait", reason: "Waiting for GitHub to see the latest push" };
    // Green, but for the commit before the push: merging now would land without it.
    expect(resolvePullRequestAutoMergeStep(input({ headSha: "old" }, pushed))).toEqual(wait);
    // Red, but the push may be the fix: not a reason to give up.
    expect(
      resolvePullRequestAutoMergeStep(input({ headSha: "old", checksState: "failure" }, pushed)),
    ).toEqual(wait);
    expect(resolvePullRequestAutoMergeStep(input({ headSha: "new" }, pushed))).toEqual({
      kind: "merge",
    });
  });

  it("stops on a failed check, unless the thread is fixing failures itself", () => {
    const failed = input({ checksState: "failure" });
    expect(resolvePullRequestAutoMergeStep(failed)).toEqual({
      kind: "stop",
      reason: "A check failed",
    });
    expect(resolvePullRequestAutoMergeStep({ ...failed, autoFix: true })).toEqual({
      kind: "wait",
      reason: "Waiting for the failing checks to be fixed",
    });
  });

  it("stops where it could never merge", () => {
    expect(
      resolvePullRequestAutoMergeStep(
        input({ viewer: { canWrite: false, canReview: false, canManage: false } }),
      ),
    ).toEqual({ kind: "stop", reason: "Write access is needed to merge" });
    expect(resolvePullRequestAutoMergeStep(input({ state: "closed" }))).toEqual({
      kind: "stop",
      reason: "The pull request is closed",
    });
  });
});
