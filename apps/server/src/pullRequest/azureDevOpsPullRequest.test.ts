// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  decodeAzureDevOpsThreadsJson,
} from "./azureDevOpsPullRequest.ts";

const REST_URL =
  "https://dev.azure.com/acme/_apis/git/repositories/11111111-2222-3333-4444-555555555555/pullRequests/7";

const pullRequest = (overrides: Record<string, unknown>) => ({
  pullRequestId: 7,
  title: "Tidy the toolbox",
  status: "active",
  sourceRefName: "refs/heads/feature/tidy",
  targetRefName: "refs/heads/main",
  creationDate: "2026-08-30T10:00:00Z",
  url: REST_URL,
  repository: { name: "tools", project: { name: "Platform" } },
  ...overrides,
});

const success = <A>(result: Result.Result<A, unknown>): A => {
  assert.ok(Result.isSuccess(result), "expected the payload to decode");
  return result.success;
};

describe("decodeAzureDevOpsPullRequestListJson", () => {
  it("strips the ref prefix, reads the status, and builds the browser url from the org", () => {
    const rows = success(
      decodeAzureDevOpsPullRequestListJson(
        JSON.stringify([
          pullRequest({ pullRequestId: 1 }),
          pullRequest({
            pullRequestId: 2,
            status: "completed",
            closedDate: "2026-08-31T10:00:00Z",
          }),
          pullRequest({ pullRequestId: 3, status: "abandoned" }),
          // Too little to place, so it is skipped rather than carried unusable.
          { pullRequestId: 4, title: "No branches", creationDate: "2026-08-30T10:00:00Z" },
        ]),
      ),
    );

    assert.deepStrictEqual(
      rows.map((row) => [row.number, row.state, row.headBranch, row.baseBranch, row.updatedAt]),
      [
        [1, "open", "feature/tidy", "main", "2026-08-30T10:00:00Z"],
        [2, "merged", "feature/tidy", "main", "2026-08-31T10:00:00Z"],
        [3, "closed", "feature/tidy", "main", "2026-08-30T10:00:00Z"],
      ],
    );
    assert.equal(rows[0]?.url, "https://dev.azure.com/acme/Platform/_git/tools/pullrequest/1");
  });

  it("prefers the web link Azure sends over one it would have to assemble", () => {
    const rows = success(
      decodeAzureDevOpsPullRequestListJson(
        JSON.stringify([
          pullRequest({ _links: { web: { href: "https://dev.azure.com/acme/_git/tools/pr/7" } } }),
        ]),
      ),
    );

    assert.equal(rows[0]?.url, "https://dev.azure.com/acme/_git/tools/pr/7");
  });
});

describe("decodeAzureDevOpsPullRequestJson", () => {
  it("reads a reviewer's vote as a verdict and auto-complete from who armed it", () => {
    const row = success(
      decodeAzureDevOpsPullRequestJson(
        JSON.stringify(
          pullRequest({
            mergeStatus: "conflicts",
            autoCompleteSetBy: { displayName: "Octo Cat" },
            reviewers: [
              { id: "guid-1", uniqueName: "hubot@acme.test", vote: 10 },
              { id: "guid-2", uniqueName: "monalisa@acme.test", vote: -10 },
              { id: "guid-3", uniqueName: "waiting@acme.test", vote: 0 },
            ],
          }),
        ),
      ),
    );

    assert.equal(row?.mergeability, "conflicting");
    assert.equal(row?.autoMergeEnabled, true);
    assert.deepStrictEqual(
      row?.reviewers.map((reviewer) => [reviewer.id, reviewer.login, reviewer.state]),
      [
        ["guid-1", "hubot@acme.test", "approved"],
        ["guid-2", "monalisa@acme.test", "changes-requested"],
        ["guid-3", "waiting@acme.test", "pending"],
      ],
    );
    // Only the reviewers still owing a verdict count as a request.
    assert.deepStrictEqual(row?.reviewRequestedLogins, ["waiting@acme.test"]);
  });

  it("names the thread collection from the organization the REST url carries", () => {
    const row = success(decodeAzureDevOpsPullRequestJson(JSON.stringify(pullRequest({}))));

    assert.equal(
      row?.threadsUrl,
      "https://dev.azure.com/acme/Platform/_apis/git/repositories/tools/pullRequests/7/threads",
    );
  });
});

describe("decodeAzureDevOpsThreadsJson", () => {
  it("drops Azure's own notes and the deleted ones, and reads oldest first", () => {
    const comments = success(
      decodeAzureDevOpsThreadsJson(
        JSON.stringify({
          value: [
            {
              id: 1,
              comments: [
                {
                  id: 1,
                  content: "Second",
                  publishedDate: "2026-08-31T10:05:00Z",
                  author: { uniqueName: "octocat@acme.test" },
                },
                {
                  id: 2,
                  content: "voted",
                  publishedDate: "2026-08-31T10:06:00Z",
                  commentType: "system",
                },
              ],
            },
            {
              id: 2,
              threadContext: { filePath: "/a.ts" },
              comments: [
                { id: 1, content: "First", publishedDate: "2026-08-31T10:00:00Z" },
                { id: 2, content: "Gone", publishedDate: "2026-08-31T10:01:00Z", isDeleted: true },
              ],
            },
            { id: 3, isDeleted: true, comments: [{ id: 1, content: "Hidden" }] },
          ],
        }),
        "octocat@acme.test",
      ),
    );

    assert.deepStrictEqual(
      comments.map((comment) => [comment.id, comment.body, comment.viewerIsAuthor]),
      [
        ["2:1", "First", false],
        ["1:1", "Second", true],
      ],
    );
  });
});
