import type {
  EnvironmentId,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
  PullRequestListState,
} from "@threadlines/contracts";

import type { Project, SidebarThreadSummary } from "../../types";

/**
 * A listing row plus the environment it came from. The wire type leaves the
 * environment implicit because one call only ever covers one server, and the
 * page merges several.
 */
export type PullRequestEntry = PullRequestListEntry & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
};

/** A project the host refused to list, scoped the same way as an entry. */
export type PullRequestProjectFailure = PullRequestListProjectError & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
};

/** The reasons a row is put in front of the user, in priority order. */
export type PullRequestNeedsYouReason =
  | "Review requested"
  | "Changes requested"
  | "Checks failing"
  | "Approved";

export type PullRequestGroupId = "needs-you" | "yours" | "others" | "all";

export interface PullRequestGroup {
  readonly id: PullRequestGroupId;
  /** Null when the list is one flat group, where a heading would say nothing. */
  readonly label: string | null;
  readonly entries: readonly PullRequestEntry[];
}

export interface PullRequestsSearch {
  readonly state: PullRequestListState;
}

/** The route's `state` param. Anything unrecognised lands on the Open tab. */
export function parsePullRequestsSearch(search: Record<string, unknown>): PullRequestsSearch {
  const state = search["state"];
  return { state: state === "merged" || state === "closed" ? state : "open" };
}

/**
 * Identifies one row across environments and repositories. The project is
 * deliberately left out: a checkout and its worktrees are separate projects on
 * one remote, and the pull request is the same one from any of them.
 */
export function pullRequestEntryKey(entry: PullRequestEntry): string {
  return `${entry.environmentId}:${repositoryKey(entry.repository)}:${entry.number}`;
}

/** GitHub repository names are case-insensitive, so comparisons are too. */
function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}

/** `owner/name` for a project that has a resolved GitHub remote, else null. */
export function projectRepository(project: Project): string | null {
  const identity = project.repositoryIdentity;
  if (identity == null || identity.provider !== "github") {
    return null;
  }
  const owner = identity.owner?.trim() ?? "";
  const name = identity.name?.trim() ?? "";
  return owner.length > 0 && name.length > 0 ? `${owner}/${name}` : null;
}

function updatedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byUpdatedAtDesc(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return updatedAtMs(right.updatedAt) - updatedAtMs(left.updatedAt);
}

function threadActivityMs(thread: SidebarThreadSummary): number {
  return updatedAtMs(thread.updatedAt ?? thread.createdAt);
}

/**
 * One listing per environment, merged into the page's row list.
 *
 * The state filter is defensive: a host can answer a "closed" listing with a
 * merged row, and a row under the wrong tab reads as a bug in the page.
 */
export function mergePullRequestListResults(input: {
  readonly state: PullRequestListState;
  readonly results: readonly {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly data: PullRequestListResult | undefined;
  }[];
}): {
  readonly entries: readonly PullRequestEntry[];
  readonly failures: readonly PullRequestProjectFailure[];
  readonly viewer: string | null;
} {
  const entries: PullRequestEntry[] = [];
  const failures: PullRequestProjectFailure[] = [];
  let viewer: string | null = null;

  for (const result of input.results) {
    if (!result.data) continue;
    viewer ??= result.data.viewer;
    for (const entry of result.data.entries) {
      if (entry.state !== input.state) continue;
      entries.push({
        ...entry,
        environmentId: result.environmentId,
        environmentLabel: result.environmentLabel,
      });
    }
    for (const failure of result.data.errors) {
      failures.push({
        ...failure,
        environmentId: result.environmentId,
        environmentLabel: result.environmentLabel,
      });
    }
  }

  return { entries, failures, viewer };
}

/**
 * The threads working each pull request, keyed by {@link pullRequestEntryKey}.
 *
 * A thread counts when its project points at the pull request's repository on
 * the same environment and it is checked out on the head branch. Matching by
 * repository rather than project lets a thread in a worktree project claim the
 * row its sibling checkout produced. Archived threads are past work, so they
 * never claim a row.
 */
export function linkThreadsToPullRequests(
  entries: readonly PullRequestEntry[],
  threads: readonly SidebarThreadSummary[],
  projects: readonly Project[],
): ReadonlyMap<string, readonly SidebarThreadSummary[]> {
  const linked = new Map<string, SidebarThreadSummary[]>();
  if (entries.length === 0) {
    return linked;
  }

  const repositoryByProject = new Map<string, string>();
  for (const project of projects) {
    const repository = projectRepository(project);
    if (repository !== null) {
      repositoryByProject.set(`${project.environmentId}:${project.id}`, repositoryKey(repository));
    }
  }
  const candidates = threads.flatMap((thread) => {
    if (thread.archivedAt !== null || thread.branch === null) {
      return [];
    }
    const repository = repositoryByProject.get(`${thread.environmentId}:${thread.projectId}`);
    return repository === undefined ? [] : [{ thread, repository }];
  });
  for (const entry of entries) {
    const entryRepository = repositoryKey(entry.repository);
    const matches = candidates.flatMap((candidate) =>
      candidate.thread.environmentId === entry.environmentId &&
      candidate.repository === entryRepository &&
      candidate.thread.branch === entry.headBranch
        ? [candidate.thread]
        : [],
    );
    if (matches.length === 0) continue;
    linked.set(
      pullRequestEntryKey(entry),
      matches.toSorted((left, right) => threadActivityMs(right) - threadActivityMs(left)),
    );
  }

  return linked;
}

/**
 * Why this row is waiting on the user, or null when it is only news. First
 * match wins so a row states one thing rather than a list of conditions.
 */
export function resolveNeedsYouReason(entry: PullRequestEntry): PullRequestNeedsYouReason | null {
  if (entry.state !== "open") {
    return null;
  }
  if (entry.viewerReviewRequested) {
    return "Review requested";
  }
  if (!entry.viewerIsAuthor) {
    return null;
  }
  if (entry.reviewDecision === "changes-requested") {
    return "Changes requested";
  }
  if (entry.checksState === "failure") {
    return "Checks failing";
  }
  if (entry.reviewDecision === "approved" && !entry.isDraft) {
    return "Approved";
  }
  return null;
}

/** How many open rows are waiting on the user. Drives the sidebar count. */
export function countNeedsYou(entries: readonly PullRequestEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (resolveNeedsYouReason(entry) !== null) {
      count += 1;
    }
  }
  return count;
}

/**
 * The open list answers "what needs me" first, then the user's own work, then
 * everything else; a row belongs to exactly one group. Without a signed-in
 * viewer none of that is knowable, so the list stays flat, as it does for the
 * merged and closed tabs where the question does not apply.
 */
export function groupPullRequests(input: {
  readonly entries: readonly PullRequestEntry[];
  readonly viewer: string | null;
  readonly state: PullRequestListState;
}): readonly PullRequestGroup[] {
  const sorted = input.entries.toSorted(byUpdatedAtDesc);
  if (input.state !== "open" || input.viewer === null) {
    return sorted.length === 0 ? [] : [{ id: "all", label: null, entries: sorted }];
  }

  const needsYou: PullRequestEntry[] = [];
  const yours: PullRequestEntry[] = [];
  const others: PullRequestEntry[] = [];
  for (const entry of sorted) {
    if (resolveNeedsYouReason(entry) !== null) {
      needsYou.push(entry);
    } else if (entry.viewerIsAuthor) {
      yours.push(entry);
    } else {
      others.push(entry);
    }
  }

  return (
    [
      { id: "needs-you", label: "Needs you", entries: needsYou },
      { id: "yours", label: "Yours", entries: yours },
      { id: "others", label: "Others", entries: others },
    ] as const
  ).filter((group) => group.entries.length > 0);
}

/**
 * Local search over what the row already shows plus what a user would type
 * looking for it. Words are ANDed so typing more narrows.
 */
export function matchesPullRequestQuery(entry: PullRequestEntry, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return true;
  }
  const haystack = entryHaystack(entry);
  return words.every((word) => haystack.includes(word));
}

function entryHaystack(entry: PullRequestEntry): string {
  return [
    entry.title,
    `#${entry.number}`,
    String(entry.number),
    entry.author?.login ?? "",
    entry.headBranch,
    entry.repository,
    ...entry.labels.map((label) => label.name),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Which optional columns the second line earns. A repository or an environment
 * name is only worth the space when the list actually spans more than one.
 */
export function resolvePullRequestListSpan(entries: readonly PullRequestEntry[]): {
  readonly multipleRepositories: boolean;
  readonly multipleEnvironments: boolean;
} {
  const repositories = new Set<string>();
  const environments = new Set<EnvironmentId>();
  for (const entry of entries) {
    repositories.add(entry.repository);
    environments.add(entry.environmentId);
  }
  return {
    multipleRepositories: repositories.size > 1,
    multipleEnvironments: environments.size > 1,
  };
}

/** Whether any workspace project could produce a GitHub listing at all. */
export function hasGitHubProject(projects: readonly Project[]): boolean {
  return projects.some((project) => projectRepository(project) !== null);
}

/**
 * True when nothing came back and every project failed for a reason the user
 * fixes by signing the server's `gh` in, which is a different page from an
 * empty list.
 */
export function requiresGitHubSignIn(input: {
  readonly entries: readonly PullRequestEntry[];
  readonly failures: readonly PullRequestProjectFailure[];
}): boolean {
  return (
    input.entries.length === 0 &&
    input.failures.length > 0 &&
    input.failures.every(
      (failure) => failure.reason === "missing-tool" || failure.reason === "unauthenticated",
    )
  );
}
