// @effect-diagnostics preferSchemaOverJson:off
import { readFileSync } from "node:fs";
import { assert, afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ProjectId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
} from "@threadlines/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GITHUB_PULL_REQUEST_CAPABILITIES } from "./GitHubPullRequestProvider.ts";
import {
  fromProviders,
  PullRequestProviderRegistry,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import * as PullRequestProviderRegistryLayer from "./PullRequestProviderRegistry.ts";
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
  // The identity resolver records the whole path below the host as
  // `displayName`, its first segment as `owner` and its last as `name`.
  const segments = input.repository.split("/").filter((segment) => segment.length > 0);
  const owner = segments[0] ?? "";
  const name = segments.at(-1) ?? "";
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
      displayName: input.repository,
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
  readonly mergeable?: string;
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
  mergeable: input.mergeable ?? "UNKNOWN",
  reviewDecision: "",
  reviewRequests: input.reviewRequests ?? [],
  labels: [],
});

const mockExecute = vi.fn<GitHubCli.GitHubCliShape["execute"]>();
const mockGitLabExecute = vi.fn<GitLabCli.GitLabCliShape["execute"]>();
const mockGetShellSnapshot = vi.fn<() => Effect.Effect<OrchestrationShellSnapshot, never, never>>();

const projectionsLayer = Layer.mock(ProjectionSnapshotQuery)({
  getShellSnapshot: mockGetShellSnapshot,
});

/** Every host the registry builds, so the service can pick between them. */
const hostClientsLayer = Layer.mergeAll(
  Layer.mock(GitHubCli.GitHubCli)({ execute: mockExecute }),
  Layer.mock(GitLabCli.GitLabCli)({ execute: mockGitLabExecute }),
  Layer.mock(BitbucketApi.BitbucketApi)({}),
  Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
);

const layer = PullRequestService.layer.pipe(
  Layer.provide(Layer.mergeAll(PullRequestProviderRegistryLayer.layer, projectionsLayer)),
  Layer.provide(hostClientsLayer),
  Layer.provide(NodeServices.layer),
);

/**
 * A host that answers nothing. Every method fails the test if the service ever
 * reaches it, so a capability refusal is proved by the call never happening.
 */
const unreachable = (operation: string) => () =>
  Effect.sync(() => assert.fail(`the service reached ${operation} on a host that cannot do it`));

const stubProvider = (
  capabilities: PullRequestProviderApi["capabilities"],
): PullRequestProviderApi => ({
  kind: "github",
  capabilities,
  getViewer: () => Effect.succeed("octocat"),
  listChangeRequests: () => Effect.succeed([]),
  getChangeRequest: unreachable("getChangeRequest"),
  getChangeRequestActivity: unreachable("getChangeRequestActivity"),
  getDiff: unreachable("getDiff"),
  runAction: unreachable("runAction"),
  comment: unreachable("comment"),
  submitReview: unreachable("submitReview"),
  replyToThread: unreachable("replyToThread"),
  setThreadResolution: unreachable("setThreadResolution"),
  setReaction: unreachable("setReaction"),
  updateChangeRequest: unreachable("updateChangeRequest"),
  updateComment: unreachable("updateComment"),
  listReviewerCandidates: unreachable("listReviewerCandidates"),
  setReviewerRequest: unreachable("setReviewerRequest"),
  getRepositoryAccess: unreachable("getRepositoryAccess"),
});

/** The service over a host with the capabilities a test wants to take away. */
const layerWithCapabilities = (capabilities: PullRequestProviderApi["capabilities"]) =>
  PullRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders([stubProvider(capabilities)])),
        projectionsLayer,
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

const prCalls = (subcommand: string) =>
  mockExecute.mock.calls
    .filter(([input]) => input.args[0] === "pr" && input.args[1] === subcommand)
    .map(([input]) => input);

const prListCalls = () => prCalls("list");

const jsonFieldsArg = (args: ReadonlyArray<string>) => {
  const index = args.indexOf("--json");
  return index < 0 ? "" : (args[index + 1] ?? "");
};

const bodyFileContents = (args: ReadonlyArray<string>) => {
  const index = args.indexOf("--body-file");
  const path = index < 0 ? undefined : args[index + 1];
  return path === undefined ? null : readFileSync(path, "utf8");
};

/** The one project every per-pull-request read runs against. */
const onlyGitHubProject = () =>
  withProjects([
    project({
      id: "project-app",
      title: "Example App",
      provider: "github",
      repository: "octocat/example-app",
    }),
  ]);

const repositoryJson = (input?: {
  readonly push?: boolean;
  readonly merge?: boolean;
  readonly squash?: boolean;
  readonly rebase?: boolean;
}) =>
  JSON.stringify({
    name: "example-app",
    permissions: { admin: false, push: input?.push ?? true, pull: true },
    allow_merge_commit: input?.merge ?? true,
    allow_squash_merge: input?.squash ?? true,
    allow_rebase_merge: input?.rebase ?? true,
  });

const detailJson = (input?: { readonly author?: string; readonly isDraft?: boolean }) =>
  JSON.stringify({
    ...pullRequestRow({ number: 12, author: input?.author ?? "hubot" }),
    isDraft: input?.isDraft ?? false,
    body: "Reads one pull request.",
    changedFiles: 3,
    mergeable: "MERGEABLE",
    closedAt: null,
    reviews: [],
    statusCheckRollup: [],
  });

/** One node of the account-wide search, in the shape its document asks for. */
const authoredSearchNode = (input: {
  readonly number: number;
  readonly repository: string;
  readonly author?: string;
}) => ({
  ...pullRequestRow({ number: input.number, author: input.author ?? "octocat" }),
  author: { login: input.author ?? "octocat" },
  repository: { nameWithOwner: input.repository },
  labels: { nodes: [] },
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
});

const authoredSearchJson = (nodes: ReadonlyArray<Record<string, unknown>> = []) =>
  JSON.stringify({ data: { search: { nodes } } });

/**
 * The GraphQL reads the listing, detail and activity paths make, answered by
 * what the document asks for. Everything travels on stdin, so the document is
 * there.
 */
const graphqlJson = (stdin: string | undefined) => {
  const document = stdin ?? "";
  if (document.includes("search(query:")) {
    return authoredSearchJson();
  }
  if (document.includes("behindBy")) {
    return JSON.stringify({
      data: { repository: { pullRequest: { baseRef: { compare: { behindBy: 0 } } } } },
    });
  }
  if (document.includes("reviewThreads")) {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reactionGroups: [],
            reviewThreads: { nodes: [] },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      },
    });
  }
  return JSON.stringify({ data: { repository: null } });
};

/** Answers every read the detail path makes; `onWrite` sees everything else. */
const hostAnswers = (handlers?: {
  readonly repository?: string;
  readonly detail?: () => string;
  readonly onWrite?: (args: ReadonlyArray<string>) => string;
}) => {
  mockExecute.mockImplementation((input) => {
    if (input.args[0] === "auth") {
      return Effect.succeed(authStatusOutput("octocat"));
    }
    if (input.args[0] === "api" && input.args[1] === "graphql") {
      return Effect.succeed(processOutput(graphqlJson(input.stdin)));
    }
    if (input.args[0] === "api") {
      return Effect.succeed(processOutput(handlers?.repository ?? repositoryJson()));
    }
    if (input.args[1] === "list") {
      return Effect.succeed(
        processOutput(JSON.stringify([pullRequestRow({ number: 12, author: "hubot" })])),
      );
    }
    if (input.args[1] === "view") {
      return Effect.succeed(
        processOutput(
          jsonFieldsArg(input.args).startsWith("comments")
            ? JSON.stringify({ comments: [], reviews: [], commits: [] })
            : (handlers?.detail ?? detailJson)(),
        ),
      );
    }
    return Effect.succeed(processOutput(handlers?.onWrite?.(input.args) ?? ""));
  });
};

/**
 * The two reads every listing makes on its own: who is signed in, and the
 * account-wide search for the viewer's own pull requests. A test that cares
 * about either answers it itself.
 */
const listAnswers = (handlers: {
  readonly list: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCli.GitHubCliError>;
  readonly authored?: () => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCli.GitHubCliError>;
  /** The repository read the listing makes for the viewer's own rights. */
  readonly repository?: () => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCli.GitHubCliError>;
}) => {
  mockExecute.mockImplementation((input) => {
    if (input.args[0] === "auth") {
      return Effect.succeed(authStatusOutput("octocat"));
    }
    if (input.args[0] === "api" && input.args[1] === "graphql") {
      return handlers.authored === undefined
        ? Effect.succeed(processOutput(authoredSearchJson()))
        : handlers.authored();
    }
    if (input.args[0] === "api" && handlers.repository !== undefined) {
      return handlers.repository();
    }
    return handlers.list(input.args);
  });
};

/** The `gh api repos/...` reads a listing made, in the order it made them. */
const repositoryReadCalls = () =>
  mockExecute.mock.calls
    .map(([input]) => input.args)
    .filter((args) => args[0] === "api" && args[1] !== "graphql");

/** The one row a listing test that is not about the rows themselves answers with. */
const oneOpenRow = () =>
  Effect.succeed(processOutput(JSON.stringify([pullRequestRow({ number: 1, author: "hubot" })])));

const pullRequestReference = {
  projectId: ProjectId.make("project-app"),
  repository: "octocat/example-app",
  number: 12,
};

afterEach(() => {
  mockExecute.mockReset();
  mockGitLabExecute.mockReset();
  mockGetShellSnapshot.mockReset();
});

describe("PullRequestService.list", () => {
  it.effect("lists the projects a host answers for and silently skips the others", () =>
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
          provider: "unknown",
          repository: "octocat/tools",
        }),
      ]);
      listAnswers({ list: oneOpenRow });

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

  it.effect("reads a GitLab project through the GitLab provider", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-tools",
          title: "Tools",
          provider: "gitlab",
          repository: "acme/platform/tools",
        }),
      ]);
      mockGitLabExecute.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[1] === "user"
              ? JSON.stringify({ username: "octocat" })
              : JSON.stringify([
                  {
                    iid: 7,
                    title: "Tidy the toolbox",
                    web_url: "https://gitlab.com/acme/platform/tools/-/merge_requests/7",
                    author: { id: 3, username: "octocat" },
                    source_branch: "feature/tidy",
                    target_branch: "main",
                    state: "opened",
                    created_at: "2026-08-30T10:00:00Z",
                    updated_at: "2026-08-31T10:00:00Z",
                    reviewers: [{ id: 9, username: "hubot" }],
                  },
                ]),
          ),
        ),
      );

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => [
          entry.provider,
          entry.repository,
          entry.number,
          entry.viewerIsAuthor,
        ]),
        [["gitlab", "acme/platform/tools", 7, true]],
      );
      assert.deepStrictEqual(result.errors, []);
      // The nested group path travels whole, encoded as one path segment.
      assert.deepStrictEqual(
        mockGitLabExecute.mock.calls
          .map(([input]) => input.args)
          .filter((args) => args[1] !== "user"),
        [
          [
            "api",
            "projects/acme%2Fplatform%2Ftools/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50",
          ],
        ],
      );
      // `gh` is never reached for a project on another host.
      assert.deepStrictEqual(mockExecute.mock.calls, []);
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
      listAnswers({
        list: () =>
          Effect.succeed(
            processOutput(JSON.stringify([pullRequestRow({ number: 7, author: "hubot" })])),
          ),
      });

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

  it.effect("says whether the viewer may push to the repository a row is on", () =>
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
      listAnswers({
        list: oneOpenRow,
        repository: () => Effect.succeed(processOutput(repositoryJson({ push: false }))),
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => [entry.number, entry.viewerCanWrite]),
        [[1, false]],
      );
      // One read per repository, however many checkouts point at it.
      assert.deepStrictEqual(repositoryReadCalls(), [["api", "repos/octocat/example-app"]]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves the viewer's rights unsaid when the repository read fails", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      listAnswers({
        list: oneOpenRow,
        repository: () =>
          Effect.fail(
            new GitHubCli.GitHubCliError({ operation: "execute", detail: "Not Found (HTTP 404)" }),
          ),
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0]?.viewerCanWrite, undefined);
      // The rows still stand: a repository we could not read is not a project
      // the user has to do anything about.
      assert.deepStrictEqual(result.errors, []);
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
      listAnswers({
        list: () =>
          Effect.succeed(
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
      });

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

  it.effect("carries the author's picture and a conflict onto the row", () =>
    Effect.gen(function* () {
      withProjects([
        project({
          id: "project-app",
          title: "Example App",
          provider: "github",
          repository: "octocat/example-app",
        }),
      ]);
      listAnswers({
        list: () =>
          Effect.succeed(
            processOutput(
              JSON.stringify([
                pullRequestRow({ number: 1, author: "hubot", mergeable: "CONFLICTING" }),
                // The host has not finished checking, which is not an answer.
                pullRequestRow({ number: 2, author: "hubot" }),
              ]),
            ),
          ),
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => [entry.number, entry.mergeability]),
        [
          [1, "conflicting"],
          [2, undefined],
        ],
      );
      assert.equal(result.entries[0]?.author?.avatarUrl, "https://github.com/hubot.png?size=80");
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
      listAnswers({
        list: (args) =>
          repositoryArg(args) === "octocat/site"
            ? Effect.fail(
                new GitHubCli.GitHubCliError({
                  operation: "execute",
                  detail: "You are not logged into any GitHub hosts. Run gh auth login.",
                }),
              )
            : oneOpenRow(),
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
      listAnswers({ list: oneOpenRow });

      const service = yield* PullRequestService.PullRequestService;
      yield* service.list({ state: "open" });
      yield* service.list({ state: "open" });
      expect(prListCalls()).toHaveLength(1);

      yield* service.list({ state: "open", force: true });
      expect(prListCalls()).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds the viewer's own pull requests from repositories the workspace has not", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      listAnswers({
        list: oneOpenRow,
        authored: () =>
          Effect.succeed(
            processOutput(
              authoredSearchJson([
                // The workspace already read this repository, so its own listing
                // answers for it and the search must not repeat the row.
                authoredSearchNode({ number: 1, repository: "Octocat/Example-App" }),
                authoredSearchNode({ number: 4, repository: "openai/codex" }),
              ]),
            ),
          ),
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => [
          entry.origin,
          entry.repository,
          entry.number,
          entry.projectId,
          entry.projectTitle,
        ]),
        [
          ["workspace", "octocat/example-app", 1, "project-app", "Example App"],
          // The anchor project is only where the host's tool runs, so the row
          // names the repository it is really on.
          ["authored", "openai/codex", 4, "project-app", "openai/codex"],
        ],
      );
      assert.deepStrictEqual(result.errors, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the listing when the account-wide search fails", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      listAnswers({
        list: oneOpenRow,
        authored: () =>
          Effect.fail(
            new GitHubCli.GitHubCliError({
              operation: "execute",
              detail: "API rate limit exceeded for user.",
            }),
          ),
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open" });

      assert.deepStrictEqual(
        result.entries.map((entry) => entry.number),
        [1],
      );
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]?.projectId, "project-app");
      assert.equal(result.errors[0]?.repository, null);
      assert.equal(result.errors[0]?.reason, "rate-limited");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves the search alone for a caller that only wants the workspace", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      listAnswers({
        list: oneOpenRow,
        authored: () => Effect.sync(() => assert.fail("the search ran for a workspace-only list")),
      });

      const service = yield* PullRequestService.PullRequestService;
      const result = yield* service.list({ state: "open", includeAuthored: false });

      assert.deepStrictEqual(
        result.entries.map((entry) => entry.origin),
        ["workspace"],
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("PullRequestService pull request reads", () => {
  const reference = pullRequestReference;

  it.effect("refuses a pull request whose project is not one this workspace reads", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      hostAnswers();

      const service = yield* PullRequestService.PullRequestService;
      const error = yield* service
        .detail({ ...reference, projectId: ProjectId.make("project-gone") })
        .pipe(Effect.flip);

      assert.equal(error.detail, "Pull request is not in this workspace.");
      assert.deepStrictEqual(mockExecute.mock.calls, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a repository the project's own remote does not point at", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      hostAnswers();

      const service = yield* PullRequestService.PullRequestService;
      const detail = yield* service.detail({ ...reference, repository: "openai/codex" });

      assert.equal(detail.repository, "openai/codex");
      // The project is only the checkout the tool runs in; the repository is
      // whichever one the reference names.
      assert.deepStrictEqual(prCalls("view")[0]?.args.slice(0, 5), [
        "pr",
        "view",
        "12",
        "--repo",
        "openai/codex",
      ]);
      assert.deepStrictEqual(
        mockExecute.mock.calls
          .map(([input]) => input.args)
          .filter((args) => args[0] === "api" && args[1] !== "graphql"),
        [["api", "repos/openai/codex"]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports what the viewer may do and how the repository allows a merge", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      let author = "hubot";
      hostAnswers({
        repository: repositoryJson({ push: false, merge: false }),
        detail: () => detailJson({ author }),
      });

      const service = yield* PullRequestService.PullRequestService;
      const theirs = yield* service.detail(reference);

      assert.deepStrictEqual(theirs.viewer, {
        canWrite: false,
        canReview: true,
        canManage: false,
      });
      assert.deepStrictEqual(theirs.mergeMethods, ["squash", "rebase"]);

      author = "OctoCat";
      const mine = yield* service.detail({ ...reference, force: true });

      // The author may close and rewrite their own pull request without any
      // rights over the repository it is aimed at.
      assert.deepStrictEqual(mine.viewer, { canWrite: false, canReview: false, canManage: true });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("posts a comment from a body file and drops that pull request's cached reads", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      let commentBody: string | null = null;
      hostAnswers({
        onWrite: (args) => {
          commentBody = bodyFileContents(args);
          return "https://github.com/octocat/example-app/pull/12#issuecomment-1\n";
        },
      });

      const service = yield* PullRequestService.PullRequestService;
      yield* service.detail(reference);
      yield* service.activity(reference);
      yield* service.detail(reference);
      expect(prCalls("view")).toHaveLength(2);

      const result = yield* service.comment({ ...reference, body: "Looks good to me" });

      assert.equal(result.url, "https://github.com/octocat/example-app/pull/12#issuecomment-1");
      assert.equal(commentBody, "Looks good to me");
      const commentArgs = prCalls("comment")[0]?.args ?? [];
      assert.deepStrictEqual(commentArgs.slice(0, 5), [
        "pr",
        "comment",
        "12",
        "--repo",
        "octocat/example-app",
      ]);
      assert.equal(commentArgs.includes("Looks good to me"), false);

      yield* service.detail(reference);
      yield* service.activity(reference);
      expect(prCalls("view")).toHaveLength(4);
    }).pipe(Effect.provide(layer)),
  );
});

describe("PullRequestService pull request actions", () => {
  const reference = pullRequestReference;

  it.effect("refuses a merge method the repository does not allow before running gh", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      hostAnswers({ repository: repositoryJson({ squash: false }) });

      const service = yield* PullRequestService.PullRequestService;
      const error = yield* service
        .runAction({ ...reference, action: "merge", mergeMethod: "squash" })
        .pipe(Effect.flip);

      assert.equal(error.detail, "This repository does not allow a squash merge.");
      assert.deepStrictEqual(prCalls("merge"), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("merges with the repository's first allowed method when the caller names none", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      hostAnswers({ repository: repositoryJson({ merge: false }) });

      const service = yield* PullRequestService.PullRequestService;
      yield* service.runAction({ ...reference, action: "merge" });

      assert.deepStrictEqual(prCalls("merge")[0]?.args, [
        "pr",
        "merge",
        "12",
        "--repo",
        "octocat/example-app",
        "--squash",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("turns a pull request back into a draft and answers with the host's fresh state", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      let isDraft = false;
      hostAnswers({
        detail: () => detailJson({ isDraft }),
        onWrite: () => {
          isDraft = true;
          return "";
        },
      });

      const service = yield* PullRequestService.PullRequestService;
      const before = yield* service.detail(reference);
      assert.equal(before.isDraft, false);
      yield* service.list({ state: "open" });

      const result = yield* service.runAction({ ...reference, action: "draft" });

      assert.deepStrictEqual(result, { state: "open", isDraft: true });
      assert.deepStrictEqual(prCalls("ready")[0]?.args, [
        "pr",
        "ready",
        "12",
        "--repo",
        "octocat/example-app",
        "--undo",
      ]);

      yield* service.list({ state: "open" });
      expect(prListCalls()).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a request for changes with no comment before running gh", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      hostAnswers();

      const service = yield* PullRequestService.PullRequestService;
      const error = yield* service
        .submitReview({ ...reference, verdict: "request-changes", body: "   ", comments: [] })
        .pipe(Effect.flip);

      assert.equal(error.detail, "Requesting changes needs a comment.");
      assert.deepStrictEqual(prCalls("review"), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("approves without a body file and drops that pull request's cached reads", () =>
    Effect.gen(function* () {
      onlyGitHubProject();
      hostAnswers({
        onWrite: () => "https://github.com/octocat/example-app/pull/12#pullrequestreview-1\n",
      });

      const service = yield* PullRequestService.PullRequestService;
      yield* service.detail(reference);

      const result = yield* service.submitReview({
        ...reference,
        verdict: "approve",
        body: "",
        comments: [],
      });

      assert.equal(
        result.url,
        "https://github.com/octocat/example-app/pull/12#pullrequestreview-1",
      );
      assert.deepStrictEqual(prCalls("review")[0]?.args, [
        "pr",
        "review",
        "12",
        "--repo",
        "octocat/example-app",
        "--approve",
      ]);

      yield* service.detail(reference);
      expect(prCalls("view")).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
});

describe("PullRequestService capabilities", () => {
  const reference = pullRequestReference;

  it.effect("refuses what the host cannot do before it reaches the host", () =>
    Effect.gen(function* () {
      onlyGitHubProject();

      const service = yield* PullRequestService.PullRequestService;
      const error = yield* service
        .setThreadResolution({ ...reference, threadId: "PRRT_1", resolved: true })
        .pipe(Effect.flip);

      assert.equal(error.detail, "This host cannot resolve a review conversation.");
    }).pipe(
      Effect.provide(
        layerWithCapabilities({
          ...GITHUB_PULL_REQUEST_CAPABILITIES,
          review: { ...GITHUB_PULL_REQUEST_CAPABILITIES.review, resolve: false },
        }),
      ),
    ),
  );

  it.effect("refuses an action the host does not list", () =>
    Effect.gen(function* () {
      onlyGitHubProject();

      const service = yield* PullRequestService.PullRequestService;
      const error = yield* service
        .runAction({ ...reference, action: "update-branch" })
        .pipe(Effect.flip);

      assert.equal(error.detail, "This host cannot update branch a pull request.");
    }).pipe(
      Effect.provide(
        layerWithCapabilities({
          ...GITHUB_PULL_REQUEST_CAPABILITIES,
          actions: ["merge", "close"],
        }),
      ),
    ),
  );
});
