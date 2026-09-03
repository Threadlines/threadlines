// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  buildBitbucketReviewThreads,
  decodeBitbucketCommentsJson,
  decodeBitbucketConflictsJson,
  decodeBitbucketDiffStatJson,
  decodeBitbucketPullRequestPageJson,
  decodeBitbucketRepositoryPermissionJson,
  decodeBitbucketStatusesJson,
} from "./bitbucketPullRequest.ts";

const pullRequest = (overrides: Record<string, unknown>) => ({
  id: 7,
  title: "Tidy the toolbox",
  state: "OPEN",
  source: { branch: { name: "feature/tidy" } },
  destination: { branch: { name: "main" } },
  created_on: "2026-08-30T10:00:00.123456+00:00",
  updated_on: "2026-08-31T10:00:00.123456+00:00",
  links: { html: { href: "https://bitbucket.org/acme/tools/pull-requests/7" } },
  ...overrides,
});

const success = <A>(result: Result.Result<A, unknown>): A => {
  assert.ok(Result.isSuccess(result), "expected the payload to decode");
  return result.success;
};

describe("decodeBitbucketPullRequestPageJson", () => {
  it("normalizes the times, reads the states, and skips a malformed row", () => {
    const page = success(
      decodeBitbucketPullRequestPageJson(
        JSON.stringify({
          values: [
            pullRequest({ id: 1 }),
            pullRequest({ id: 2, state: "DECLINED" }),
            pullRequest({ id: 3, state: "SUPERSEDED" }),
            pullRequest({ id: 4, state: "MERGED" }),
            { id: 5 },
          ],
          next: "https://api.bitbucket.org/2.0/next",
        }),
      ),
    );

    assert.deepStrictEqual(
      page.items.map((row) => [row.number, row.state]),
      [
        [1, "open"],
        [2, "closed"],
        [3, "closed"],
        [4, "merged"],
      ],
    );
    assert.equal(page.items[0]?.createdAt, "2026-08-30T10:00:00.123Z");
    assert.equal(page.next, "https://api.bitbucket.org/2.0/next");
  });

  it("keeps the reviewers under the uuid a write takes, and reads a vote as a verdict", () => {
    const page = success(
      decodeBitbucketPullRequestPageJson(
        JSON.stringify({
          values: [
            pullRequest({
              reviewers: [{ uuid: "{abc}", nickname: "hubot" }, { nickname: "nouuid" }],
              participants: [
                {
                  user: { nickname: "hubot" },
                  state: "changes_requested",
                  participated_on: "2026-08-31T09:00:00+00:00",
                },
                { user: { nickname: "monalisa" }, state: null, approved: false },
              ],
            }),
          ],
        }),
      ),
    );

    assert.deepStrictEqual(page.items[0]?.reviewers, [{ id: "{abc}", login: "hubot" }]);
    assert.deepStrictEqual(
      page.items[0]?.reviews.map((review) => [review.author?.login, review.reviewState]),
      [["hubot", "changes-requested"]],
    );
  });
});

describe("decodeBitbucketCommentsJson", () => {
  it("leaves a line comment out of the conversation and drops deleted and unsent ones", () => {
    const comments = success(
      decodeBitbucketCommentsJson(
        JSON.stringify({
          values: [
            {
              id: 1,
              content: { raw: "Looks good" },
              user: { nickname: "octocat" },
              created_on: "2026-08-31T10:00:00+00:00",
            },
            {
              id: 2,
              content: { raw: "On this line" },
              created_on: "2026-08-31T10:05:00+00:00",
              inline: { path: "a.ts", to: 12 },
            },
            {
              id: 3,
              content: { raw: "Gone" },
              created_on: "2026-08-31T10:10:00+00:00",
              deleted: true,
            },
            {
              id: 4,
              content: { raw: "Draft" },
              created_on: "2026-08-31T10:15:00+00:00",
              pending: true,
            },
          ],
        }),
        "octocat",
      ),
    );

    assert.deepStrictEqual(
      comments.comments.map((comment) => [comment.id, comment.viewerIsAuthor]),
      [["1", true]],
    );
    // Both the remark and the line comment stay unread, so a thread can be built.
    assert.deepStrictEqual(
      comments.entries.map((entry) => entry.id),
      [1, 2],
    );
  });
});

describe("buildBitbucketReviewThreads", () => {
  it("hangs a reply on the line comment it leads back to and reads the side from the line", () => {
    const threads = buildBitbucketReviewThreads(
      [
        {
          id: 1,
          content: { raw: "Removed line" },
          user: { nickname: "hubot" },
          created_on: "2026-08-31T10:00:00+00:00",
          inline: { path: "a.ts", from: 12, outdated: true },
          resolution: { type: "resolution" },
        },
        {
          id: 2,
          content: { raw: "Agreed" },
          user: { nickname: "octocat" },
          created_on: "2026-08-31T10:05:00+00:00",
          parent: { id: 1 },
        },
        {
          id: 3,
          content: { raw: "Added line" },
          created_on: "2026-08-31T10:10:00+00:00",
          inline: { path: "b.ts", to: 4 },
        },
        // A plain remark, which belongs in the conversation rather than a thread.
        { id: 4, content: { raw: "Nice" }, created_on: "2026-08-31T10:15:00+00:00" },
      ],
      "octocat",
    );

    assert.deepStrictEqual(
      threads.map((thread) => [
        thread.id,
        thread.path,
        thread.side,
        thread.line,
        thread.isResolved,
        thread.isOutdated,
        thread.comments.map((comment) => comment.id),
      ]),
      [
        ["1", "a.ts", "left", 12, true, true, ["1", "2"]],
        ["3", "b.ts", "right", 4, false, false, ["3"]],
      ],
    );
    assert.deepStrictEqual(
      threads[0]?.comments.map((comment) => comment.viewerIsAuthor),
      [false, true],
    );
  });
});

describe("decodeBitbucketStatusesJson", () => {
  it("reads the build states and keeps the later run of a repeated key", () => {
    const page = success(
      decodeBitbucketStatusesJson(
        JSON.stringify({
          values: [
            { key: "build", name: "Build", state: "FAILED" },
            { key: "build", name: "Build", state: "SUCCESSFUL" },
            { key: "lint", name: "Lint", state: "INPROGRESS" },
            { key: "docs", name: "Docs", state: "SOMETHING_NEW" },
          ],
        }),
      ),
    );

    assert.deepStrictEqual(
      page.items.map((check) => [check.name, check.status]),
      [
        ["Build", "success"],
        ["Lint", "pending"],
        ["Docs", "skipped"],
      ],
    );
  });
});

describe("decodeBitbucketDiffStatJson", () => {
  it("totals the lines and counts the files", () => {
    assert.deepStrictEqual(
      success(
        decodeBitbucketDiffStatJson(
          JSON.stringify({
            values: [{ lines_added: 4, lines_removed: 1 }, { lines_added: 2 }],
          }),
        ),
      ),
      { additions: 6, deletions: 1, changedFiles: 2, next: null },
    );
  });
});

describe("decodeBitbucketConflictsJson", () => {
  it("reads an empty page as the only statement Bitbucket makes that a merge is clean", () => {
    assert.equal(
      success(decodeBitbucketConflictsJson(JSON.stringify({ values: [] }))),
      "mergeable",
    );
    assert.equal(
      success(decodeBitbucketConflictsJson(JSON.stringify({ values: [{ path: "a.ts" }] }))),
      "conflicting",
    );
  });
});

describe("decodeBitbucketRepositoryPermissionJson", () => {
  it("grants a permission Bitbucket named none of, and refuses a read-only one", () => {
    assert.equal(success(decodeBitbucketRepositoryPermissionJson(JSON.stringify({}))), true);
    assert.equal(
      success(
        decodeBitbucketRepositoryPermissionJson(
          JSON.stringify({ values: [{ permission: "read" }] }),
        ),
      ),
      false,
    );
    assert.equal(
      success(
        decodeBitbucketRepositoryPermissionJson(
          JSON.stringify({ values: [{ permission: "write" }] }),
        ),
      ),
      true,
    );
  });
});
