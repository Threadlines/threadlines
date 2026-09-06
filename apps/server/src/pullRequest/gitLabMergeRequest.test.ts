// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodeGitLabAwardsJson,
  decodeGitLabCommitsJson,
  decodeGitLabDiffsJson,
  decodeGitLabDiscussionsJson,
  decodeGitLabMergeRequestListJson,
  decodeGitLabNotesJson,
  decodeGitLabProjectJson,
} from "./gitLabMergeRequest.ts";

const mergeRequest = (overrides: Record<string, unknown>) => ({
  iid: 7,
  title: "Tidy the toolbox",
  web_url: "https://gitlab.com/acme/tools/-/merge_requests/7",
  source_branch: "feature/tidy",
  target_branch: "main",
  state: "opened",
  created_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-31T10:00:00Z",
  ...overrides,
});

const success = <A>(result: Result.Result<A, unknown>): A => {
  assert.ok(Result.isSuccess(result), "expected the payload to decode");
  return result.success;
};

describe("decodeGitLabMergeRequestListJson", () => {
  it("reads the state, the draft flag and the pipeline, and skips a malformed row", () => {
    const rows = success(
      decodeGitLabMergeRequestListJson(
        JSON.stringify([
          mergeRequest({ iid: 1, state: "opened", draft: true }),
          mergeRequest({ iid: 2, state: "opened", merged_at: "2026-08-31T11:00:00Z" }),
          mergeRequest({ iid: 3, head_pipeline: { status: "failed" } }),
          mergeRequest({ iid: 4, head_pipeline: { status: "running" } }),
          { iid: 5 },
        ]),
      ),
    );

    assert.deepStrictEqual(
      rows.map((row) => [row.number, row.state, row.isDraft, row.checksState]),
      [
        [1, "open", true, undefined],
        [2, "merged", false, undefined],
        [3, "open", false, "failure"],
        [4, "open", false, "pending"],
      ],
    );
  });

  it("collects the reviewers a review is outstanding from", () => {
    const rows = success(
      decodeGitLabMergeRequestListJson(
        JSON.stringify([mergeRequest({ reviewers: [{ id: 9, username: "hubot" }, { id: 10 }] })]),
      ),
    );

    assert.deepStrictEqual(rows[0]?.reviewRequestedLogins, ["hubot"]);
  });
});

describe("decodeGitLabProjectJson", () => {
  it("offers a squash and a rebase for a semi-linear project the reader may merge on", () => {
    assert.deepStrictEqual(
      success(
        decodeGitLabProjectJson(
          JSON.stringify({
            default_branch: "main",
            merge_method: "rebase_merge",
            squash_option: "default_on",
            permissions: { project_access: { access_level: 30 }, group_access: null },
          }),
        ),
      ),
      { canWrite: true, mergeMethods: ["squash", "rebase"], defaultBranch: "main" },
    );
  });

  it("offers every method when the project names no strategy, and refuses a reporter the merge", () => {
    assert.deepStrictEqual(
      success(
        decodeGitLabProjectJson(
          JSON.stringify({
            default_branch: "trunk",
            permissions: { project_access: { access_level: 20 } },
          }),
        ),
      ),
      { canWrite: false, mergeMethods: ["merge", "squash", "rebase"], defaultBranch: "trunk" },
    );
  });
});

describe("decodeGitLabDiscussionsJson", () => {
  it("keeps the positioned discussions, sides them by the line they carry, and marks the reader's own", () => {
    const threads = success(
      decodeGitLabDiscussionsJson(
        JSON.stringify([
          {
            id: "d1",
            notes: [
              {
                id: 11,
                body: "Deleted line",
                created_at: "2026-08-31T10:00:00Z",
                author: { username: "octocat" },
                resolved: true,
                position: {
                  position_type: "text",
                  old_path: "a.ts",
                  new_path: "a.ts",
                  old_line: 12,
                  new_line: null,
                },
              },
              {
                id: 12,
                body: "Agreed",
                created_at: "2026-08-31T10:05:00Z",
                author: { username: "hubot" },
              },
            ],
          },
          {
            id: "d2",
            notes: [
              {
                id: 13,
                body: "Added line",
                created_at: "2026-08-31T10:10:00Z",
                author: { username: "hubot" },
                position: {
                  position_type: "text",
                  old_path: "b.ts",
                  new_path: "b.ts",
                  new_line: 4,
                },
              },
            ],
          },
          // A plain discussion, which the conversation already shows.
          { id: "d3", notes: [{ id: 14, body: "Nice", created_at: "2026-08-31T10:15:00Z" }] },
        ]),
        "octocat",
      ),
    );

    assert.deepStrictEqual(
      threads.map((thread) => [
        thread.id,
        thread.path,
        thread.side,
        thread.line,
        thread.isResolved,
      ]),
      [
        ["d1", "a.ts", "left", 12, true],
        ["d2", "b.ts", "right", 4, false],
      ],
    );
    assert.deepStrictEqual(
      threads[0]?.comments.map((comment) => [comment.id, comment.viewerIsAuthor]),
      [
        ["11", true],
        ["12", false],
      ],
    );
  });
});

describe("decodeGitLabNotesJson", () => {
  it("drops GitLab's own activity entries and the notes that opened a line discussion", () => {
    const comments = success(
      decodeGitLabNotesJson(
        JSON.stringify([
          { id: 1, body: "assigned to @hubot", created_at: "2026-08-31T10:00:00Z", system: true },
          { id: 2, body: "Looks good", created_at: "2026-08-31T10:05:00Z" },
          {
            id: 3,
            body: "On this line",
            created_at: "2026-08-31T10:10:00Z",
            type: "DiffNote",
          },
          { id: 4, body: "   ", created_at: "2026-08-31T10:15:00Z" },
        ]),
        null,
      ),
    );

    assert.deepStrictEqual(
      comments.map((comment) => [comment.id, comment.kind]),
      [["2", "issue-comment"]],
    );
  });
});

describe("decodeGitLabCommitsJson", () => {
  it("reads the commits oldest first, since GitLab lists them the other way", () => {
    const commits = success(
      decodeGitLabCommitsJson(
        JSON.stringify([
          { id: "b2", title: "Second", committed_date: "2026-08-31T10:00:00Z" },
          {
            id: "a1",
            title: "First",
            committed_date: "2026-08-30T10:00:00Z",
            author_name: "Octo Cat",
          },
        ]),
      ),
    );

    assert.deepStrictEqual(
      commits.map((commit) => [commit.oid, commit.authorLogin]),
      [
        ["a1", "Octo Cat"],
        ["b2", null],
      ],
    );
  });
});

describe("decodeGitLabDiffsJson", () => {
  it("assembles a unified patch and reports a file GitLab would not inline", () => {
    const page = success(
      decodeGitLabDiffsJson(
        JSON.stringify([
          {
            old_path: "a.ts",
            new_path: "a.ts",
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
          { old_path: "big.bin", new_path: "big.bin", too_large: true, diff: "" },
          {
            old_path: "was.ts",
            new_path: "now.ts",
            renamed_file: true,
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          },
        ]),
      ),
    );

    assert.equal(page.truncated, true);
    assert.equal(page.rawCount, 3);
    assert.equal(
      page.patch,
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
        "diff --git a/big.bin b/big.bin",
        "--- a/big.bin",
        "+++ b/big.bin",
        "diff --git a/was.ts b/now.ts",
        "rename from was.ts",
        "rename to now.ts",
        "--- a/was.ts",
        "+++ b/now.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
  });
});

describe("decodeGitLabAwardsJson", () => {
  it("groups the awards it knows, marks the reader's own, and keys the note ones by their id", () => {
    const awards = success(
      decodeGitLabAwardsJson(
        JSON.stringify({
          data: {
            project: {
              mergeRequest: {
                awardEmoji: {
                  nodes: [
                    { name: "thumbsup", user: { username: "octocat" } },
                    { name: "thumbsup", user: { username: "hubot" } },
                    { name: "pizza", user: { username: "hubot" } },
                  ],
                },
                notes: {
                  nodes: [
                    {
                      id: "gid://gitlab/DiffNote/42",
                      awardEmoji: { nodes: [{ name: "rocket", user: { username: "hubot" } }] },
                    },
                    { id: "gid://gitlab/Note/43", awardEmoji: { nodes: [] } },
                  ],
                },
              },
            },
          },
        }),
        "octocat",
      ),
    );

    assert.deepStrictEqual(awards.reactions, [
      { content: "thumbs-up", count: 2, viewerReacted: true },
    ]);
    assert.deepStrictEqual(awards.reactionsByNoteId.get("42"), [
      { content: "rocket", count: 1, viewerReacted: false },
    ]);
    assert.equal(awards.reactionsByNoteId.has("43"), false);
  });
});
