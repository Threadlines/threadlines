// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { decodeGitHubPullRequestListJson } from "./gitHubPullRequestList.ts";

const baseRow = {
  number: 1,
  title: "Add the pull requests page",
  url: "https://github.com/octocat/example-app/pull/1",
  author: { login: "octocat", is_bot: false },
  headRefName: "feature/pull-requests",
  baseRefName: "main",
  state: "OPEN",
  mergedAt: null,
  isDraft: false,
  additions: 12,
  deletions: 3,
  createdAt: "2026-08-30T10:00:00Z",
  updatedAt: "2026-08-31T10:00:00Z",
  reviewDecision: "",
  reviewRequests: [],
  labels: [],
};

function decodeRows(rows: ReadonlyArray<unknown>) {
  const result = decodeGitHubPullRequestListJson(JSON.stringify(rows));
  assert.equal(Result.isSuccess(result), true);
  return Result.isSuccess(result) ? result.success : [];
}

describe("decodeGitHubPullRequestListJson", () => {
  it("resolves the pull request state from state and mergedAt", () => {
    const rows = decodeRows([
      { ...baseRow, number: 1, state: "OPEN", mergedAt: null },
      { ...baseRow, number: 2, state: "OPEN", mergedAt: "2026-08-31T09:00:00Z" },
      { ...baseRow, number: 3, state: "MERGED", mergedAt: null },
      { ...baseRow, number: 4, state: "CLOSED", mergedAt: null },
    ]);

    assert.deepStrictEqual(
      rows.map((row) => [row.number, row.state]),
      [
        [1, "open"],
        [2, "merged"],
        [3, "merged"],
        [4, "closed"],
      ],
    );
  });

  it("collapses the status check rollup into one word", () => {
    const rows = decodeRows([
      {
        ...baseRow,
        number: 1,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "FAILURE" },
          { status: "IN_PROGRESS", conclusion: null },
        ],
      },
      {
        ...baseRow,
        number: 2,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "IN_PROGRESS", conclusion: null },
        ],
      },
      {
        ...baseRow,
        number: 3,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "SKIPPED" },
          { state: "SUCCESS" },
        ],
      },
      { ...baseRow, number: 4, statusCheckRollup: [] },
      { ...baseRow, number: 5 },
    ]);

    assert.deepStrictEqual(
      rows.map((row) => [row.number, row.checksState]),
      [
        [1, "failure"],
        [2, "pending"],
        [3, "success"],
        [4, undefined],
        [5, undefined],
      ],
    );
  });

  it("skips a malformed row and keeps the rest", () => {
    const rows = decodeRows([
      { ...baseRow, number: 0 },
      { ...baseRow, number: 7, title: "   " },
      { ...baseRow, number: 8 },
    ]);

    assert.deepStrictEqual(
      rows.map((row) => row.number),
      [8],
    );
  });

  it("fails only when the payload itself cannot be read", () => {
    assert.equal(Result.isFailure(decodeGitHubPullRequestListJson("not json at all")), true);
  });
});
