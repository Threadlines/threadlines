// @effect-diagnostics preferSchemaOverJson:off
import { assert, afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockExecute = vi.fn<GitHubCli.GitHubCliShape["execute"]>();

const layer = Layer.mergeAll(
  Layer.mock(GitHubCli.GitHubCli)({ execute: mockExecute }),
  NodeServices.layer,
);

const repository = { cwd: "/workspaces/example-app", repository: "octocat/example-app" };

const calls = () => mockExecute.mock.calls.map(([input]) => input);

afterEach(() => {
  mockExecute.mockReset();
});

describe("GitHubPullRequestProvider.runAction", () => {
  const cases = [
    {
      name: "rebases a branch onto its base",
      input: { action: "update-branch", updateMethod: "rebase" },
      args: ["pr", "update-branch", "12", "--repo", "octocat/example-app", "--rebase"],
    },
    {
      name: "arms auto-merge with the strategy the host stores alongside it",
      input: { action: "enable-auto-merge", mergeMethod: "squash" },
      args: ["pr", "merge", "12", "--repo", "octocat/example-app", "--auto", "--squash"],
    },
    {
      name: "disarms auto-merge",
      input: { action: "disable-auto-merge" },
      args: ["pr", "merge", "12", "--repo", "octocat/example-app", "--disable-auto"],
    },
    {
      name: "deletes the head branch after a merge when asked",
      input: { action: "merge", mergeMethod: "merge", deleteBranch: true },
      args: ["pr", "merge", "12", "--repo", "octocat/example-app", "--merge", "--delete-branch"],
    },
  ] as const;

  for (const testCase of cases) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
        const provider = yield* GitHubPullRequestProvider.make();

        yield* provider.runAction({ ...repository, number: 12, ...testCase.input });

        assert.deepStrictEqual(calls()[0]?.args, testCase.args);
      }).pipe(Effect.provide(layer)),
    );
  }
});

describe("GitHubPullRequestProvider.submitReview", () => {
  it.effect("sends every line comment on the side its position names", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
      const provider = yield* GitHubPullRequestProvider.make();

      yield* provider.submitReview({
        ...repository,
        number: 12,
        verdict: "request-changes",
        body: "Two notes.",
        comments: [
          { path: "a.ts", position: { kind: "added", newLine: 12 }, body: "New line" },
          { path: "b.ts", position: { kind: "deleted", oldLine: 7 }, body: "Old line" },
          {
            path: "c.ts",
            position: { kind: "context", oldLine: 3, newLine: 4, side: "left" },
            body: "Context on the left",
          },
          {
            path: "d.ts",
            position: { kind: "context", oldLine: 5, newLine: 6, side: "right" },
            body: "Context on the right",
          },
        ],
      });

      const call = calls()[0];
      assert.deepStrictEqual(call?.args, [
        "api",
        "--method",
        "POST",
        "repos/octocat/example-app/pulls/12/reviews",
        "--input",
        "-",
      ]);
      assert.deepStrictEqual(JSON.parse(call?.stdin ?? "{}"), {
        event: "REQUEST_CHANGES",
        body: "Two notes.",
        comments: [
          { path: "a.ts", line: 12, side: "RIGHT", body: "New line" },
          { path: "b.ts", line: 7, side: "LEFT", body: "Old line" },
          { path: "c.ts", line: 3, side: "LEFT", body: "Context on the left" },
          { path: "d.ts", line: 6, side: "RIGHT", body: "Context on the right" },
        ],
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitHubPullRequestProvider.setReaction", () => {
  it.effect("refuses a subject that belongs to another pull request without mutating", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              data: {
                repository: { pullRequest: { id: "PR_here" } },
                node: { id: "IC_1", pullRequest: { id: "PR_elsewhere" } },
              },
            }),
          ),
        ),
      );
      const provider = yield* GitHubPullRequestProvider.make();

      const error = yield* provider
        .setReaction({
          ...repository,
          number: 12,
          subjectId: "IC_1",
          content: "thumbs-up",
          reacted: true,
        })
        .pipe(Effect.flip);

      assert.equal(error.detail, "That comment does not belong to this pull request.");
      // Only the scope read ran; the mutation never reached the host.
      expect(calls()).toHaveLength(1);
      assert.equal(calls()[0]?.stdin?.includes("addReaction"), false);
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitHubPullRequestProvider.setReviewerRequest", () => {
  it.effect("splits people from teams and takes a request back with DELETE", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
      const provider = yield* GitHubPullRequestProvider.make();

      yield* provider.setReviewerRequest({
        ...repository,
        number: 12,
        reviewers: [
          { id: "hubot", kind: "user" },
          { id: "core", kind: "team" },
          { id: "monalisa", kind: "user" },
        ],
        requested: false,
      });

      const call = calls()[0];
      assert.deepStrictEqual(call?.args, [
        "api",
        "--method",
        "DELETE",
        "repos/octocat/example-app/pulls/12/requested_reviewers",
        "--input",
        "-",
      ]);
      assert.deepStrictEqual(JSON.parse(call?.stdin ?? "{}"), {
        reviewers: ["hubot", "monalisa"],
        team_reviewers: ["core"],
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitHubPullRequestProvider.listChangeRequests", () => {
  const listRow = (input: {
    readonly number: number;
    readonly author: Record<string, unknown>;
  }) => ({
    number: input.number,
    title: `Pull request ${input.number}`,
    url: `https://github.example.com/octocat/example-app/pull/${input.number}`,
    author: input.author,
    headRefName: `feature/${input.number}`,
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
    additions: 1,
    deletions: 0,
    createdAt: "2026-08-30T10:00:00Z",
    updatedAt: "2026-08-31T10:00:00Z",
    reviewDecision: "",
    reviewRequests: [],
    labels: [],
  });

  it.effect("derives a plain login's picture and looks up the rest in one request", () =>
    Effect.gen(function* () {
      mockExecute.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "api"
              ? JSON.stringify({
                  data: {
                    nodes: [{ login: "dependabot[bot]", avatarUrl: "https://avatars.example/bot" }],
                  },
                })
              : JSON.stringify([
                  listRow({ number: 1, author: { login: "octocat", is_bot: false, id: "U_1" } }),
                  listRow({
                    number: 2,
                    author: { login: "dependabot[bot]", is_bot: true, id: "BOT_1" },
                  }),
                ]),
          ),
        ),
      );
      const provider = yield* GitHubPullRequestProvider.make();

      const rows = yield* provider.listChangeRequests({
        ...repository,
        state: "open",
        limit: 30,
      });

      assert.deepStrictEqual(
        rows.map((row) => [row.number, row.author?.avatarUrl]),
        [
          // Derived from the login on the row's own host, so Enterprise works.
          [1, "https://github.example.com/octocat.png?size=80"],
          [2, "https://avatars.example/bot"],
        ],
      );
      // One listing, then one lookup naming only the account it had to ask about.
      const lookup = calls()[1];
      assert.deepStrictEqual(lookup?.args, ["api", "graphql", "--input", "-"]);
      assert.deepStrictEqual(
        (JSON.parse(lookup?.stdin ?? "{}") as { variables: Record<string, unknown> }).variables,
        { ids: ["BOT_1"] },
      );
      expect(calls()).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks the host nothing extra when every login speaks for itself", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              listRow({ number: 1, author: { login: "octocat", is_bot: false, id: "U_1" } }),
            ]),
          ),
        ),
      );
      const provider = yield* GitHubPullRequestProvider.make();

      const rows = yield* provider.listChangeRequests({ ...repository, state: "open", limit: 30 });

      assert.equal(rows[0]?.author?.avatarUrl, "https://github.example.com/octocat.png?size=80");
      expect(calls()).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitHubPullRequestProvider.listAuthoredChangeRequests", () => {
  it.effect("searches the whole host for the viewer's own work, on stdin", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(
        Effect.succeed(processOutput(JSON.stringify({ data: { search: { nodes: [] } } }))),
      );
      const provider = yield* GitHubPullRequestProvider.make();
      const search = provider.listAuthoredChangeRequests;
      if (search === undefined) {
        return assert.fail("GitHub can search for the viewer's own pull requests");
      }

      yield* search({ cwd: repository.cwd, viewer: "octocat", state: "closed", limit: 30 });

      const call = calls()[0];
      assert.deepStrictEqual(call?.args, ["api", "graphql", "--input", "-"]);
      const body = JSON.parse(call?.stdin ?? "{}") as {
        query: string;
        variables: Record<string, unknown>;
      };
      // GitHub counts a merged pull request as closed as well, so the closed
      // slice has to ask for the unmerged half of that.
      assert.deepStrictEqual(body.variables, {
        q: "is:pr author:octocat is:closed is:unmerged",
        first: 30,
      });
      assert.equal(body.query.includes("search(query: $q, type: ISSUE, first: $first)"), true);
    }).pipe(Effect.provide(layer)),
  );
});
