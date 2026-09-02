// @effect-diagnostics preferSchemaOverJson:off
import { assert, afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ProjectId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
} from "@threadlines/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PullRequestService from "./PullRequestService.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const authStatusOutput = (login: string) =>
  processOutput(
    JSON.stringify({
      hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login }] },
    }),
  );

const project = (input: {
  readonly id: string;
  readonly title: string;
  readonly provider: string;
  readonly repository: string;
}): OrchestrationProjectShell => {
  const [owner = "", name = ""] = input.repository.split("/");
  return {
    id: ProjectId.make(input.id),
    kind: "workspace",
    title: input.title,
    workspaceRoot: `/workspaces/${name}`,
    repositoryIdentity: {
      canonicalKey: `${input.provider}:${input.repository}`,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://example.com/${input.repository}.git`,
      },
      provider: input.provider,
      owner,
      name,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
};

const pullRequestRow = (input: {
  readonly number: number;
  readonly author: string;
  readonly reviewRequests?: ReadonlyArray<Record<string, unknown>>;
}) => ({
  number: input.number,
  title: `Pull request ${input.number}`,
  url: `https://github.com/octocat/example-app/pull/${input.number}`,
  author: { login: input.author, is_bot: false },
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
  reviewRequests: input.reviewRequests ?? [],
  labels: [],
});

const mockExecute = vi.fn<GitHubCli.GitHubCliShape["execute"]>();
const mockGetShellSnapshot = vi.fn<() => Effect.Effect<OrchestrationShellSnapshot, never, never>>();

const layer = PullRequestService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(GitHubCli.GitHubCli)({ execute: mockExecute }),
      Layer.mock(ProjectionSnapshotQuery)({ getShellSnapshot: mockGetShellSnapshot }),
    ),
  ),
);

const withProjects = (projects: ReadonlyArray<OrchestrationProjectShell>) => {
  mockGetShellSnapshot.mockReturnValue(
    Effect.succeed({
      snapshotSequence: 0,
      projects,
      threads: [],
      updatedAt: "2026-08-01T00:00:00.000Z",
    }),
  );
};

const repositoryArg = (args: ReadonlyArray<string>) => {
  const index = args.indexOf("--repo");
  return index < 0 ? null : (args[index + 1] ?? null);
};

const prListCalls = () =>
  mockExecute.mock.calls.filter(([input]) => input.args[0] === "pr").map(([input]) => input);

afterEach(() => {
  mockExecute.mockReset();
  mockGetShellSnapshot.mockReset();
});

describe("PullRequestService.list", () => {
  it.effect("lists GitHub projects and silently skips the others", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-app",
          title: "Example App",
          provider: "github",
          repository: "octocat/example-app",
        }),
        project({
          id: "project-tools",
          title: "Tools",
          provider: "gitlab",
          repository: "octocat/tools",
        }),
      ]);
      mockExecute.mockImplementation((input) =>
        input.args[0] === "auth"
          ? Effect.succeed(authStatusOutput("octocat"))
          : Effect.succeed(
              processOutput(JSON.stringify([pullRequestRow({ number: 1, author: "hubot" })])),
            ),
      );

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => [entry.projectId, entry.repository, entry.number]),
        [["project-app", "octocat/example-app", 1]],
      );
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        prListCalls().map((input) => repositoryArg(input.args)),
        ["octocat/example-app"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a repository once when several projects point at it", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-checkout",
          title: "Example App",
          provider: "github",
          repository: "octocat/example-app",
        }),
        project({
          id: "project-worktree",
          title: "Example App worktree",
          provider: "github",
          repository: "Octocat/Example-App",
        }),
      ]);
      mockExecute.mockImplementation((input) =>
        input.args[0] === "auth"
          ? Effect.succeed(authStatusOutput("octocat"))
          : Effect.succeed(
              processOutput(JSON.stringify([pullRequestRow({ number: 7, author: "hubot" })])),
            ),
      );

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => [entry.projectId, entry.number]),
        [["project-checkout", 7]],
      );
      assert.deepStrictEqual(
        prListCalls().map((input) => repositoryArg(input.args)),
        ["octocat/example-app"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks the viewer's own pull requests and pending review requests", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-app",
          title: "Example App",
          provider: "github",
          repository: "octocat/example-app",
        }),
      ]);
      mockExecute.mockImplementation((input) =>
        input.args[0] === "auth"
          ? Effect.succeed(authStatusOutput("octocat"))
          : Effect.succeed(
              processOutput(
                JSON.stringify([
                  pullRequestRow({ number: 1, author: "OctoCat" }),
                  pullRequestRow({
                    number: 2,
                    author: "hubot",
                    reviewRequests: [{ __typename: "User", login: "octocat" }],
                  }),
                  pullRequestRow({
                    number: 3,
                    author: "hubot",
                    reviewRequests: [{ __typename: "Team", name: "core", slug: "core" }],
                  }),
                ]),
              ),
            ),
      );

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.equal(result.viewer, "octocat");
      assert.deepStrictEqual(
        result.entries.map((entry) => [
          entry.number,
          entry.viewerIsAuthor,
          entry.viewerReviewRequested,
        ]),
        [
          [1, true, false],
          [2, false, true],
          [3, false, false],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports one failing project and still returns the others", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-app",
          title: "Example App",
          provider: "github",
          repository: "octocat/example-app",
        }),
        project({
          id: "project-site",
          title: "Marketing Site",
          provider: "github",
          repository: "octocat/site",
        }),
      ]);
      mockExecute.mockImplementation((input) => {
        if (input.args[0] === "auth") {
          return Effect.succeed(authStatusOutput("octocat"));
        }
        return repositoryArg(input.args) === "octocat/site"
          ? Effect.fail(
              new GitHubCli.GitHubCliError({
                operation: "execute",
                detail: "You are not logged into any GitHub hosts. Run gh auth login.",
              }),
            )
          : Effect.succeed(
              processOutput(JSON.stringify([pullRequestRow({ number: 1, author: "hubot" })])),
            );
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => entry.number),
        [1],
      );
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]?.projectId, "project-site");
      assert.equal(result.errors[0]?.repository, "octocat/site");
      assert.equal(result.errors[0]?.reason, "unauthenticated");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("serves a repeated listing from the cache until force asks for a fresh read", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-app",
          title: "Example App",
          provider: "github",
          repository: "octocat/example-app",
        }),
      ]);
      mockExecute.mockImplementation((input) =>
        input.args[0] === "auth"
          ? Effect.succeed(authStatusOutput("octocat"))
          : Effect.succeed(
              processOutput(JSON.stringify([pullRequestRow({ number: 1, author: "hubot" })])),
            ),
      );

      const service = yield* PullRequestService.PullRequestService;
      yield* service.list({ state: "open" });
      yield* service.list({ state: "open" });
      expect(prListCalls()).toHaveLength(1);

      yield* service.list({ state: "open", force: true });
      expect(prListCalls()).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
});
