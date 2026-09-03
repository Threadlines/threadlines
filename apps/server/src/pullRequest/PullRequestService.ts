import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProjectId,
  PullRequestServiceError,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestActionResult,
  type PullRequestActivity,
  type PullRequestActivityInput,
  type PullRequestCapabilities,
  type PullRequestCommentInput,
  type PullRequestCommentResult,
  type PullRequestCommentUpdateInput,
  type PullRequestDetail,
  type PullRequestDetailInput,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestListEntry,
  type PullRequestListEntryOrigin,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestReactionInput,
  type PullRequestRef,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerRequestInput,
  type PullRequestReviewInput,
  type PullRequestReviewResult,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
  type PullRequestUpdateInput,
  type SourceControlProviderKind,
} from "@threadlines/contracts";

import {
  changeRequestRepositoryName,
  toChangeRequestProviderKind,
} from "@threadlines/shared/sourceControl";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  PullRequestProviderRegistry,
  type ProviderAuthoredChangeRequest,
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryAccess,
  type PullRequestProviderApi,
  type PullRequestProviderError,
} from "./PullRequestProvider.ts";

const PROJECT_CONCURRENCY = 4;
const OPEN_LIST_LIMIT = 50;
const SETTLED_LIST_LIMIT = 30;
/** The page refreshes on an interval, so a short shared cache keeps the host quiet. */
const LIST_CACHE_TTL = Duration.seconds(30);
const LIST_CACHE_CAPACITY = 32;
/** The signed-in account changes far more rarely than the listings do. */
const VIEWER_CACHE_TTL = Duration.minutes(10);
const VIEWER_CACHE_CAPACITY = 4;
/** One open pull request is read far more often than it changes. */
const DETAIL_CACHE_TTL = Duration.seconds(15);
const ACTIVITY_CACHE_TTL = Duration.seconds(15);
/** Patches are the expensive read and the slowest to change. */
const DIFF_CACHE_TTL = Duration.seconds(60);
const PULL_REQUEST_CACHE_CAPACITY = 32;
/** Repository settings and access change far more rarely than a pull request. */
const REPOSITORY_CACHE_TTL = Duration.minutes(10);
const REPOSITORY_CACHE_CAPACITY = 16;
/**
 * The hosts whose list rows say whether the viewer may push. Every host can be
 * asked, but only GitHub's answer is one the page has been built against, and a
 * row from a host we do not ask says nothing rather than guessing.
 */
const WRITE_ACCESS_HOSTS: ReadonlySet<SourceControlProviderKind> = new Set(["github"]);

/** The one thing a caller can get wrong that is not the host's fault. */
const FOREIGN_PULL_REQUEST_DETAIL = "Pull request is not in this workspace.";

export interface PullRequestServiceShape {
  readonly list: (
    input: PullRequestListInput,
  ) => Effect.Effect<PullRequestListResult, PullRequestServiceError>;
  readonly detail: (
    input: PullRequestDetailInput,
  ) => Effect.Effect<PullRequestDetail, PullRequestServiceError>;
  readonly activity: (
    input: PullRequestActivityInput,
  ) => Effect.Effect<PullRequestActivity, PullRequestServiceError>;
  readonly diff: (
    input: PullRequestDiffInput,
  ) => Effect.Effect<PullRequestDiffResult, PullRequestServiceError>;
  readonly comment: (
    input: PullRequestCommentInput,
  ) => Effect.Effect<PullRequestCommentResult, PullRequestServiceError>;
  readonly runAction: (
    input: PullRequestActionInput,
  ) => Effect.Effect<PullRequestActionResult, PullRequestServiceError>;
  readonly submitReview: (
    input: PullRequestReviewInput,
  ) => Effect.Effect<PullRequestReviewResult, PullRequestServiceError>;
  readonly replyToThread: (
    input: PullRequestThreadReplyInput,
  ) => Effect.Effect<void, PullRequestServiceError>;
  readonly setThreadResolution: (
    input: PullRequestThreadResolutionInput,
  ) => Effect.Effect<void, PullRequestServiceError>;
  readonly setReaction: (
    input: PullRequestReactionInput,
  ) => Effect.Effect<void, PullRequestServiceError>;
  readonly update: (input: PullRequestUpdateInput) => Effect.Effect<void, PullRequestServiceError>;
  readonly updateComment: (
    input: PullRequestCommentUpdateInput,
  ) => Effect.Effect<void, PullRequestServiceError>;
  readonly reviewerCandidates: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestServiceError>;
  readonly requestReviewers: (
    input: PullRequestReviewerRequestInput,
  ) => Effect.Effect<void, PullRequestServiceError>;
}

export class PullRequestService extends Context.Service<
  PullRequestService,
  PullRequestServiceShape
>()("threadlines/pullRequest/PullRequestService") {}

/** One project a provider can read, already resolved to a host repository. */
interface PullRequestProject {
  readonly projectId: ProjectId;
  readonly provider: SourceControlProviderKind;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository: string;
  /**
   * The remote itself, host and all. Two projects on one remote answer with the
   * same rows, and this is what says so: `repository` cannot, because Azure
   * DevOps names a repository by its own name and two projects of one
   * organisation may each have a `tools`.
   */
  readonly remoteKey: string;
}

/**
 * Where one call runs: the project whose checkout the host tool is run in, the
 * provider that speaks for its host, and the repository the call addresses.
 * That repository is the project's own remote for everything the workspace
 * points at, and someone else's for a pull request the viewer opened elsewhere.
 */
interface PullRequestTarget {
  readonly project: PullRequestProject;
  readonly provider: PullRequestProviderApi;
  readonly repository: string;
}

interface PullRequestListCacheKey {
  readonly state: PullRequestListState;
  readonly projectId?: ProjectId;
  /**
   * Part of the key rather than a filter over it: a listing without the
   * viewer's own outside work is a different answer, and sharing one entry
   * would hand whichever caller asked second the other one's rows.
   */
  readonly includeAuthored: boolean;
}

/** What one project contributed to a listing: its rows, or the reason it failed. */
interface PullRequestProjectRead {
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly error: PullRequestListProjectError | null;
}

/**
 * Identifies one pull request inside the caches keyed per pull request. The
 * repository is part of it because one project reads pull requests from more
 * than one repository: numbers collide across repositories, and the project
 * alone would serve one of them the other's answer.
 */
interface PullRequestCacheKey {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}

/** The repository's own settings, which are per repository and not per project. */
interface RepositoryCacheKey {
  readonly projectId: ProjectId;
  readonly repository: string;
}

const listCacheKey = (key: PullRequestListCacheKey) =>
  `${key.state}|${key.includeAuthored ? "1" : "0"}|${key.projectId ?? "*"}`;

const pullRequestCacheKey = (key: PullRequestCacheKey) =>
  `${key.projectId}|${key.repository.toLowerCase()}|${key.number}`;

/**
 * Inverse of {@link pullRequestCacheKey}; only ever reads keys it produced. Read
 * from the right, since no host allows a `|` in a repository name but nothing
 * promises a project id has none.
 */
function parsePullRequestCacheKey(key: string): PullRequestCacheKey {
  const numberIndex = key.lastIndexOf("|");
  const repositoryIndex = key.lastIndexOf("|", numberIndex - 1);
  return {
    projectId: ProjectId.make(key.slice(0, repositoryIndex)),
    repository: key.slice(repositoryIndex + 1, numberIndex),
    number: Number(key.slice(numberIndex + 1)),
  };
}

const repositoryCacheKey = (key: RepositoryCacheKey) =>
  `${key.projectId}|${key.repository.toLowerCase()}`;

/** Inverse of {@link repositoryCacheKey}; read from the right for the same reason. */
function parseRepositoryCacheKey(key: string): RepositoryCacheKey {
  const separatorIndex = key.lastIndexOf("|");
  return {
    projectId: ProjectId.make(key.slice(0, separatorIndex)),
    repository: key.slice(separatorIndex + 1),
  };
}

/** Inverse of {@link listCacheKey}; only ever reads keys that function produced. */
function parseListCacheKey(key: string): PullRequestListCacheKey {
  const stateIndex = key.indexOf("|");
  const authoredIndex = key.indexOf("|", stateIndex + 1);
  const rawState = key.slice(0, stateIndex);
  const rawProjectId = key.slice(authoredIndex + 1);
  const state: PullRequestListState =
    rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
  return {
    state,
    includeAuthored: key.slice(stateIndex + 1, authoredIndex) === "1",
    ...(rawProjectId === "*" ? {} : { projectId: ProjectId.make(rawProjectId) }),
  };
}

/** The viewer cache is keyed by both, since each host signs in on its own. */
const viewerCacheKey = (provider: SourceControlProviderKind, cwd: string) => `${provider}|${cwd}`;

function parseViewerCacheKey(key: string): {
  readonly provider: SourceControlProviderKind;
  readonly cwd: string;
} {
  const separatorIndex = key.indexOf("|");
  return {
    provider: key.slice(0, separatorIndex) as SourceControlProviderKind,
    cwd: key.slice(separatorIndex + 1),
  };
}

/**
 * Only workspace projects on a host this build has a provider for, with a
 * repository the host can be asked about, can be read. Everything else is
 * skipped silently: a general chat or a host with no provider is not a failure
 * the user needs.
 */
function toPullRequestProject(
  project: OrchestrationProjectShell,
  registry: PullRequestProviderRegistry["Service"],
): PullRequestProject | null {
  if (project.kind === "general-chat") {
    return null;
  }

  const identity = project.repositoryIdentity;
  const provider = toChangeRequestProviderKind(identity?.provider);
  if (provider === null || registry.get(provider) === null) {
    return null;
  }

  const repository = changeRequestRepositoryName(identity);
  if (repository === null) {
    return null;
  }

  return {
    projectId: project.id,
    provider,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    repository,
    remoteKey: identity?.canonicalKey.trim().toLowerCase() ?? `${provider}|${repository}`,
  };
}

/**
 * One read per remote. A checkout and its worktrees are separate projects
 * pointing at the same one, and the host would answer each of them with the
 * same rows. The first project keeps the seat; remotes are recorded
 * case-insensitively, so the key is too.
 */
function dedupeProjectsByRemote(
  projects: ReadonlyArray<PullRequestProject>,
): ReadonlyArray<PullRequestProject> {
  const byRemote = new Map<string, PullRequestProject>();
  for (const project of projects) {
    if (!byRemote.has(project.remoteKey)) {
      byRemote.set(project.remoteKey, project);
    }
  }
  return [...byRemote.values()];
}

/**
 * One project per host: a host's account-wide search answers the same rows
 * whichever of its checkouts it is run from, so only the first is asked.
 */
function firstProjectPerProvider(
  projects: ReadonlyArray<PullRequestProject>,
): ReadonlyArray<PullRequestProject> {
  const byProvider = new Map<SourceControlProviderKind, PullRequestProject>();
  for (const project of projects) {
    if (!byProvider.has(project.provider)) {
      byProvider.set(project.provider, project);
    }
  }
  return [...byProvider.values()];
}

/** One repository on one host. Repository names are case-insensitive, so this is too. */
const repositoryScopeKey = (provider: SourceControlProviderKind, repository: string) =>
  `${provider}|${repository.trim().toLowerCase()}`;

/** One pull request on one host, which is what says two reads found the same one. */
const listRowKey = (provider: SourceControlProviderKind, repository: string, number: number) =>
  `${repositoryScopeKey(provider, repository)}|${number}`;

/**
 * Whether an authored row is news. A repository the workspace already read
 * answers for its own rows, whatever the search says about it, and a row a
 * workspace read already carries is one pull request found twice.
 */
function keepAuthoredRow(input: {
  readonly row: ProviderAuthoredChangeRequest;
  readonly anchor: PullRequestProject;
  readonly covered: ReadonlySet<string>;
  readonly seen: ReadonlySet<string>;
}): boolean {
  const { provider } = input.anchor;
  return (
    !input.covered.has(repositoryScopeKey(provider, input.row.repository)) &&
    !input.seen.has(listRowKey(provider, input.row.repository, input.row.number))
  );
}

/** Logins compare case-insensitively; an unknown viewer matches nothing. */
function viewerMatcher(viewer: string | null): (login: string) => boolean {
  const viewerLogin = viewer?.trim().toLowerCase() ?? "";
  return (login) => viewerLogin.length > 0 && login.toLowerCase() === viewerLogin;
}

function toEntry(input: {
  readonly project: PullRequestProject;
  readonly row: ProviderChangeRequest;
  readonly viewer: string | null;
  readonly origin: PullRequestListEntryOrigin;
  /**
   * Where the row actually lives, when that is not the project's own remote.
   * Such a row borrows the project only for its checkout, so it says which
   * repository it is on where a workspace row says which project it is in.
   */
  readonly repository?: string;
  /** Push access on the row's repository; omitted where the host did not say. */
  readonly viewerCanWrite?: boolean;
}): PullRequestListEntry {
  const { project, row } = input;
  const matchesViewer = viewerMatcher(input.viewer);

  return {
    provider: project.provider,
    projectId: project.projectId,
    projectTitle: input.repository ?? project.title,
    repository: input.repository ?? project.repository,
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
    ...(input.viewerCanWrite === undefined ? {} : { viewerCanWrite: input.viewerCanWrite }),
    ...(row.reviewDecision === undefined ? {} : { reviewDecision: row.reviewDecision }),
    ...(row.checksState === undefined ? {} : { checksState: row.checksState }),
    // A host that has not finished checking says "unknown", which the row
    // carries as nothing at all rather than as an answer.
    ...(row.mergeability === undefined || row.mergeability === "unknown"
      ? {}
      : { mergeability: row.mergeability }),
    labels: row.labels,
    origin: input.origin,
  };
}

/**
 * A workspace row with the viewer's push access on it, where the access read
 * answered for its repository. A row whose repository is missing from the map
 * is left exactly as it was: the field is the host having said, not a default.
 */
function withWriteAccess(
  entry: PullRequestListEntry,
  writeAccess: ReadonlyMap<string, boolean>,
): PullRequestListEntry {
  const canWrite = writeAccess.get(repositoryScopeKey(entry.provider, entry.repository));
  return canWrite === undefined ? entry : { ...entry, viewerCanWrite: canWrite };
}

function toDetail(input: {
  readonly target: PullRequestTarget;
  readonly row: ProviderChangeRequestDetail;
  readonly viewer: string | null;
  readonly repository: ProviderRepositoryAccess;
  readonly capabilities: PullRequestCapabilities;
}): PullRequestDetail {
  const { project } = input.target;
  const { row } = input;
  const matchesViewer = viewerMatcher(input.viewer);
  const viewerIsAuthor = row.author !== null && matchesViewer(row.author.login);
  // A host refuses a review of your own pull request, and an unknown viewer
  // could be anyone, so neither may review.
  const viewerKnown = (input.viewer?.trim().length ?? 0) > 0;
  const defaultBranch = input.repository.defaultBranch;

  return {
    provider: project.provider,
    projectId: project.projectId,
    projectTitle: project.title,
    workspaceRoot: project.workspaceRoot,
    repository: input.target.repository,
    number: row.number,
    title: row.title,
    body: row.body,
    url: row.url,
    author: row.author,
    state: row.state,
    isDraft: row.isDraft,
    mergeability: row.mergeability,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mergedAt: row.mergedAt,
    closedAt: row.closedAt,
    viewerIsAuthor,
    ...(row.reviewDecision === undefined ? {} : { reviewDecision: row.reviewDecision }),
    reviewers: row.reviewers,
    labels: row.labels,
    checks: row.checks,
    ...(row.checksState === undefined ? {} : { checksState: row.checksState }),
    viewer: {
      canWrite: input.repository.canWrite,
      canReview: viewerKnown && !viewerIsAuthor,
      // A host lets the author close, reopen and rewrite their own pull
      // request without any rights over the repository it is aimed at.
      canManage: input.repository.canWrite || viewerIsAuthor,
    },
    mergeMethods: input.repository.mergeMethods,
    // What the host supports in general, narrowed to what this repository
    // actually allows, so the client never offers a merge the host refuses.
    capabilities: { ...input.capabilities, mergeMethods: input.repository.mergeMethods },
    baseComparison: row.baseComparison,
    behindBy: row.behindBy,
    autoMergeEnabled: row.autoMergeEnabled,
    isStacked: defaultBranch !== null && row.baseBranch !== defaultBranch,
    defaultBranch,
  };
}

export const make = Effect.fn("makePullRequestService")(function* () {
  const registry = yield* PullRequestProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery;

  /** Every provider failure reaches the client as the host's own sentence. */
  const asServiceError = (operation: string) => (error: PullRequestProviderError) =>
    new PullRequestServiceError({ operation, detail: error.detail });

  /** Refuses a call the host does not support before anything runs. */
  const requireCapability = (input: {
    readonly operation: string;
    readonly allowed: boolean;
    readonly detail: string;
  }) =>
    input.allowed
      ? Effect.void
      : Effect.fail(
          new PullRequestServiceError({ operation: input.operation, detail: input.detail }),
        );

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
          const target = toPullRequestProject(project, registry);
          return target === null ? [] : [target];
        }),
      ),
    );

  /**
   * The signed-in login, which is what the viewer flags compare against. A host
   * we cannot read leaves the viewer unknown rather than failing the listing.
   */
  const viewerCache = yield* Cache.make({
    capacity: VIEWER_CACHE_CAPACITY,
    timeToLive: VIEWER_CACHE_TTL,
    lookup: (key: string) =>
      Effect.suspend(() => {
        const { provider, cwd } = parseViewerCacheKey(key);
        const host = registry.get(provider);
        return host === null
          ? Effect.succeed<string | null>(null)
          : host.getViewer({ cwd }).pipe(Effect.catch(() => Effect.succeed(null)));
      }),
  });

  const readViewer = (project: PullRequestProject) =>
    Cache.get(viewerCache, viewerCacheKey(project.provider, project.workspaceRoot));

  /** A project that fails becomes one error entry; the other projects still return. */
  const readProject = (input: {
    readonly project: PullRequestProject;
    readonly state: PullRequestListState;
    readonly viewer: string | null;
  }) =>
    Effect.suspend(() => {
      const host = registry.get(input.project.provider);
      if (host === null) {
        return Effect.succeed<PullRequestProjectRead>({ entries: [], error: null });
      }
      return host
        .listChangeRequests({
          cwd: input.project.workspaceRoot,
          repository: input.project.repository,
          state: input.state,
          limit: input.state === "open" ? OPEN_LIST_LIMIT : SETTLED_LIST_LIMIT,
        })
        .pipe(
          Effect.map((rows): PullRequestProjectRead => ({
            entries: rows.map((row) =>
              toEntry({ project: input.project, row, viewer: input.viewer, origin: "workspace" }),
            ),
            error: null,
          })),
          Effect.catch((error) =>
            Effect.succeed<PullRequestProjectRead>({
              entries: [],
              error: {
                projectId: input.project.projectId,
                projectTitle: input.project.title,
                repository: input.project.repository,
                reason: error.reason,
                detail: error.detail,
              },
            }),
          ),
        );
    });

  /**
   * The viewer's own pull requests anywhere on one host, whether or not the
   * workspace points at the repository they are on. The anchor project is only
   * the checkout the host's tool runs in; a row it finds keeps that project so
   * a later read has somewhere to run, and names its own repository.
   *
   * Anything the workspace already read is dropped: the same pull request twice
   * would be two rows of one thing, one of them without its project.
   */
  const readAuthored = (input: {
    readonly anchor: PullRequestProject;
    readonly state: PullRequestListState;
    readonly covered: ReadonlySet<string>;
    readonly seen: ReadonlySet<string>;
  }) =>
    Effect.suspend(() => {
      const empty: PullRequestProjectRead = { entries: [], error: null };
      const host = registry.get(input.anchor.provider);
      const search = host?.listAuthoredChangeRequests;
      if (search === undefined) {
        return Effect.succeed(empty);
      }
      return readViewer(input.anchor).pipe(
        Effect.flatMap((viewer) => {
          // Without a login there is nobody to search for; the workspace rows
          // still stand, which is what they did before this existed.
          if (viewer === null || viewer.trim().length === 0) {
            return Effect.succeed(empty);
          }
          return search({
            cwd: input.anchor.workspaceRoot,
            viewer,
            state: input.state,
            limit: input.state === "open" ? OPEN_LIST_LIMIT : SETTLED_LIST_LIMIT,
          }).pipe(
            Effect.map((rows): PullRequestProjectRead => ({
              entries: rows.flatMap((row) =>
                keepAuthoredRow({
                  row,
                  anchor: input.anchor,
                  covered: input.covered,
                  seen: input.seen,
                })
                  ? [
                      toEntry({
                        project: input.anchor,
                        row,
                        viewer,
                        origin: "authored",
                        repository: row.repository,
                        ...(row.viewerCanWrite === undefined
                          ? {}
                          : { viewerCanWrite: row.viewerCanWrite }),
                      }),
                    ]
                  : [],
              ),
              error: null,
            })),
            Effect.catch((error) =>
              Effect.succeed<PullRequestProjectRead>({
                entries: [],
                error: {
                  projectId: input.anchor.projectId,
                  projectTitle: input.anchor.title,
                  // The search is not about any one repository, so there is
                  // none to name in the notice it fails into.
                  repository: null,
                  reason: error.reason,
                  detail: error.detail,
                },
              }),
            ),
          );
        }),
      );
    });

  /**
   * Where a per-pull-request call runs: the project has to be one this build can
   * read pull requests from, since its checkout is what the host's tool is run
   * in. The repository rides along from the caller rather than being taken from
   * the project, because a pull request the viewer opened on a repository
   * nobody here has checked out is read through a project on the same host.
   */
  const requireTarget = (operation: string, projectId: ProjectId, repository: string) =>
    projections.getShellSnapshot().pipe(
      Effect.mapError((error) => new PullRequestServiceError({ operation, detail: error.message })),
      Effect.flatMap((snapshot) => {
        const found = snapshot.projects.find((candidate) => candidate.id === projectId);
        const project = found === undefined ? null : toPullRequestProject(found, registry);
        const provider = project === null ? null : registry.get(project.provider);
        return project === null || provider === null
          ? Effect.fail(
              new PullRequestServiceError({ operation, detail: FOREIGN_PULL_REQUEST_DETAIL }),
            )
          : Effect.succeed<PullRequestTarget>({
              project,
              provider,
              repository: repository.trim(),
            });
      }),
    );

  /** The target one reference names, guarded before it costs a host call. */
  const resolveReference = (operation: string, reference: PullRequestRef) =>
    requireTarget(operation, reference.projectId, reference.repository);

  /** Where a provider call runs, for a target already resolved. */
  const repositoryRef = (target: PullRequestTarget) => ({
    cwd: target.project.workspaceRoot,
    repository: target.repository,
  });

  /**
   * The repository's own settings: whether the viewer may push, how the host
   * lets a pull request land, and what its default branch is. Keyed by the
   * repository as well as the project, since one project reads more than one.
   */
  const repositoryCache = yield* Cache.make({
    capacity: REPOSITORY_CACHE_CAPACITY,
    timeToLive: REPOSITORY_CACHE_TTL,
    lookup: (key: string) =>
      Effect.suspend(() => {
        const { projectId, repository } = parseRepositoryCacheKey(key);
        return requireTarget("repository", projectId, repository).pipe(
          Effect.flatMap((target) =>
            target.provider
              .getRepositoryAccess(repositoryRef(target))
              .pipe(Effect.mapError(asServiceError("repository"))),
          ),
        );
      }),
  });

  const readRepositoryAccess = (target: PullRequestTarget) =>
    Cache.get(
      repositoryCache,
      repositoryCacheKey({ projectId: target.project.projectId, repository: target.repository }),
    );

  /**
   * Whether the viewer may push to each workspace repository, keyed by
   * {@link repositoryScopeKey}. It is the same cached read the detail makes, so
   * a page that has opened a pull request pays nothing for it here.
   *
   * A repository the read fails on is left out rather than guessed at, and the
   * listing itself never fails over one: the rows still stand, saying nothing
   * about the viewer's rights, which is what a host that cannot say leaves too.
   */
  const readWorkspaceWriteAccess = (projects: ReadonlyArray<PullRequestProject>) =>
    Effect.forEach(
      projects.filter((project) => WRITE_ACCESS_HOSTS.has(project.provider)),
      (project) =>
        Cache.get(
          repositoryCache,
          repositoryCacheKey({
            projectId: project.projectId,
            repository: project.repository,
          }),
        ).pipe(
          Effect.map((access): ReadonlyArray<readonly [string, boolean]> => [
            [repositoryScopeKey(project.provider, project.repository), access.canWrite],
          ]),
          Effect.catch(() => Effect.succeed<ReadonlyArray<readonly [string, boolean]>>([])),
        ),
      { concurrency: PROJECT_CONCURRENCY },
    ).pipe(Effect.map((reads) => new Map(reads.flat())));

  const loadList = Effect.fn("PullRequestService.load")(function* (key: PullRequestListCacheKey) {
    const projects = dedupeProjectsByRemote(yield* readProjects(key.projectId));
    const first = projects[0];
    if (first === undefined) {
      return { viewer: null, entries: [], errors: [] } satisfies PullRequestListResult;
    }

    // The viewer is read per project, because each host signs in on its own and
    // a workspace can hold projects on several. The cache is keyed by host and
    // checkout, so projects that share one share the read.
    const viewer = yield* readViewer(first);
    // The rows and what the viewer may do with them are asked for at once: the
    // access read is per repository, not per row, and waiting for the rows
    // first would only make the listing slower.
    const [results, writeAccess] = yield* Effect.all(
      [
        Effect.forEach(
          projects,
          (project) =>
            readViewer(project).pipe(
              Effect.flatMap((projectViewer) =>
                readProject({ project, state: key.state, viewer: projectViewer }),
              ),
            ),
          { concurrency: PROJECT_CONCURRENCY },
        ),
        readWorkspaceWriteAccess(projects),
      ],
      { concurrency: 2 },
    );

    const entries = results.flatMap((result) =>
      result.entries.map((entry) => withWriteAccess(entry, writeAccess)),
    );
    const errors = results.flatMap((result) => (result.error === null ? [] : [result.error]));
    if (!key.includeAuthored) {
      return { viewer, entries, errors } satisfies PullRequestListResult;
    }

    const covered = new Set(
      projects.map((project) => repositoryScopeKey(project.provider, project.repository)),
    );
    const seen = new Set(
      entries.map((entry) => listRowKey(entry.provider, entry.repository, entry.number)),
    );
    const authored = yield* Effect.forEach(
      firstProjectPerProvider(projects),
      (anchor) => readAuthored({ anchor, state: key.state, covered, seen }),
      { concurrency: PROJECT_CONCURRENCY },
    );

    return {
      viewer,
      entries: [...entries, ...authored.flatMap((result) => result.entries)],
      errors: [
        ...errors,
        ...authored.flatMap((result) => (result.error === null ? [] : [result.error])),
      ],
    } satisfies PullRequestListResult;
  });

  const listCache = yield* Cache.make({
    capacity: LIST_CACHE_CAPACITY,
    timeToLive: LIST_CACHE_TTL,
    lookup: (key: string) => loadList(parseListCacheKey(key)),
  });

  const loadDetail = Effect.fn("PullRequestService.loadDetail")(function* (
    key: PullRequestCacheKey,
  ) {
    const target = yield* requireTarget("detail", key.projectId, key.repository);
    const viewer = yield* readViewer(target.project);
    const repository = yield* readRepositoryAccess(target);
    const row = yield* target.provider
      .getChangeRequest({ ...repositoryRef(target), number: key.number })
      .pipe(Effect.mapError(asServiceError("detail")));
    return toDetail({
      target,
      row,
      viewer,
      repository,
      capabilities: target.provider.capabilities,
    });
  });

  const loadActivity = Effect.fn("PullRequestService.loadActivity")(function* (
    key: PullRequestCacheKey,
  ) {
    const target = yield* requireTarget("activity", key.projectId, key.repository);
    return yield* target.provider
      .getChangeRequestActivity({ ...repositoryRef(target), number: key.number })
      .pipe(Effect.mapError(asServiceError("activity")));
  });

  const loadDiff = Effect.fn("PullRequestService.loadDiff")(function* (key: PullRequestCacheKey) {
    const target = yield* requireTarget("diff", key.projectId, key.repository);
    yield* requireCapability({
      operation: "diff",
      allowed: target.provider.capabilities.diff,
      detail: "This host cannot show a diff.",
    });
    return yield* target.provider
      .getDiff({ ...repositoryRef(target), number: key.number })
      .pipe(Effect.mapError(asServiceError("diff")));
  });

  const detailCache = yield* Cache.make({
    capacity: PULL_REQUEST_CACHE_CAPACITY,
    timeToLive: DETAIL_CACHE_TTL,
    lookup: (key: string) => loadDetail(parsePullRequestCacheKey(key)),
  });

  const activityCache = yield* Cache.make({
    capacity: PULL_REQUEST_CACHE_CAPACITY,
    timeToLive: ACTIVITY_CACHE_TTL,
    lookup: (key: string) => loadActivity(parsePullRequestCacheKey(key)),
  });

  const diffCache = yield* Cache.make({
    capacity: PULL_REQUEST_CACHE_CAPACITY,
    timeToLive: DIFF_CACHE_TTL,
    lookup: (key: string) => loadDiff(parsePullRequestCacheKey(key)),
  });

  /** Validates the reference, then serves the read through its cache. */
  const cachedRead = <A>(input: {
    readonly operation: string;
    readonly cache: Cache.Cache<string, A, PullRequestServiceError>;
    readonly reference: PullRequestRef;
    readonly force: boolean;
    /** What else a forced read drops, for a read that folds in another cache. */
    readonly alsoInvalidate?: (target: PullRequestTarget) => Effect.Effect<void>;
  }) =>
    resolveReference(input.operation, input.reference).pipe(
      Effect.flatMap((target) => {
        const key = pullRequestCacheKey({
          projectId: target.project.projectId,
          repository: target.repository,
          number: input.reference.number,
        });
        return (
          input.force
            ? Cache.invalidate(input.cache, key).pipe(
                Effect.andThen(input.alsoInvalidate?.(target) ?? Effect.void),
              )
            : Effect.void
        ).pipe(Effect.andThen(Cache.get(input.cache, key)));
      }),
    );

  /** Everything cached about one pull request's own reads. */
  const invalidatePullRequest = (target: PullRequestTarget, number: number) =>
    Effect.gen(function* () {
      const key = pullRequestCacheKey({
        projectId: target.project.projectId,
        repository: target.repository,
        number,
      });
      yield* Cache.invalidate(detailCache, key);
      yield* Cache.invalidate(activityCache, key);
    });

  /**
   * The method the host will accept: the caller's when the repository allows it,
   * the repository's first allowed one otherwise. Refusing here keeps a
   * disallowed merge from reaching the host at all.
   */
  const resolveMergeMethod = (
    target: PullRequestTarget,
    requested: PullRequestMergeMethod | undefined,
  ) =>
    readRepositoryAccess(target).pipe(
      Effect.flatMap((repository) => {
        const method = requested ?? repository.mergeMethods[0];
        if (method === undefined) {
          return Effect.fail(
            new PullRequestServiceError({
              operation: "runAction",
              detail: "This repository does not allow any merge method.",
            }),
          );
        }
        return repository.mergeMethods.includes(method)
          ? Effect.succeed(method)
          : Effect.fail(
              new PullRequestServiceError({
                operation: "runAction",
                detail: `This repository does not allow a ${method} merge.`,
              }),
            );
      }),
    );

  /** A forced detail read is also how the repository's settings are refreshed. */
  const readDetail = (input: PullRequestDetailInput) =>
    cachedRead({
      operation: "detail",
      cache: detailCache,
      reference: input,
      force: input.force === true,
      alsoInvalidate: (target) =>
        Cache.invalidate(
          repositoryCache,
          repositoryCacheKey({
            projectId: target.project.projectId,
            repository: target.repository,
          }),
        ),
    });

  /** A write that changes what a list row says drops every cached listing. */
  const invalidateAfterWrite = (input: {
    readonly target: PullRequestTarget;
    readonly number: number;
    readonly lists: boolean;
  }) =>
    invalidatePullRequest(input.target, input.number).pipe(
      Effect.andThen(input.lists ? Cache.invalidateAll(listCache) : Effect.void),
    );

  return PullRequestService.of({
    list: (input) =>
      Effect.suspend(() => {
        const key = listCacheKey({
          state: input.state,
          includeAuthored: input.includeAuthored !== false,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        });
        return (input.force === true ? Cache.invalidate(listCache, key) : Effect.void).pipe(
          Effect.andThen(Cache.get(listCache, key)),
        );
      }),
    detail: readDetail,
    activity: (input) =>
      cachedRead({
        operation: "activity",
        cache: activityCache,
        reference: input,
        force: input.force === true,
      }),
    diff: (input) =>
      cachedRead({
        operation: "diff",
        cache: diffCache,
        reference: input,
        force: input.force === true,
      }),
    comment: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("comment", input);
        yield* requireCapability({
          operation: "comment",
          allowed: target.provider.capabilities.comment,
          detail: "This host cannot take a comment.",
        });

        const result = yield* target.provider
          .comment({ ...repositoryRef(target), number: input.number, body: input.body })
          .pipe(Effect.mapError(asServiceError("comment")));

        // The comment is now part of this pull request and of every listing's
        // updated time, so nothing cached about it is still true.
        yield* invalidateAfterWrite({ target, number: input.number, lists: true });
        return result;
      }),
    runAction: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("runAction", input);
        const capabilities = target.provider.capabilities;
        yield* requireCapability({
          operation: "runAction",
          allowed: capabilities.actions.includes(input.action),
          detail: `This host cannot ${input.action.replace(/-/g, " ")} a pull request.`,
        });

        const needsMergeMethod = input.action === "merge" || input.action === "enable-auto-merge";
        const mergeMethod = needsMergeMethod
          ? yield* resolveMergeMethod(target, input.mergeMethod)
          : undefined;

        if (input.action === "update-branch" && input.updateMethod !== undefined) {
          yield* requireCapability({
            operation: "runAction",
            allowed: capabilities.updateMethods.includes(input.updateMethod),
            detail: `This host cannot update a branch by ${input.updateMethod}.`,
          });
        }

        yield* target.provider
          .runAction({
            ...repositoryRef(target),
            number: input.number,
            action: input.action,
            ...(mergeMethod === undefined ? {} : { mergeMethod }),
            ...(input.updateMethod === undefined ? {} : { updateMethod: input.updateMethod }),
            ...(input.deleteBranch === undefined ? {} : { deleteBranch: input.deleteBranch }),
          })
          .pipe(Effect.mapError(asServiceError("runAction")));

        // The action moved the pull request's own state, which every listing
        // renders, so nothing cached about it is still true.
        yield* invalidateAfterWrite({ target, number: input.number, lists: true });

        // Read back through the service's own path, so the answer and the cache
        // the client reads next are the same fresh detail.
        const detail = yield* readDetail({
          projectId: input.projectId,
          repository: input.repository,
          number: input.number,
        });
        return { state: detail.state, isDraft: detail.isDraft } satisfies PullRequestActionResult;
      }),
    submitReview: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("submitReview", input);
        const review = target.provider.capabilities.review;
        yield* requireCapability({
          operation: "submitReview",
          allowed: review.verdicts.includes(input.verdict),
          detail: "This host cannot take that review verdict.",
        });
        yield* requireCapability({
          operation: "submitReview",
          allowed: input.comments.length === 0 || review.inlineComment,
          detail: "This host cannot take comments on diff lines.",
        });

        const body = input.body.trim();
        // The host rejects these without anything to say; saying so here costs
        // no round trip. A line comment is itself something to say.
        if (body.length === 0 && input.comments.length === 0 && input.verdict !== "approve") {
          return yield* Effect.fail(
            new PullRequestServiceError({
              operation: "submitReview",
              detail:
                input.verdict === "request-changes"
                  ? "Requesting changes needs a comment."
                  : "A review comment needs a body.",
            }),
          );
        }

        const result = yield* target.provider
          .submitReview({
            ...repositoryRef(target),
            number: input.number,
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          })
          .pipe(Effect.mapError(asServiceError("submitReview")));

        // A verdict changes the review decision the list rows show.
        yield* invalidateAfterWrite({ target, number: input.number, lists: true });
        return result;
      }),
    replyToThread: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("replyToThread", input);
        yield* requireCapability({
          operation: "replyToThread",
          allowed: target.provider.capabilities.review.reply,
          detail: "This host cannot reply to a review conversation.",
        });

        yield* target.provider
          .replyToThread({
            ...repositoryRef(target),
            number: input.number,
            threadId: input.threadId,
            body: input.body,
          })
          .pipe(Effect.mapError(asServiceError("replyToThread")));

        yield* invalidateAfterWrite({ target, number: input.number, lists: true });
      }),
    setThreadResolution: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("setThreadResolution", input);
        yield* requireCapability({
          operation: "setThreadResolution",
          allowed: target.provider.capabilities.review.resolve,
          detail: "This host cannot resolve a review conversation.",
        });

        yield* target.provider
          .setThreadResolution({
            ...repositoryRef(target),
            number: input.number,
            threadId: input.threadId,
            resolved: input.resolved,
          })
          .pipe(Effect.mapError(asServiceError("setThreadResolution")));

        // Resolving changes the conversation, not what any list row says.
        yield* invalidateAfterWrite({ target, number: input.number, lists: false });
      }),
    setReaction: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("setReaction", input);
        yield* requireCapability({
          operation: "setReaction",
          allowed: target.provider.capabilities.reactions,
          detail: "This host cannot take reactions.",
        });

        yield* target.provider
          .setReaction({
            ...repositoryRef(target),
            number: input.number,
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            content: input.content,
            reacted: input.reacted,
          })
          .pipe(Effect.mapError(asServiceError("setReaction")));

        yield* invalidateAfterWrite({ target, number: input.number, lists: false });
      }),
    update: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("update", input);
        yield* requireCapability({
          operation: "update",
          allowed: target.provider.capabilities.edit.pullRequest,
          detail: "This host cannot rewrite a pull request.",
        });
        // A host asked to change nothing answers differently on each of them.
        if (input.title === undefined && input.body === undefined) {
          return yield* Effect.fail(
            new PullRequestServiceError({
              operation: "update",
              detail: "A change needs a title or a description.",
            }),
          );
        }

        yield* target.provider
          .updateChangeRequest({
            ...repositoryRef(target),
            number: input.number,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          })
          .pipe(Effect.mapError(asServiceError("update")));

        // The title is on every list row.
        yield* invalidateAfterWrite({ target, number: input.number, lists: true });
      }),
    updateComment: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("updateComment", input);
        yield* requireCapability({
          operation: "updateComment",
          allowed: target.provider.capabilities.edit.comment,
          detail: "This host cannot rewrite a comment.",
        });

        yield* target.provider
          .updateComment({
            ...repositoryRef(target),
            number: input.number,
            commentId: input.commentId,
            kind: input.kind,
            body: input.body,
          })
          .pipe(Effect.mapError(asServiceError("updateComment")));

        yield* invalidateAfterWrite({ target, number: input.number, lists: false });
      }),
    reviewerCandidates: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("reviewerCandidates", input);
        yield* requireCapability({
          operation: "reviewerCandidates",
          allowed: target.provider.capabilities.reviewers.listCandidates,
          detail: "This host cannot list the people you may ask for a review.",
        });

        return yield* target.provider
          .listReviewerCandidates({ ...repositoryRef(target), number: input.number })
          .pipe(Effect.mapError(asServiceError("reviewerCandidates")));
      }),
    requestReviewers: (input) =>
      Effect.gen(function* () {
        const target = yield* resolveReference("requestReviewers", input);
        yield* requireCapability({
          operation: "requestReviewers",
          allowed: target.provider.capabilities.reviewers.request,
          detail: "This host cannot ask for a review.",
        });
        if (input.reviewers.length === 0) {
          return yield* Effect.fail(
            new PullRequestServiceError({
              operation: "requestReviewers",
              detail: "Name at least one reviewer.",
            }),
          );
        }

        yield* target.provider
          .setReviewerRequest({
            ...repositoryRef(target),
            number: input.number,
            reviewers: input.reviewers,
            requested: input.requested,
          })
          .pipe(Effect.mapError(asServiceError("requestReviewers")));

        // A pending request is what the list rows call "review requested".
        yield* invalidateAfterWrite({ target, number: input.number, lists: true });
      }),
  });
});

export const layer = Layer.effect(PullRequestService, make());
