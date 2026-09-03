// @effect-diagnostics preferSchemaOverJson:off
import { assert, afterEach, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockExecute = vi.fn<GitLabCli.GitLabCliShape["execute"]>();

const layer = Layer.mock(GitLabCli.GitLabCli)({ execute: mockExecute });

const repository = { cwd: "/workspaces/tools", repository: "acme/platform/tools" };
const mergeRequestPath = "projects/acme%2Fplatform%2Ftools/merge_requests/7";

const calls = () => mockExecute.mock.calls.map(([input]) => input);

afterEach(() => {
  mockExecute.mockReset();
});

describe("GitLabPullRequestProvider.runAction", () => {
  const cases = [
    {
      name: "merges now rather than letting glab arm the pipeline wait",
      input: { action: "merge", mergeMethod: "squash" },
      args: [
        "mr",
        "merge",
        "7",
        "--repo",
        "acme/platform/tools",
        "--auto-merge=false",
        "--yes",
        "--squash",
      ],
    },
    {
      name: "arms auto-merge with the strategy stored alongside it",
      input: { action: "enable-auto-merge", mergeMethod: "rebase" },
      args: [
        "mr",
        "merge",
        "7",
        "--repo",
        "acme/platform/tools",
        "--auto-merge=true",
        "--yes",
        "--rebase",
      ],
    },
    {
      name: "brings a stale branch up to date by rebasing, the only way GitLab has",
      input: { action: "update-branch", updateMethod: "rebase" },
      args: ["mr", "rebase", "7", "--repo", "acme/platform/tools"],
    },
    {
      name: "turns a merge request back into a draft",
      input: { action: "draft" },
      args: ["mr", "update", "7", "--repo", "acme/platform/tools", "--draft"],
    },
  ] as const;

  for (const testCase of cases) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
        const provider = yield* GitLabPullRequestProvider.make();

        yield* provider.runAction({ ...repository, number: 7, ...testCase.input });

        assert.deepStrictEqual(calls()[0]?.args, testCase.args);
      }).pipe(Effect.provide(layer)),
    );
  }

  it.effect("disarms auto-merge through the API, which is the one direction glab lacks", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
      const provider = yield* GitLabPullRequestProvider.make();

      yield* provider.runAction({ ...repository, number: 7, action: "disable-auto-merge" });

      assert.deepStrictEqual(calls()[0]?.args, [
        "api",
        `${mergeRequestPath}/cancel_merge_when_pipeline_succeeds`,
        "--method",
        "POST",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitLabPullRequestProvider.submitReview", () => {
  it.effect("posts the line comments, then the summary, then the approval", () =>
    Effect.gen(function* () {
      mockExecute.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[1]?.includes("include_diverged_commits_count") === true
              ? JSON.stringify({
                  iid: 7,
                  title: "Tidy the toolbox",
                  web_url: "https://gitlab.com/acme/platform/tools/-/merge_requests/7",
                  source_branch: "feature/tidy",
                  target_branch: "main",
                  created_at: "2026-08-30T10:00:00Z",
                  updated_at: "2026-08-31T10:00:00Z",
                  diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
                })
              : "",
          ),
        ),
      );
      const provider = yield* GitLabPullRequestProvider.make();

      yield* provider.submitReview({
        ...repository,
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [
          { path: "a.ts", position: { kind: "added", newLine: 12 }, body: "New line" },
          {
            path: "now.ts",
            oldPath: "was.ts",
            position: { kind: "deleted", oldLine: 7 },
            body: "Old line",
          },
        ],
      });

      const written = calls().filter((call) => call.args[2] === "--method");
      assert.deepStrictEqual(
        written.map((call) => [call.args[1], call.args[3]]),
        [
          [`${mergeRequestPath}/discussions`, "POST"],
          [`${mergeRequestPath}/discussions`, "POST"],
          [`${mergeRequestPath}/notes`, "POST"],
          [`${mergeRequestPath}/approve`, "POST"],
        ],
      );
      assert.deepStrictEqual(JSON.parse(written[0]?.stdin ?? "{}"), {
        body: "New line",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          old_path: "a.ts",
          new_path: "a.ts",
          new_line: 12,
        },
      });
      assert.deepStrictEqual(JSON.parse(written[1]?.stdin ?? "{}"), {
        body: "Old line",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          old_path: "was.ts",
          new_path: "now.ts",
          old_line: 7,
        },
      });
      assert.deepStrictEqual(JSON.parse(written[2]?.stdin ?? "{}"), { body: "Looks right." });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the verdict in the note, GitLab having no refusal of its own", () =>
    Effect.gen(function* () {
      mockExecute.mockReturnValue(Effect.succeed(processOutput("")));
      const provider = yield* GitLabPullRequestProvider.make();

      yield* provider.submitReview({
        ...repository,
        number: 7,
        verdict: "request-changes",
        body: "Please split this.",
        comments: [],
      });

      assert.deepStrictEqual(calls()[0]?.args.slice(0, 4), [
        "api",
        `${mergeRequestPath}/notes`,
        "--method",
        "POST",
      ]);
      assert.deepStrictEqual(JSON.parse(calls()[0]?.stdin ?? "{}"), {
        body: "**Requested changes**\n\nPlease split this.",
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitLabPullRequestProvider.setReviewerRequest", () => {
  it.effect("writes the whole reviewer set back, since GitLab replaces rather than adds", () =>
    Effect.gen(function* () {
      mockExecute.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[2] === "--method"
              ? ""
              : JSON.stringify({
                  iid: 7,
                  title: "Tidy the toolbox",
                  web_url: "https://gitlab.com/acme/platform/tools/-/merge_requests/7",
                  source_branch: "feature/tidy",
                  target_branch: "main",
                  created_at: "2026-08-30T10:00:00Z",
                  updated_at: "2026-08-31T10:00:00Z",
                  reviewers: [
                    { id: 9, username: "hubot" },
                    { id: 10, username: "monalisa" },
                  ],
                }),
          ),
        ),
      );
      const provider = yield* GitLabPullRequestProvider.make();

      yield* provider.setReviewerRequest({
        ...repository,
        number: 7,
        reviewers: [{ id: "10", kind: "user" }],
        requested: false,
      });

      const write = calls().at(-1);
      assert.deepStrictEqual(write?.args, [
        "api",
        mergeRequestPath,
        "--method",
        "PUT",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      assert.deepStrictEqual(JSON.parse(write?.stdin ?? "{}"), { reviewer_ids: [9] });
    }).pipe(Effect.provide(layer)),
  );
});
