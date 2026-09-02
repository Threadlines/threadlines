import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import {
  ProjectId,
  PullRequestServiceError,
  type OrchestrationProjectShell,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListProjectErrorReason,
  type PullRequestListResult,
  type PullRequestListState,
} from "@threadlines/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
} from "../sourceControl/gitHubAuthStatus.ts";
import {
  decodeGitHubPullRequestListJson,
  formatGitHubPullRequestListDecodeError,
  GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD,
  GITHUB_PULL_REQUEST_LIST_FIELDS,
  type GitHubPullRequestListRow,
} from "./gitHubPullRequestList.ts";

const GITHUB_HOST = "github.com";
const PROJECT_CONCURRENCY = 4;
const OPEN_LIST_LIMIT = 50;
const SETTLED_LIST_LIMIT = 30;
/** The page refreshes on an interval, so a short shared cache keeps `gh` off the host. */
const LIST_CACHE_TTL = Duration.seconds(30);
const LIST_CACHE_CAPACITY = 32;
/** The signed-in account changes far more rarely than the listings do. */
const VIEWER_CACHE_TTL = Duration.minutes(10);
const VIEWER_CACHE_CAPACITY = 4;

export interface PullRequestServiceShape {
  readonly list: (
    input: PullRequestListInput,
  ) => Effect.Effect<PullRequestListResult, PullRequestServiceError>;
}

export class PullRequestService extends Context.Service<
  PullRequestService,
  PullRequestServiceShape
>()("threadlines/pullRequest/PullRequestService") {}

/** One project the listing can read, already resolved to an `owner/name` repository. */
interface PullRequestProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository: string;
}

interface PullRequestListCacheKey {
  readonly state: PullRequestListState;
  readonly projectId?: ProjectId;
}

/** What one project contributed to a listing: its rows, or the reason it failed. */
interface PullRequestProjectRead {
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly error: PullRequestListProjectError | null;
}

const listCacheKey = (key: PullRequestListCacheKey) => `${key.state}|${key.projectId ?? "*"}`;

/** Inverse of {@link listCacheKey}; only ever reads keys that function produced. */
function parseListCacheKey(key: string): PullRequestListCacheKey {
  const separatorIndex = key.indexOf("|");
  const rawState = key.slice(0, separatorIndex);
  const rawProjectId = key.slice(separatorIndex + 1);
  const state: PullRequestListState =
    rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
  return {
    state,
    ...(rawProjectId === "*" ? {} : { projectId: ProjectId.make(rawProjectId) }),
  };
}

/**
 * Only workspace projects with a resolved GitHub `owner/name` can be listed.
 * Everything else is skipped silently: a Bitbucket project or a general chat is
 * not a failure the user needs to see.
 */
function toPullRequestProject(project: OrchestrationProjectShell): PullRequestProject | null {
  if (project.kind === "general-chat") {
    return null;
  }

  const identity = project.repositoryIdentity;
  if (!identity || identity.provider !== "github") {
    return null;
  }

  const owner = identity.owner?.trim() ?? "";
  const name = identity.name?.trim() ?? "";
  if (owner.length === 0 || name.length === 0) {
    return null;
  }

  return {
    projectId: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    repository: `${owner}/${name}`,
  };
}

/**
 * One read per repository. A checkout and its worktrees are separate projects
 * pointing at the same remote, and the host would answer each of them with the
 * same rows. The first project keeps the seat; GitHub repository names are
 * case-insensitive, so the key is too.
 */
function dedupeProjectsByRepository(
  projects: ReadonlyArray<PullRequestProject>,
): ReadonlyArray<PullRequestProject> {
  const byRepository = new Map<string, PullRequestProject>();
  for (const project of projects) {
    const key = project.repository.toLowerCase();
    if (!byRepository.has(key)) {
      byRepository.set(key, project);
    }
  }
  return [...byRepository.values()];
}

/** Turns a `gh` failure into the reason the page renders an action for. */
function classifyPullRequestListFailure(detail: string): PullRequestListProjectErrorReason {
  const lower = detail.toLowerCase();
  if (
    lower.includes("not available on path") ||
    lower.includes("command not found") ||
    lower.includes("enoent")
  ) {
    return "missing-tool";
  }
  if (
    lower.includes("not logged in") ||
    lower.includes("not authenticated") ||
    lower.includes("authentication") ||
    lower.includes("auth login")
  ) {
    return "unauthenticated";
  }
  if (lower.includes("rate limit")) {
    return "rate-limited";
  }
  return "failed";
}

function listFieldsFor(state: PullRequestListState): string {
  return state === "open"
    ? [...GITHUB_PULL_REQUEST_LIST_FIELDS, GITHUB_PULL_REQUEST_LIST_CHECKS_FIELD].join(",")
    : GITHUB_PULL_REQUEST_LIST_FIELDS.join(",");
}

function toEntry(input: {
  readonly project: PullRequestProject;
  readonly row: GitHubPullRequestListRow;
  readonly viewer: string | null;
}): PullRequestListEntry {
  const { project, row, viewer } = input;
  const viewerLogin = viewer?.trim().toLowerCase() ?? "";
  const matchesViewer = (login: string) =>
    viewerLogin.length > 0 && login.toLowerCase() === viewerLogin;

  return {
    provider: "github",
    projectId: project.projectId,
    projectTitle: project.title,
    repository: project.repository,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    state: row.state,
    isDraft: row.isDraft,
    additions: row.additions,
    deletions: row.deletions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    viewerIsAuthor: row.author !== null && matchesViewer(row.author.login),
    viewerReviewRequested: row.reviewRequestedLogins.some(matchesViewer),
    ...(row.reviewDecision === undefined ? {} : { reviewDecision: row.reviewDecision }),
    ...(row.checksState === undefined ? {} : { checksState: row.checksState }),
    labels: row.labels,
  };
}

export const make = Effect.fn("makePullRequestService")(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const projections = yield* ProjectionSnapshotQuery;

  const readProjects = (projectId: ProjectId | undefined) =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        (error) => new PullRequestServiceError({ operation: "list", detail: error.message }),
      ),
      Effect.map((snapshot) =>
        snapshot.projects.flatMap((project) => {
          if (projectId !== undefined && project.id !== projectId) {
            return [];
          }
          const target = toPullRequestProject(project);
          return target === null ? [] : [target];
        }),
      ),
    );

  /**
   * `gh auth status` is the only place the signed-in login is available, and it
   * needs a working directory like every other `gh` call, so the cache is keyed
   * by the one it ran in. A host we cannot read leaves the viewer unknown
   * rather than failing the listing.
   */
  const viewerCache = yield* Cache.make({
    capacity: VIEWER_CACHE_CAPACITY,
    timeToLive: VIEWER_CACHE_TTL,
    lookup: (cwd: string) =>
      github.execute({ cwd, args: ["auth", "status", "--json", "hosts"] }).pipe(
        Effect.map((output): string | null => {
          const status = parseGitHubAuthStatus(output.stdout);
          const account = findAuthenticatedGitHubAccount(
            status.accounts.filter((entry) => entry.host === GITHUB_HOST),
          );
          return account?.account ?? null;
        }),
        Effect.catch(() => Effect.succeed(null)),
      ),
  });

  const readProjectRows = (project: PullRequestProject, state: PullRequestListState) =>
    github
      .execute({
        cwd: project.workspaceRoot,
        args: [
          "pr",
          "list",
          "--repo",
          project.repository,
          "--state",
          state,
          "--limit",
          String(state === "open" ? OPEN_LIST_LIMIT : SETTLED_LIST_LIMIT),
          "--json",
          listFieldsFor(state),
        ],
      })
      .pipe(
        Effect.flatMap((output) => {
          const raw = output.stdout.trim();
          if (raw.length === 0) {
            return Effect.succeed<ReadonlyArray<GitHubPullRequestListRow>>([]);
          }

          const decoded = decodeGitHubPullRequestListJson(raw);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitHubCli.GitHubCliError({
                  operation: "pullRequests.list",
                  detail: `GitHub CLI returned invalid PR list JSON: ${formatGitHubPullRequestListDecodeError(decoded.failure)}`,
                  cause: decoded.failure,
                }),
              );
        }),
      );

  /** A project that fails becomes one error entry; the other projects still return. */
  const readProject = (input: {
    readonly project: PullRequestProject;
    readonly state: PullRequestListState;
    readonly viewer: string | null;
  }) =>
    readProjectRows(input.project, input.state).pipe(
      Effect.map((rows): PullRequestProjectRead => ({
        entries: rows.map((row) => toEntry({ project: input.project, row, viewer: input.viewer })),
        error: null,
      })),
      Effect.catch((error) =>
        Effect.succeed<PullRequestProjectRead>({
          entries: [],
          error: {
            projectId: input.project.projectId,
            projectTitle: input.project.title,
            repository: input.project.repository,
            reason: classifyPullRequestListFailure(error.detail),
            detail: error.detail,
          },
        }),
      ),
    );

  const loadList = Effect.fn("PullRequestService.load")(function* (key: PullRequestListCacheKey) {
    const projects = dedupeProjectsByRepository(yield* readProjects(key.projectId));
    const first = projects[0];
    if (first === undefined) {
      return { viewer: null, entries: [], errors: [] } satisfies PullRequestListResult;
    }

    const viewer = yield* Cache.get(viewerCache, first.workspaceRoot);
    const results = yield* Effect.forEach(
      projects,
      (project) => readProject({ project, state: key.state, viewer }),
      { concurrency: PROJECT_CONCURRENCY },
    );

    return {
      viewer,
      entries: results.flatMap((result) => result.entries),
      errors: results.flatMap((result) => (result.error === null ? [] : [result.error])),
    } satisfies PullRequestListResult;
  });

  const listCache = yield* Cache.make({
    capacity: LIST_CACHE_CAPACITY,
    timeToLive: LIST_CACHE_TTL,
    lookup: (key: string) => loadList(parseListCacheKey(key)),
  });

  return PullRequestService.of({
    list: (input) =>
      Effect.suspend(() => {
        const key = listCacheKey({
          state: input.state,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        });
        return (input.force === true ? Cache.invalidate(listCache, key) : Effect.void).pipe(
          Effect.andThen(Cache.get(listCache, key)),
        );
      }),
  });
});

export const layer = Layer.effect(PullRequestService, make());
