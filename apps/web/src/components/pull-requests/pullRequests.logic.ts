import { EnvironmentId, ProjectId } from "@threadlines/contracts";
import type {
  PullRequestActivity,
  PullRequestActor,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewDecision,
  PullRequestReviewPosition,
  PullRequestReviewState,
  PullRequestState,
  PullRequestUpdateMethod,
  SourceControlProviderKind,
  VcsStatusResult,
} from "@threadlines/contracts";
import {
  changeRequestRepositoryName,
  toChangeRequestProviderKind,
} from "@threadlines/shared/sourceControl";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";

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

/** Which pull request the page has open beside the list. */
export interface PullRequestSelection {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly number: number;
}

/** Whether the list keeps drafts, only drafts, or none of them. */
export type PullRequestDraftFilter = "any" | "only" | "hide";
/** `none` is a row no reviewer has answered on yet, which the host omits. */
export type PullRequestReviewFilter = "any" | "none" | PullRequestReviewDecision;
export type PullRequestChecksFilter = "any" | "passing" | "failing" | "running";
/** The same three groups the open list heads, as a narrowing of its own. */
export type PullRequestInvolvementFilter = "all" | "needs-you" | "yours" | "others";
export type PullRequestSort =
  | "readiness"
  | "updated"
  | "newest"
  | "oldest"
  | "largest"
  | "smallest";

/**
 * What the Filters menu holds. The two text fields keep the user's own
 * spelling rather than a parsed list, so the URL, the field and the chips all
 * agree and typing a comma is never undone underneath the cursor.
 */
export interface PullRequestFilters {
  readonly involvement: PullRequestInvolvementFilter;
  readonly author: string;
  /** Comma separated; a row must carry every one of them. */
  readonly labels: string;
  readonly draft: PullRequestDraftFilter;
  readonly review: PullRequestReviewFilter;
  readonly checks: PullRequestChecksFilter;
  /** One project, spelled {@link pullRequestProjectKey}; empty for all of them. */
  readonly project: string;
}

export const EMPTY_PULL_REQUEST_FILTERS: PullRequestFilters = {
  involvement: "all",
  author: "",
  labels: "",
  draft: "any",
  review: "any",
  checks: "any",
  project: "",
};

export const DEFAULT_PULL_REQUEST_SORT: PullRequestSort = "updated";

export interface PullRequestsSearch {
  readonly state: PullRequestListState;
  /** `<environmentId>:<projectId>:<number>`, absent when the list is alone. */
  readonly pr?: string;
  readonly author?: string;
  readonly labels?: string;
  readonly project?: string;
  /** Absent while the filter is off, so a plain link stays plain. */
  readonly involvement?: Exclude<PullRequestInvolvementFilter, "all">;
  readonly draft?: Exclude<PullRequestDraftFilter, "any">;
  readonly review?: Exclude<PullRequestReviewFilter, "any">;
  readonly checks?: Exclude<PullRequestChecksFilter, "any">;
  readonly sort?: Exclude<PullRequestSort, "updated">;
}

/**
 * The route's params. Anything unrecognised falls back to the resting value
 * rather than being rendered as a filter nobody asked for: a hand-edited link
 * lands on the Open tab with the full list.
 */
export function parsePullRequestsSearch(search: Record<string, unknown>): PullRequestsSearch {
  const state = search["state"];
  const pr = search["pr"];
  const selection = typeof pr === "string" ? parsePullRequestSelection(pr) : null;
  const involvement = search["involvement"];
  const draft = search["draft"];
  const review = search["review"];
  const checks = search["checks"];
  const sort = parseSort(search["sort"]);
  return {
    state: state === "merged" || state === "closed" ? state : "open",
    ...(selection ? { pr: formatPullRequestSelection(selection) } : {}),
    ...searchText(search["author"], "author"),
    ...searchText(search["labels"], "labels"),
    ...searchText(search["project"], "project"),
    ...(involvement === "needs-you" || involvement === "yours" || involvement === "others"
      ? { involvement }
      : {}),
    ...(draft === "only" || draft === "hide" ? { draft } : {}),
    ...(review === "approved" ||
    review === "changes-requested" ||
    review === "review-required" ||
    review === "none"
      ? { review }
      : {}),
    ...(checks === "passing" || checks === "failing" || checks === "running" ? { checks } : {}),
    ...(sort === null ? {} : { sort }),
  };
}

/**
 * The sort a link asks for. The first spelling of this page offered `created`
 * and `size`, which are now the first of a pair each, so an old link lands on
 * the sort it used to mean rather than on the default.
 */
function parseSort(value: unknown): Exclude<PullRequestSort, "updated"> | null {
  if (value === "created") return "newest";
  if (value === "size") return "largest";
  return value === "readiness" ||
    value === "newest" ||
    value === "oldest" ||
    value === "largest" ||
    value === "smallest"
    ? value
    : null;
}

/** One text param, dropped when it is missing or says nothing. */
function searchText<Key extends string>(value: unknown, key: Key): Partial<Record<Key, string>> {
  if (typeof value !== "string") {
    return {};
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? {} : ({ [key]: trimmed } as Partial<Record<Key, string>>);
}

export function pullRequestFiltersFromSearch(search: PullRequestsSearch): PullRequestFilters {
  return {
    involvement: search.involvement ?? "all",
    author: search.author ?? "",
    labels: search.labels ?? "",
    draft: search.draft ?? "any",
    review: search.review ?? "any",
    checks: search.checks ?? "any",
    project: search.project ?? "",
  };
}

/** The params a set of filters and a sort write back, resting values omitted. */
export function pullRequestFiltersToSearch(
  filters: PullRequestFilters,
  sort: PullRequestSort,
): Omit<PullRequestsSearch, "state" | "pr"> {
  return {
    ...searchText(filters.author, "author"),
    ...searchText(filters.labels, "labels"),
    ...searchText(filters.project, "project"),
    ...(filters.involvement === "all" ? {} : { involvement: filters.involvement }),
    ...(filters.draft === "any" ? {} : { draft: filters.draft }),
    ...(filters.review === "any" ? {} : { review: filters.review }),
    ...(filters.checks === "any" ? {} : { checks: filters.checks }),
    ...(sort === "updated" ? {} : { sort }),
  };
}

export function formatPullRequestSelection(selection: PullRequestSelection): string {
  return `${selection.environmentId}:${selection.projectId}:${selection.number}`;
}

/**
 * Read from the right, so an environment id carrying a colon of its own still
 * parses. A value that does not resolve to a positive number is dropped rather
 * than rendered as a broken selection.
 */
export function parsePullRequestSelection(value: string): PullRequestSelection | null {
  const lastSeparator = value.lastIndexOf(":");
  if (lastSeparator <= 0) {
    return null;
  }
  const projectSeparator = value.lastIndexOf(":", lastSeparator - 1);
  if (projectSeparator <= 0) {
    return null;
  }
  const environmentId = value.slice(0, projectSeparator);
  const projectId = value.slice(projectSeparator + 1, lastSeparator);
  const number = Number(value.slice(lastSeparator + 1));
  if (environmentId.length === 0 || projectId.length === 0) {
    return null;
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return {
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(projectId),
    number,
  };
}

/**
 * Identifies one row across environments and repositories. The project is
 * deliberately left out: a checkout and its worktrees are separate projects on
 * one remote, and the pull request is the same one from any of them.
 */
export function pullRequestEntryKey(entry: PullRequestEntry): string {
  return `${entry.environmentId}:${repositoryKey(entry.repository)}:${entry.number}`;
}

/** Repository names are case-insensitive on every host here, so comparisons are too. */
function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}

/**
 * The repository name the server lists this project under, or null when its
 * remote is not one we can read pull requests from.
 */
export function projectRepository(project: Project): string | null {
  return changeRequestRepositoryName(project.repositoryIdentity);
}

/** The host a project's remote sits on, or null when it has none we can read. */
export function projectProviderKind(project: Project): SourceControlProviderKind | null {
  return toChangeRequestProviderKind(project.repositoryIdentity?.provider);
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
 *
 * An authored row is on a repository no project here points at, and the project
 * it names is only the checkout its host tool runs in, so no thread is working
 * it and none is offered.
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
    if (entry.origin === "authored") continue;
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

/** How one pull request state reads: its glyph, its colour, and its word. */
export interface PullRequestBadgeTone {
  readonly Icon: typeof GitPullRequestIcon;
  readonly className: string;
  readonly label: string;
}

/**
 * The one table for open, draft, merged and closed. The list row, the detail
 * header and the sidebar thread badge all read from it, so a state that is
 * violet in one place is never emerald in another.
 */
export function pullRequestBadgeTone(
  state: PullRequestState,
  isDraft: boolean,
): PullRequestBadgeTone {
  if (state === "merged") {
    return {
      Icon: GitMergeIcon,
      className: "text-violet-600 dark:text-violet-300/90",
      label: "Merged",
    };
  }
  if (state === "closed") {
    return {
      Icon: GitPullRequestClosedIcon,
      className: "text-zinc-500 dark:text-zinc-400/80",
      label: "Closed",
    };
  }
  if (isDraft) {
    return { Icon: GitPullRequestDraftIcon, className: "text-muted-foreground/60", label: "Draft" };
  }
  return {
    Icon: GitPullRequestIcon,
    className: "text-emerald-600 dark:text-emerald-300/90",
    label: "Open",
  };
}

/** The pull request a thread is working on, as its badge and its tab need it. */
export interface ThreadPullRequest {
  readonly number: number;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly title: string;
  readonly url: string;
  /** The repository name, or null when the project sits on a host we cannot
   *  read. The detail surface needs it; the badge does not. */
  readonly repository: string | null;
}

/** The thread fields both the sidebar summary and the full thread record carry. */
export interface ThreadPullRequestSubject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly archivedAt: string | null;
}

/**
 * What the checkout itself reports, when it is standing on the thread's own
 * branch. This is the only source that knows a pull request was merged or
 * closed: the open listing stops carrying it the moment it settles.
 */
export function pullRequestFromGitStatus(
  branch: string | null,
  gitStatus: VcsStatusResult | null,
  repository: string | null = null,
): ThreadPullRequest | null {
  if (branch === null || gitStatus === null || gitStatus.refName !== branch || !gitStatus.pr) {
    return null;
  }
  return {
    number: gitStatus.pr.number,
    state: gitStatus.pr.state,
    // The status read carries no draft flag, and a draft that reads as open is
    // a smaller lie than an open one that reads as a draft.
    isDraft: false,
    title: gitStatus.pr.title,
    url: gitStatus.pr.url,
    repository,
  };
}

/**
 * Which pull request a thread is working on: the checkout's own status first,
 * then the open listing, then the merged and closed ones. The listings cover a
 * thread whose checkout is standing somewhere else, or whose status has not
 * arrived yet; the settled ones are the only way such a thread ever learns its
 * branch landed, since the open listing simply stops carrying it.
 */
export function resolveThreadPullRequest(input: {
  readonly thread: ThreadPullRequestSubject;
  readonly gitStatus: VcsStatusResult | null;
  readonly openEntries: readonly PullRequestEntry[];
  /** Merged and closed rows, consulted only when the open ones say nothing. */
  readonly settledEntries?: readonly PullRequestEntry[];
  readonly projects: readonly Project[];
}): ThreadPullRequest | null {
  const { thread } = input;
  if (thread.branch === null || thread.archivedAt !== null) {
    return null;
  }
  const project = input.projects.find(
    (candidate) =>
      candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
  );
  if (!project || project.kind === "general-chat") {
    return null;
  }
  const repository = projectRepository(project);

  const fromStatus = pullRequestFromGitStatus(thread.branch, input.gitStatus, repository);
  if (fromStatus) {
    return fromStatus;
  }
  if (repository === null) {
    return null;
  }

  const entry =
    findThreadListEntry(thread, repository, input.openEntries) ??
    findThreadListEntry(thread, repository, input.settledEntries ?? []);
  if (!entry) {
    return null;
  }
  return {
    number: entry.number,
    state: entry.state,
    isDraft: entry.isDraft,
    title: entry.title,
    url: entry.url,
    repository: entry.repository,
  };
}

/**
 * The listing row for a thread's branch on its own repository and computer. An
 * authored row is on a repository no project here points at, so it is never a
 * thread's own work however its branch happens to be spelled.
 */
function findThreadListEntry(
  thread: ThreadPullRequestSubject,
  repository: string,
  entries: readonly PullRequestEntry[],
): PullRequestEntry | undefined {
  const entryRepository = repositoryKey(repository);
  return entries.find(
    (candidate) =>
      candidate.origin !== "authored" &&
      candidate.environmentId === thread.environmentId &&
      repositoryKey(candidate.repository) === entryRepository &&
      candidate.headBranch === thread.branch,
  );
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

/** Which of the open list's three groups a row belongs to. */
export function pullRequestInvolvement(
  entry: PullRequestEntry,
): Exclude<PullRequestInvolvementFilter, "all"> {
  if (resolveNeedsYouReason(entry) !== null) {
    return "needs-you";
  }
  return entry.viewerIsAuthor ? "yours" : "others";
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
  /** The order inside every group; the last update when nothing is asked for. */
  readonly sort?: PullRequestSort;
  /**
   * The involvement the list is already narrowed to. Only one group can be
   * left, and heading a list with the filter the user just set says nothing.
   */
  readonly involvement?: PullRequestInvolvementFilter;
}): readonly PullRequestGroup[] {
  const sorted = sortPullRequests(input.entries, input.sort ?? DEFAULT_PULL_REQUEST_SORT);
  if (
    input.state !== "open" ||
    input.viewer === null ||
    (input.involvement !== undefined && input.involvement !== "all")
  ) {
    return sorted.length === 0 ? [] : [{ id: "all", label: null, entries: sorted }];
  }

  const needsYou: PullRequestEntry[] = [];
  const yours: PullRequestEntry[] = [];
  const others: PullRequestEntry[] = [];
  const byInvolvement = { "needs-you": needsYou, yours, others } as const;
  for (const entry of sorted) {
    byInvolvement[pullRequestInvolvement(entry)].push(entry);
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

/** A comma separated field as the list of names it stands for. */
function parseNameList(value: string): readonly string[] {
  return value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/**
 * The filters the page applies after its search and before its groups. Every
 * one of them narrows, so an empty field or an "any" choice says nothing at
 * all; a row has to satisfy all of them at once.
 */
export function narrowPullRequests(
  entries: readonly PullRequestEntry[],
  filters: PullRequestFilters,
): readonly PullRequestEntry[] {
  const author = filters.author.trim().toLowerCase();
  const included = parseNameList(filters.labels);
  const project = filters.project.trim();
  if (
    filters.involvement === "all" &&
    author.length === 0 &&
    included.length === 0 &&
    project.length === 0 &&
    filters.draft === "any" &&
    filters.review === "any" &&
    filters.checks === "any"
  ) {
    return entries;
  }
  return entries.filter((entry) => {
    if (filters.involvement !== "all" && pullRequestInvolvement(entry) !== filters.involvement) {
      return false;
    }
    if (author.length > 0 && (entry.author?.login ?? "").toLowerCase() !== author) {
      return false;
    }
    if (included.length > 0) {
      const labels = new Set(entry.labels.map((label) => label.name.toLowerCase()));
      if (!included.every((name) => labels.has(name))) {
        return false;
      }
    }
    if (project.length > 0 && pullRequestProjectKey(entry) !== project) return false;
    if (filters.draft === "only" && !entry.isDraft) return false;
    if (filters.draft === "hide" && entry.isDraft) return false;
    if (filters.review === "none" && entry.reviewDecision !== undefined) return false;
    if (
      filters.review !== "any" &&
      filters.review !== "none" &&
      entry.reviewDecision !== filters.review
    ) {
      return false;
    }
    if (filters.checks === "passing" && entry.checksState !== "success") return false;
    if (filters.checks === "failing" && entry.checksState !== "failure") return false;
    if (filters.checks === "running" && entry.checksState !== "pending") return false;
    return true;
  });
}

function createdAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function entrySize(entry: PullRequestEntry): number {
  return entry.additions + entry.deletions;
}

/**
 * How close an open row is to being merged, smallest first. Read from the far
 * end: a draft is furthest away whatever else is true of it, then a row that
 * cannot merge at all, then one the checks or a reviewer turned down, then one
 * still running. What is left is waiting on a reviewer, and a row that is
 * approved and green is the next thing to merge.
 */
function readinessRank(entry: PullRequestEntry): number {
  if (entry.state !== "open") return 7;
  if (entry.isDraft) return 6;
  if (entry.mergeability === "conflicting") return 5;
  if (entry.checksState === "failure") return 4;
  if (entry.reviewDecision === "changes-requested") return 3;
  if (entry.checksState === "pending") return 2;
  if (entry.reviewDecision === "approved" && entry.checksState === "success") return 0;
  return 1;
}

/**
 * The list's order. Every sort falls back to the last update, so two rows that
 * tie never swap places between reads.
 */
export function sortPullRequests(
  entries: readonly PullRequestEntry[],
  sort: PullRequestSort,
): readonly PullRequestEntry[] {
  if (sort === "readiness") {
    return entries.toSorted(
      (left, right) => readinessRank(left) - readinessRank(right) || byUpdatedAtDesc(left, right),
    );
  }
  if (sort === "newest" || sort === "oldest") {
    const opened = (left: PullRequestEntry, right: PullRequestEntry) =>
      createdAtMs(right.createdAt) - createdAtMs(left.createdAt);
    return entries.toSorted(
      (left, right) =>
        (sort === "newest" ? opened(left, right) : opened(right, left)) ||
        byUpdatedAtDesc(left, right),
    );
  }
  if (sort === "largest" || sort === "smallest") {
    const sized = (left: PullRequestEntry, right: PullRequestEntry) =>
      entrySize(right) - entrySize(left);
    return entries.toSorted(
      (left, right) =>
        (sort === "largest" ? sized(left, right) : sized(right, left)) ||
        byUpdatedAtDesc(left, right),
    );
  }
  return entries.toSorted(byUpdatedAtDesc);
}

/** How each sort reads in the Sort menu, in the order it is offered. */
export const PULL_REQUEST_SORT_LABELS: Readonly<Record<PullRequestSort, string>> = {
  readiness: "Merge readiness",
  updated: "Recently updated",
  newest: "Newest",
  oldest: "Oldest",
  largest: "Largest",
  smallest: "Smallest",
};

/** One narrowing, as a line of text and the filters without it. */
export interface PullRequestFilterChip {
  readonly id: string;
  readonly label: string;
  readonly next: PullRequestFilters;
}

const DRAFT_CHIP_WORDS: Readonly<Record<Exclude<PullRequestDraftFilter, "any">, string>> = {
  only: "Drafts only",
  hide: "No drafts",
};

const REVIEW_CHIP_WORDS: Readonly<Record<Exclude<PullRequestReviewFilter, "any">, string>> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  "review-required": "Review required",
  none: "No reviews",
};

const CHECKS_CHIP_WORDS: Readonly<Record<Exclude<PullRequestChecksFilter, "any">, string>> = {
  passing: "Checks passing",
  failing: "Checks failing",
  running: "Checks running",
};

/** How each involvement reads, as a menu line and as a chip. */
export const PULL_REQUEST_INVOLVEMENT_WORDS: Readonly<
  Record<PullRequestInvolvementFilter, string>
> = {
  all: "All",
  "needs-you": "Needs you",
  yours: "Yours",
  others: "Others",
};

/**
 * Every narrowing in force, each carrying the filters it would leave behind.
 * The page can then render one row of removable chips without knowing how any
 * single filter is spelled.
 */
export function pullRequestFilterChips(
  filters: PullRequestFilters,
  /** What the chosen project is called; the key stands in until the rows arrive. */
  projectLabel?: string,
): readonly PullRequestFilterChip[] {
  const chips: PullRequestFilterChip[] = [];
  if (filters.involvement !== "all") {
    chips.push({
      id: "involvement",
      label: PULL_REQUEST_INVOLVEMENT_WORDS[filters.involvement],
      next: { ...filters, involvement: "all" },
    });
  }
  const author = filters.author.trim();
  if (author.length > 0) {
    chips.push({ id: "author", label: `Author: ${author}`, next: { ...filters, author: "" } });
  }
  for (const [index, name] of parseNameList(filters.labels).entries()) {
    chips.push({
      id: `label:${name}`,
      label: `Label: ${name}`,
      next: { ...filters, labels: withoutNameAt(filters.labels, index) },
    });
  }
  const project = filters.project.trim();
  if (project.length > 0) {
    chips.push({
      id: "project",
      label: `Project: ${projectLabel ?? project}`,
      next: { ...filters, project: "" },
    });
  }
  if (filters.draft !== "any") {
    chips.push({
      id: "draft",
      label: DRAFT_CHIP_WORDS[filters.draft],
      next: { ...filters, draft: "any" },
    });
  }
  if (filters.review !== "any") {
    chips.push({
      id: "review",
      label: REVIEW_CHIP_WORDS[filters.review],
      next: { ...filters, review: "any" },
    });
  }
  if (filters.checks !== "any") {
    chips.push({
      id: "checks",
      label: CHECKS_CHIP_WORDS[filters.checks],
      next: { ...filters, checks: "any" },
    });
  }
  return chips;
}

/**
 * A label's own colour, or nothing when the host did not give one we can
 * paint with. Hosts spell it as six hexadecimal characters, sometimes with the
 * `#` and sometimes without; anything else is not worth guessing at, and the
 * dot falls back to the muted fill it already wears.
 */
export function pullRequestLabelColor(color: string | null | undefined): string | null {
  const hex = color?.replace(/^#/u, "") ?? "";
  return /^[0-9a-f]{6}$/iu.test(hex) ? `#${hex}` : null;
}

/**
 * The words for a row whose branch no longer merges, or null when it does. A
 * draft is not ready to merge in the first place, so it says draft instead,
 * and a merged or closed row has nothing left to conflict with.
 */
export function pullRequestConflictLabel(entry: PullRequestEntry): string | null {
  return entry.state === "open" && !entry.isDraft && entry.mergeability === "conflicting"
    ? `Conflicts with ${entry.baseBranch}`
    : null;
}

/** One author the loaded rows have seen, and how many of them they wrote. */
export interface PullRequestAuthorFacet {
  readonly login: string;
  readonly avatarUrl: string | null;
  readonly count: number;
}

/**
 * The logins worth offering as an author filter, busiest first. Built from the
 * rows the page already holds, so opening the menu never costs a read; the
 * chosen author is kept even when this tab carries none of their work.
 */
export function pullRequestAuthorFacets(
  entries: readonly PullRequestEntry[],
): readonly PullRequestAuthorFacet[] {
  const byLogin = new Map<string, { login: string; avatarUrl: string | null; count: number }>();
  for (const entry of entries) {
    const author = entry.author;
    if (!author) continue;
    const seen = byLogin.get(author.login.toLowerCase());
    if (seen) {
      seen.count += 1;
      seen.avatarUrl ??= author.avatarUrl;
    } else {
      byLogin.set(author.login.toLowerCase(), {
        login: author.login,
        avatarUrl: author.avatarUrl,
        count: 1,
      });
    }
  }
  return [...byLogin.values()].toSorted(
    (left, right) => right.count - left.count || left.login.localeCompare(right.login),
  );
}

/** One label the loaded rows have seen, with the colour the host paints it. */
export interface PullRequestLabelFacet {
  readonly name: string;
  readonly color: string | null;
  readonly count: number;
}

/** The labels worth offering, most used first. */
export function pullRequestLabelFacets(
  entries: readonly PullRequestEntry[],
): readonly PullRequestLabelFacet[] {
  const byName = new Map<string, { name: string; color: string | null; count: number }>();
  for (const entry of entries) {
    for (const label of entry.labels) {
      const seen = byName.get(label.name.toLowerCase());
      if (seen) {
        seen.count += 1;
        seen.color ??= label.color;
      } else {
        byName.set(label.name.toLowerCase(), { name: label.name, color: label.color, count: 1 });
      }
    }
  }
  return [...byName.values()].toSorted(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
}

/** One project with pull requests in it, as the Project filter names it. */
export interface PullRequestProjectFacet {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

/**
 * A project across environments: two computers can hold the same project id,
 * and they are not the same checkout.
 */
export function pullRequestProjectKey(entry: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): string {
  return `${entry.environmentId}:${entry.projectId}`;
}

/** The projects the loaded rows came from, alphabetically. */
export function pullRequestProjectFacets(
  entries: readonly PullRequestEntry[],
): readonly PullRequestProjectFacet[] {
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const entry of entries) {
    const key = pullRequestProjectKey(entry);
    const seen = byKey.get(key);
    if (seen) {
      seen.count += 1;
    } else {
      byKey.set(key, { key, label: entry.projectTitle, count: 1 });
    }
  }
  return [...byKey.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

/** The field with one of its names lifted out, respelled as a plain list. */
function withoutNameAt(value: string, index: number): string {
  return parseNameList(value)
    .filter((_, position) => position !== index)
    .join(", ");
}

/**
 * The labels field with one name added or taken out, which is what a checklist
 * of labels writes back. Names are compared the way the filter reads them, so
 * a differently cased label never lands in the list twice.
 */
export function togglePullRequestLabel(value: string, name: string): string {
  const names = parseNameList(value);
  const target = name.trim().toLowerCase();
  return names.includes(target)
    ? names.filter((entry) => entry !== target).join(", ")
    : [...names, target].join(", ");
}

/** Whether the labels field already asks for this name. */
export function hasPullRequestLabel(value: string, name: string): boolean {
  return parseNameList(value).includes(name.trim().toLowerCase());
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

/** Whether any workspace project sits on a host we can list pull requests from. */
export function hasPullRequestProject(projects: readonly Project[]): boolean {
  return projects.some((project) => projectRepository(project) !== null);
}

/**
 * True when nothing came back and every project failed for a reason the user
 * fixes by signing the server's own tool in, which is a different page from an
 * empty list.
 */
export function requiresHostSignIn(input: {
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

/**
 * The one host every failing project sits on, so the sign-in page can name the
 * tool to sign in with. Null when the failures span more than one host, or when
 * no project answers for them, which leaves the copy speaking generally.
 */
export function resolveSignInHost(input: {
  readonly failures: readonly PullRequestProjectFailure[];
  readonly projects: readonly Project[];
}): SourceControlProviderKind | null {
  const byKey = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const hosts = new Set<SourceControlProviderKind>();
  for (const failure of input.failures) {
    const project = byKey.get(`${failure.environmentId}:${failure.projectId}`);
    const host = project === undefined ? null : projectProviderKind(project);
    if (host === null) {
      return null;
    }
    hosts.add(host);
  }
  return hosts.size === 1 ? ([...hosts][0] ?? null) : null;
}

/** The one-line reading of a check rollup, and which rows still deserve a row. */
export interface PullRequestChecksSummary {
  readonly total: number;
  readonly failing: number;
  readonly pending: number;
  readonly passing: number;
  readonly skipped: number;
  /** Failures first, then whatever is still running: the rows worth listing on their own. */
  readonly attention: readonly PullRequestCheck[];
  readonly state: "failure" | "pending" | "success" | "none";
}

/**
 * Collapses a check list to its counts. A run with sixteen green checks is one
 * line; a run with one red one is that row and one line. The summary mirrors
 * the list decoder's rollup rule: any failure outranks running, running
 * outranks passing.
 */
export function summarizePullRequestChecks(
  checks: readonly PullRequestCheck[],
): PullRequestChecksSummary {
  let failing = 0;
  let pending = 0;
  let passing = 0;
  let skipped = 0;
  for (const check of checks) {
    switch (check.status) {
      case "failure":
        failing += 1;
        break;
      case "pending":
        pending += 1;
        break;
      case "success":
        passing += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
    }
  }
  const attention = [
    ...checks.filter((check) => check.status === "failure"),
    ...checks.filter((check) => check.status === "pending"),
  ];
  return {
    total: checks.length,
    failing,
    pending,
    passing,
    skipped,
    attention,
    state:
      checks.length === 0 ? "none" : failing > 0 ? "failure" : pending > 0 ? "pending" : "success",
  };
}

/** "2 failing, 3 running, 11 passed" and so on; only the non-zero parts. */
export function formatPullRequestChecksSummary(summary: PullRequestChecksSummary): string {
  const parts = [
    summary.failing > 0 ? `${summary.failing} failing` : null,
    summary.pending > 0 ? `${summary.pending} running` : null,
    summary.passing > 0 ? `${summary.passing} passed` : null,
    summary.skipped > 0 ? `${summary.skipped} skipped` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "No checks reported." : parts.join(", ");
}

/**
 * The check rollup in one phrase, for the header's tab strip: what is wrong if
 * anything is, and otherwise how far along the run is. Failures outrank running
 * the way the glyph beside it does, and skipped checks count towards the total
 * without ever being the thing the phrase is about.
 */
export function formatPullRequestChecksHeadline(summary: PullRequestChecksSummary): string {
  if (summary.total === 0) {
    return "No checks reported";
  }
  if (summary.failing > 0) {
    return `${summary.failing} of ${summary.total} failing`;
  }
  if (summary.pending > 0) {
    return `${summary.pending} of ${summary.total} running`;
  }
  return summary.passing === summary.total
    ? "All checks passed"
    : `${summary.passing} of ${summary.total} passing`;
}

/** How each merge method reads in a menu item and in the confirm dialog. */
export const PULL_REQUEST_MERGE_METHOD_LABELS: Readonly<Record<PullRequestMergeMethod, string>> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/**
 * The method the Merge button runs without being asked. The repository lists
 * what it allows in its own order and the first one is its default; a host
 * that reports nothing still gets a plain merge offered, and refuses it itself
 * if it really is off.
 */
export function resolveDefaultMergeMethod(
  mergeMethods: readonly PullRequestMergeMethod[],
): PullRequestMergeMethod {
  return mergeMethods[0] ?? "merge";
}

/**
 * Why merging is off the table right now, or null when it is available. Both
 * answers are things the user fixes elsewhere, so the button stays visible and
 * says what is in the way rather than disappearing.
 */
export function resolvePullRequestMergeBlock(
  detail: Pick<PullRequestDetail, "mergeability" | "isDraft">,
): string | null {
  if (detail.isDraft) {
    return "Mark as ready first";
  }
  if (detail.mergeability === "conflicting") {
    return "Resolve the conflicts first";
  }
  return null;
}

/**
 * The prompt a review comment becomes when it is handed to the thread working
 * the branch. The comment is quoted rather than restated, so the agent reads
 * the reviewer's own words and the user still sends it themselves.
 */
export function buildReviewCommentHandoff(input: {
  readonly number: number;
  readonly author: string | null;
  readonly body: string;
}): string {
  const by = input.author === null ? "" : ` by ${input.author}`;
  const quoted = input.body
    .replace(/\r\n/gu, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
  return `Address this review comment on pull request #${input.number}${by}:\n\n${quoted}`;
}

/**
 * A hand-off never overwrites what the user was already typing: it lands under
 * their draft, separated by a blank line. A second hand-off into the same
 * composer replaces the first one's words and only those, so pressing two
 * actions in a row leaves one prompt rather than two stacked ones.
 */
export function appendHandoffToDraft(
  existingPrompt: string,
  handoff: string,
  previousHandoff?: string,
): string {
  const existing =
    previousHandoff === undefined || previousHandoff.length === 0
      ? existingPrompt.trimEnd()
      : withoutHandoff(existingPrompt, previousHandoff);
  return existing.length === 0 ? handoff : `${existing}\n\n${handoff}`;
}

/** The draft with one hand-off lifted out, leaving the user's words joined up. */
function withoutHandoff(prompt: string, handoff: string): string {
  const index = prompt.lastIndexOf(handoff);
  if (index < 0) {
    return prompt.trimEnd();
  }
  const before = prompt.slice(0, index).trimEnd();
  const after = prompt.slice(index + handoff.length).trim();
  if (before.length === 0) return after;
  if (after.length === 0) return before;
  return `${before}\n\n${after}`;
}

/** The picker's order, which is the host's: the two verdicts first, then the rest. */
export const PULL_REQUEST_REACTION_ORDER: readonly PullRequestReactionContent[] = [
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

const REACTION_EMOJI: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "\u{1F44D}",
  "thumbs-down": "\u{1F44E}",
  laugh: "\u{1F604}",
  hooray: "\u{1F389}",
  confused: "\u{1F615}",
  heart: "❤️",
  rocket: "\u{1F680}",
  eyes: "\u{1F440}",
};

/** The spoken name, which is what a screen reader reads out instead of the glyph. */
const REACTION_NAME: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "thumbs up",
  "thumbs-down": "thumbs down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

export function pullRequestReactionEmoji(content: PullRequestReactionContent): string {
  return REACTION_EMOJI[content];
}

export function pullRequestReactionName(content: PullRequestReactionContent): string {
  return REACTION_NAME[content];
}

/**
 * The bar as it should read while a press is still in flight. Re-reading a
 * pull request takes seconds, and a chip that does not move until then reads
 * as a press that did nothing; a failed press drops its entry, so the host's
 * own counts come back.
 */
export function applyPendingPullRequestReactions(
  reactions: readonly PullRequestReaction[],
  pending: ReadonlyMap<PullRequestReactionContent, boolean>,
): readonly PullRequestReaction[] {
  if (pending.size === 0) {
    return reactions;
  }
  const byContent = new Map(reactions.map((reaction) => [reaction.content, reaction] as const));
  for (const [content, reacted] of pending) {
    const current = byContent.get(content);
    if (current === undefined) {
      if (reacted) {
        byContent.set(content, { content, count: 1, viewerReacted: true });
      }
      continue;
    }
    if (current.viewerReacted === reacted) continue;
    const count = current.count + (reacted ? 1 : -1);
    if (count <= 0) {
      byContent.delete(content);
    } else {
      byContent.set(content, { ...current, count, viewerReacted: reacted });
    }
  }
  return PULL_REQUEST_REACTION_ORDER.flatMap((content) => byContent.get(content) ?? []);
}

/**
 * The hunk geometry a line position needs, and nothing else. A parsed
 * `FileDiffMetadata` satisfies it, so the viewer's files go straight in while
 * this stays testable without one.
 */
export type PullRequestDiffSegment =
  | { readonly type: "context"; readonly lines: number }
  | { readonly type: "change"; readonly deletions: number; readonly additions: number };

export interface PullRequestDiffHunk {
  /** The first line number this hunk covers in the old file. */
  readonly deletionStart: number;
  /** The first line number this hunk covers in the new file. */
  readonly additionStart: number;
  readonly hunkContent: readonly PullRequestDiffSegment[];
}

export interface PullRequestDiffFile {
  readonly hunks: readonly PullRequestDiffHunk[];
}

/** One rendered row of a diff: what it is, and its number on each side. */
interface PullRequestDiffRow {
  readonly change: "context" | "added" | "deleted";
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

/**
 * Every row the patch draws, in order. A context row counts on both sides, an
 * added row only in the new file and a deleted row only in the old one, which
 * is what decides whether a remark has a side to choose.
 */
function* readPullRequestDiffRows(fileDiff: PullRequestDiffFile): Generator<PullRequestDiffRow> {
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          yield { change: "context", oldLine, newLine };
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }
      for (let index = 0; index < segment.deletions; index += 1) {
        yield { change: "deleted", oldLine, newLine: null };
        oldLine += 1;
      }
      for (let index = 0; index < segment.additions; index += 1) {
        yield { change: "added", oldLine: null, newLine };
        newLine += 1;
      }
    }
  }
}

/**
 * Where a line comment hangs, from the line the reader marked and the side it
 * was marked on. Null when that line is not drawn at all: a conversation under
 * a hunk the host withheld has no row to be pinned to, however much its file
 * looks like a match.
 */
export function resolvePullRequestReviewPosition(
  fileDiff: PullRequestDiffFile,
  lineNumber: number,
  side: PullRequestDiffSide,
): PullRequestReviewPosition | null {
  for (const row of readPullRequestDiffRows(fileDiff)) {
    const rowLine = side === "left" ? row.oldLine : row.newLine;
    if (rowLine !== lineNumber) continue;
    if (row.change === "added") {
      return row.newLine === null ? null : { kind: "added", newLine: row.newLine };
    }
    if (row.change === "deleted") {
      return row.oldLine === null ? null : { kind: "deleted", oldLine: row.oldLine };
    }
    return row.oldLine === null || row.newLine === null
      ? null
      : { kind: "context", oldLine: row.oldLine, newLine: row.newLine, side };
  }
  return null;
}

/** The line a position hangs on, and the side it hangs there from. */
export function pullRequestReviewPositionAnchor(position: PullRequestReviewPosition): {
  readonly line: number;
  readonly side: PullRequestDiffSide;
} {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "right" };
    case "deleted":
      return { line: position.oldLine, side: "left" };
    case "context":
      return {
        line: position.side === "left" ? position.oldLine : position.newLine,
        side: position.side,
      };
  }
}

/** "L12" for one line, "L12–L18" for a run of them. */
export function formatPullRequestLineRangeLabel(start: number, end: number): string {
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  return first === last ? `L${first}` : `L${first}–L${last}`;
}

/** One entry on the timeline, whatever it happens to be. */
export interface PullRequestTimelineEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: "opened" | "commit" | "comment" | "review" | "merged" | "closed";
  readonly actor: PullRequestActor | null;
  /** A commit's headline or a remark's words. Null where the row is only a fact. */
  readonly body: string | null;
  /** Whether `body` is markdown; a commit headline is not, and is not parsed as one. */
  readonly markdown: boolean;
  readonly url: string | null;
  /** Set on a review, which is the only entry that carries a verdict. */
  readonly reviewState: PullRequestReviewState | null;
  readonly reactions: readonly PullRequestReaction[];
  /** The file a remark was written on, for the ones pinned to a diff line. */
  readonly path: string | null;
  /** The line inside {@link path}, which an outdated conversation no longer has. */
  readonly line: number | null;
}

export type PullRequestTimelineRow =
  | { readonly kind: "event"; readonly event: PullRequestTimelineEvent }
  | { readonly kind: "comments"; readonly events: readonly PullRequestTimelineEvent[] };

/**
 * A verdict earns a row of its own. Whether the change was approved is the
 * question a reader opens the timeline with, and folding the answer into a
 * collapsed "9 comments" group hides it behind a press. A review that only
 * commented carries no verdict, so it reads as one of the comments.
 */
export function isPullRequestVerdict(state: PullRequestReviewState | null): boolean {
  return state === "approved" || state === "changes-requested";
}

/**
 * Everything that happened, newest first: opened, each commit, the
 * conversation on the pull request and on its diff lines, and how it ended.
 * Merged wins over closed, since a host sets both timestamps on a merge and
 * reporting "closed" would misstate it.
 */
export function buildPullRequestTimeline(
  detail: Pick<PullRequestDetail, "createdAt" | "author" | "mergedAt" | "closedAt" | "url">,
  activity: Pick<PullRequestActivity, "comments" | "commits" | "reviewThreads"> | null,
): readonly PullRequestTimelineEvent[] {
  const events: PullRequestTimelineEvent[] = [
    {
      id: "opened",
      at: detail.createdAt,
      kind: "opened",
      actor: detail.author,
      body: null,
      markdown: false,
      url: null,
      reviewState: null,
      reactions: [],
      path: null,
      line: null,
    },
    ...(activity?.commits ?? []).map((commit): PullRequestTimelineEvent => ({
      id: commit.oid,
      at: commit.committedDate,
      kind: "commit",
      actor:
        commit.authorLogin === null
          ? null
          : { login: commit.authorLogin, isBot: false, avatarUrl: null },
      body: commit.messageHeadline.trim().length > 0 ? commit.messageHeadline : null,
      markdown: false,
      url: `${detail.url}/commits/${commit.oid}`,
      reviewState: null,
      reactions: [],
      path: null,
      line: null,
    })),
    ...(activity?.comments ?? []).map((comment): PullRequestTimelineEvent => ({
      id: comment.id,
      at: comment.createdAt,
      kind: comment.kind === "review" ? "review" : "comment",
      actor: comment.author,
      body: comment.body.trim().length > 0 ? comment.body : null,
      markdown: true,
      url: comment.url,
      reviewState: comment.reviewState,
      reactions: comment.reactions,
      path: null,
      line: null,
    })),
    // A remark on a diff line is part of the same conversation, so the timeline
    // carries it too; where it was written rides along, because a line comment
    // read away from its line says nothing without it.
    ...(activity?.reviewThreads ?? []).flatMap((thread) =>
      thread.comments.map((comment): PullRequestTimelineEvent => ({
        id: comment.id,
        at: comment.createdAt,
        kind: "comment",
        actor: comment.author,
        body: comment.body.trim().length > 0 ? comment.body : null,
        markdown: true,
        url: comment.url,
        reviewState: null,
        reactions: comment.reactions,
        path: thread.path,
        line: thread.line,
      })),
    ),
    ...(detail.mergedAt === null
      ? []
      : [
          {
            id: "merged",
            at: detail.mergedAt,
            kind: "merged" as const,
            actor: null,
            body: null,
            markdown: false,
            url: null,
            reviewState: null,
            reactions: [],
            path: null,
            line: null,
          },
        ]),
    ...(detail.closedAt === null || detail.mergedAt !== null
      ? []
      : [
          {
            id: "closed",
            at: detail.closedAt,
            kind: "closed" as const,
            actor: null,
            body: null,
            markdown: false,
            url: null,
            reviewState: null,
            reactions: [],
            path: null,
            line: null,
          },
        ]),
  ];
  return events.toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

/**
 * Consecutive remarks fold into one group. Commits, the lifecycle rows and the
 * verdicts stay first-class and split those groups, so expanding a
 * conversation never hides the work that happened between two review rounds.
 */
export function groupTimelineRows(
  events: readonly PullRequestTimelineEvent[],
): readonly PullRequestTimelineRow[] {
  const rows: PullRequestTimelineRow[] = [];
  for (const event of events) {
    const foldable =
      (event.kind === "comment" || event.kind === "review") &&
      !isPullRequestVerdict(event.reviewState);
    const last = rows.at(-1);
    if (foldable && last?.kind === "comments") {
      rows[rows.length - 1] = { kind: "comments", events: [...last.events, event] };
    } else if (foldable) {
      rows.push({ kind: "comments", events: [event] });
    } else {
      rows.push({ kind: "event", event });
    }
  }
  return rows;
}

/**
 * How far behind its base the branch is, or null when it is current or the
 * host could not say. The line sits under the meta with the update control.
 */
export function formatPullRequestBaseFreshness(
  detail: Pick<PullRequestDetail, "baseComparison" | "behindBy" | "baseBranch">,
): string | null {
  if (detail.baseComparison !== "behind") {
    return null;
  }
  // A host that will not say how far behind gets the bare fact rather than a
  // count it cannot fill in.
  if (detail.behindBy === null || detail.behindBy <= 0) {
    return `Behind ${detail.baseBranch}`;
  }
  return `Behind ${detail.baseBranch} by ${detail.behindBy} ${detail.behindBy === 1 ? "commit" : "commits"}`;
}

/**
 * The same fact as {@link formatPullRequestBaseFreshness}, short enough for the
 * branch line to carry it after the head branch. The line already names the
 * base, so this says only how far behind it the branch is.
 */
export function formatPullRequestBehindLabel(
  detail: Pick<PullRequestDetail, "baseComparison" | "behindBy">,
): string | null {
  if (detail.baseComparison !== "behind") {
    return null;
  }
  return detail.behindBy === null || detail.behindBy <= 0
    ? "behind"
    : `behind by ${detail.behindBy}`;
}

/** How each way of bringing a branch up to date reads in the update menu. */
export function pullRequestUpdateMethodLabel(
  method: PullRequestUpdateMethod,
  baseBranch: string,
): string {
  return method === "rebase" ? `Rebase onto ${baseBranch}` : `Merge ${baseBranch} in`;
}
