// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodeGitHubAuthoredPullRequestsJson,
  decodeGitHubBaseComparisonJson,
  decodeGitHubPullRequestConversationJson,
  decodeGitHubReviewerCandidatesJson,
  decodeGitHubSubjectScopeJson,
} from "./gitHubPullRequestGraphql.ts";

function decoded<A>(result: Result.Result<A, unknown>, subject: string): A {
  if (!Result.isSuccess(result)) {
    return assert.fail(`expected the ${subject} payload to decode`);
  }
  return result.success;
}

const reactionGroup = (content: string, count: number, viewerHasReacted = false) => ({
  content,
  viewerHasReacted,
  users: { totalCount: count },
});

describe("decodeGitHubPullRequestConversationJson", () => {
  it("pins a live thread to its line, lists an outdated one without one, and counts reactions", () => {
    const conversation = decoded(
      decodeGitHubPullRequestConversationJson(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reactionGroups: [reactionGroup("ROCKET", 2, true), reactionGroup("HEART", 0)],
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_live",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/app.ts",
                      line: 42,
                      diffSide: "RIGHT",
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_1",
                            author: { login: "hubot" },
                            body: "This reads twice.",
                            createdAt: "2026-08-30T10:00:00Z",
                            url: "https://github.com/octocat/example-app/pull/12#discussion_r1",
                            viewerDidAuthor: false,
                            reactionGroups: [reactionGroup("THUMBS_UP", 1, true)],
                          },
                        ],
                      },
                    },
                    {
                      id: "PRRT_outdated",
                      isResolved: true,
                      isOutdated: true,
                      path: "src/old.ts",
                      line: null,
                      diffSide: "LEFT",
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_2",
                            author: null,
                            body: "Gone now.",
                            createdAt: "2026-08-29T10:00:00Z",
                            url: null,
                            viewerDidAuthor: true,
                            reactionGroups: [],
                          },
                        ],
                      },
                    },
                    // A thread with nothing said in it is not a card to render.
                    {
                      id: "PRRT_empty",
                      path: "src/empty.ts",
                      line: 1,
                      comments: { nodes: [] },
                    },
                  ],
                },
                comments: {
                  nodes: [
                    {
                      id: "IC_1",
                      viewerDidAuthor: true,
                      reactionGroups: [reactionGroup("EYES", 3)],
                    },
                  ],
                },
                reviews: { nodes: [{ id: "PRR_1", viewerDidAuthor: false, reactionGroups: [] }] },
              },
            },
          },
        }),
      ),
      "conversation",
    );

    assert.deepStrictEqual(conversation.reactions, [
      { content: "rocket", count: 2, viewerReacted: true },
    ]);
    assert.deepStrictEqual(
      conversation.reviewThreads.map((thread) => [
        thread.id,
        thread.line,
        thread.side,
        thread.isOutdated,
      ]),
      [
        ["PRRT_live", 42, "right", false],
        ["PRRT_outdated", null, "left", true],
      ],
    );
    assert.deepStrictEqual(conversation.reviewThreads[0]?.comments[0]?.reactions, [
      { content: "thumbs-up", count: 1, viewerReacted: true },
    ]);
    assert.equal(conversation.reviewThreads[1]?.comments[0]?.viewerIsAuthor, true);
    assert.deepStrictEqual(conversation.annotationsByCommentId.get("IC_1"), {
      reactions: [{ content: "eyes", count: 3, viewerReacted: false }],
      viewerIsAuthor: true,
    });
    assert.deepStrictEqual(conversation.annotationsByCommentId.get("PRR_1"), {
      reactions: [],
      viewerIsAuthor: false,
    });
  });
});

describe("decodeGitHubBaseComparisonJson", () => {
  it("counts the commits the base is ahead by", () => {
    assert.equal(
      decoded(
        decodeGitHubBaseComparisonJson(
          JSON.stringify({
            data: { repository: { pullRequest: { baseRef: { compare: { behindBy: 7 } } } } },
          }),
        ),
        "base comparison",
      ),
      7,
    );
  });

  it("reads a comparison the host would not make as unknown", () => {
    assert.equal(
      decoded(
        decodeGitHubBaseComparisonJson(
          JSON.stringify({ data: { repository: { pullRequest: { baseRef: null } } } }),
        ),
        "base comparison",
      ),
      null,
    );
  });
});

describe("decodeGitHubReviewerCandidatesJson", () => {
  it("marks whoever has been asked, keeps teams, and drops the author", () => {
    const list = decoded(
      decodeGitHubReviewerCandidatesJson(
        JSON.stringify({
          data: {
            repository: {
              assignableUsers: {
                nodes: [
                  { login: "octocat", name: "Mona" },
                  { login: "hubot", name: "Hubot" },
                  { login: "monalisa", name: null },
                ],
              },
              pullRequest: {
                author: { login: "octocat" },
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { login: "hubot", name: "Hubot" } },
                    { requestedReviewer: { slug: "core", name: "Core team" } },
                  ],
                },
              },
            },
          },
        }),
      ),
      "reviewer candidates",
    );

    assert.deepStrictEqual(
      list.candidates.map((candidate) => [
        candidate.id,
        candidate.kind,
        candidate.name,
        candidate.requested,
      ]),
      [
        ["hubot", "user", "Hubot", true],
        ["core", "team", "Core team", true],
        ["monalisa", "user", null, false],
      ],
    );
  });
});

describe("decodeGitHubSubjectScopeJson", () => {
  it("accepts a subject on this pull request and refuses one from elsewhere", () => {
    const scope = (nodePullRequestId: string) =>
      decoded(
        decodeGitHubSubjectScopeJson(
          JSON.stringify({
            data: {
              repository: { pullRequest: { id: "PR_here" } },
              node: { id: "IC_1", pullRequest: { id: nodePullRequestId } },
            },
          }),
        ),
        "subject scope",
      );

    assert.equal(scope("PR_here"), true);
    assert.equal(scope("PR_elsewhere"), false);
  });

  it("refuses a subject the host could not find at all", () => {
    assert.equal(
      decoded(
        decodeGitHubSubjectScopeJson(
          JSON.stringify({
            data: { repository: { pullRequest: { id: "PR_here" } }, node: null },
          }),
        ),
        "subject scope",
      ),
      false,
    );
  });
});

describe("decodeGitHubAuthoredPullRequestsJson", () => {
  const node = (overrides: Record<string, unknown>) => ({
    number: 12,
    title: "Teach the runner to wait",
    url: "https://github.com/openai/codex/pull/12",
    isDraft: false,
    state: "OPEN",
    mergedAt: null,
    createdAt: "2026-08-30T10:00:00Z",
    updatedAt: "2026-08-31T10:00:00Z",
    headRefName: "fix/waiting",
    baseRefName: "main",
    additions: 8,
    deletions: 2,
    reviewDecision: "CHANGES_REQUESTED",
    author: { login: "octocat" },
    repository: { nameWithOwner: "openai/codex" },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    ...overrides,
  });

  it("reads a search node as a list row that names its own repository", () => {
    const rows = decoded(
      decodeGitHubAuthoredPullRequestsJson(
        JSON.stringify({ data: { search: { nodes: [node({})] } } }),
      ),
      "authored search",
    );

    assert.deepStrictEqual(rows, [
      {
        number: 12,
        title: "Teach the runner to wait",
        url: "https://github.com/openai/codex/pull/12",
        author: { login: "octocat", isBot: false },
        headBranch: "fix/waiting",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        additions: 8,
        deletions: 2,
        createdAt: "2026-08-30T10:00:00Z",
        updatedAt: "2026-08-31T10:00:00Z",
        reviewRequestedLogins: ["hubot"],
        reviewDecision: "changes-requested",
        checksState: "failure",
        labels: [{ name: "bug", color: "d73a4a" }],
        repository: "openai/codex",
      },
    ]);
  });

  it("collapses the rollup the search reports into the word a row shows", () => {
    const checksState = (state: string | null) =>
      decoded(
        decodeGitHubAuthoredPullRequestsJson(
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  node({
                    commits: {
                      nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }],
                    },
                  }),
                ],
              },
            },
          }),
        ),
        "authored search",
      )[0]?.checksState;

    assert.equal(checksState("SUCCESS"), "success");
    assert.equal(checksState("ERROR"), "failure");
    assert.equal(checksState("EXPECTED"), "pending");
    // A pull request with no checks at all says nothing about them.
    assert.equal(checksState(null), undefined);
  });

  it("drops a search hit that is not a pull request", () => {
    const rows = decoded(
      decodeGitHubAuthoredPullRequestsJson(
        // `type: ISSUE` answers with issues too, which match no field the
        // fragment asks for and arrive as empty nodes.
        JSON.stringify({ data: { search: { nodes: [{}, node({})] } } }),
      ),
      "authored search",
    );

    assert.deepStrictEqual(
      rows.map((row) => row.number),
      [12],
    );
  });
});
