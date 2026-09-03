import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestComment,
  type PullRequestListEntry,
  type VcsStatusResult,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary } from "../../types";
import {
  DEFAULT_PULL_REQUEST_SORT,
  EMPTY_PULL_REQUEST_FILTERS,
  appendHandoffToDraft,
  applyPendingPullRequestReactions,
  buildPullRequestTimeline,
  buildReviewCommentHandoff,
  countNeedsYou,
  formatPullRequestBaseFreshness,
  formatPullRequestChecksSummary,
  groupPullRequests,
  groupTimelineRows,
  linkThreadsToPullRequests,
  matchesPullRequestQuery,
  narrowPullRequests,
  parsePullRequestsSearch,
  pullRequestEntryKey,
  pullRequestFilterChips,
  pullRequestFiltersFromSearch,
  pullRequestFiltersToSearch,
  resolveNeedsYouReason,
  resolvePullRequestMergeBlock,
  resolvePullRequestReviewPosition,
  sortPullRequests,
  summarizePullRequestChecks,
  resolveThreadPullRequest,
  type PullRequestDiffFile,
  type PullRequestEntry,
  type PullRequestFilters,
  type PullRequestSort,
} from "./pullRequests.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const PROJECT_ID = ProjectId.make("project-threadlines");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const WORKTREE_PROJECT_ID = ProjectId.make("project-threadlines-worktree");

/** A workspace project whose remote resolved to `repository`, or to nothing. */
function project(input: {
  readonly id: ProjectId;
  readonly repository: string | null;
  readonly environmentId?: EnvironmentId;
}): Project {
  const [owner = "", name = ""] = (input.repository ?? "/").split("/");
  return {
    id: input.id,
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    kind: "workspace",
    name: input.id,
    cwd: `/workspaces/${input.id}`,
    repositoryIdentity:
      input.repository === null
        ? null
        : {
            canonicalKey: `github:${input.repository}`,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: `https://github.com/${input.repository}.git`,
            },
            provider: "github",
            owner,
            name,
          },
    defaultModelSelection: null,
    scripts: [],
  };
}

const PROJECTS = [
  project({ id: PROJECT_ID, repository: "threadlines/threadlines" }),
  // A worktree checkout of the same remote, spelled the way GitHub also accepts.
  project({ id: WORKTREE_PROJECT_ID, repository: "Threadlines/Threadlines" }),
  project({ id: OTHER_PROJECT_ID, repository: "other/repo" }),
  project({
    id: OTHER_PROJECT_ID,
    repository: "threadlines/threadlines",
    environmentId: OTHER_ENVIRONMENT_ID,
  }),
];

function entry(overrides: Partial<PullRequestEntry> = {}): PullRequestEntry {
  const base: PullRequestListEntry = {
    provider: "github",
    projectId: PROJECT_ID,
    projectTitle: "Threadlines",
    repository: "threadlines/threadlines",
    number: 1,
    title: "Add the pull requests page",
    url: "https://github.com/threadlines/threadlines/pull/1",
    author: { login: "ada", isBot: false, avatarUrl: null },
    headBranch: "feature/pull-requests",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 10,
    deletions: 2,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    viewerIsAuthor: false,
    viewerReviewRequested: false,
    labels: [],
    origin: "workspace",
  };
  return {
    ...base,
    environmentId: ENVIRONMENT_ID,
    environmentLabel: "This device",
    ...overrides,
  };
}

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Build the page",
    interactionMode: "default",
    session: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneOverride: null,
    lastSeenAt: null,
    updatedAt: "2026-09-01T11:00:00.000Z",
    latestTurn: null,
    branch: "feature/pull-requests",
    worktreePath: null,
    effectiveCwd: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    cumulativeDiffStat: null,
    ...overrides,
  };
}

describe("resolveNeedsYouReason", () => {
  it("puts a review request ahead of every author signal", () => {
    expect(
      resolveNeedsYouReason(
        entry({
          viewerReviewRequested: true,
          viewerIsAuthor: true,
          reviewDecision: "changes-requested",
          checksState: "failure",
        }),
      ),
    ).toBe("Review requested");
  });

  it("reports changes before failing checks for the author's own row", () => {
    expect(
      resolveNeedsYouReason(
        entry({
          viewerIsAuthor: true,
          reviewDecision: "changes-requested",
          checksState: "failure",
        }),
      ),
    ).toBe("Changes requested");
  });

  it("stays quiet for a draft the viewer already had approved", () => {
    expect(
      resolveNeedsYouReason(
        entry({ viewerIsAuthor: true, reviewDecision: "approved", isDraft: true }),
      ),
    ).toBeNull();
    expect(resolveNeedsYouReason(entry({ viewerIsAuthor: true, reviewDecision: "approved" }))).toBe(
      "Approved",
    );
  });

  it("says nothing about a merged or closed row", () => {
    expect(
      resolveNeedsYouReason(entry({ state: "merged", viewerReviewRequested: true })),
    ).toBeNull();
  });

  it("ignores another author's failing checks", () => {
    expect(resolveNeedsYouReason(entry({ checksState: "failure" }))).toBeNull();
  });
});

describe("groupPullRequests", () => {
  it("places each open row in exactly one group, newest first", () => {
    const needsYou = entry({ number: 1, viewerReviewRequested: true });
    const yoursOlder = entry({
      number: 2,
      viewerIsAuthor: true,
      updatedAt: "2026-09-01T08:00:00.000Z",
    });
    const yoursNewer = entry({
      number: 3,
      viewerIsAuthor: true,
      updatedAt: "2026-09-01T13:00:00.000Z",
    });
    const others = entry({ number: 4 });

    const groups = groupPullRequests({
      entries: [others, yoursOlder, needsYou, yoursNewer],
      viewer: "ada",
      state: "open",
    });

    expect(groups.map((group) => group.label)).toEqual(["Needs you", "Yours", "Others"]);
    expect(groups[0]?.entries.map((row) => row.number)).toEqual([1]);
    expect(groups[1]?.entries.map((row) => row.number)).toEqual([3, 2]);
    expect(groups[2]?.entries.map((row) => row.number)).toEqual([4]);
  });

  it("drops empty groups instead of heading an absent list", () => {
    const groups = groupPullRequests({
      entries: [entry({ number: 1 }), entry({ number: 2 })],
      viewer: "ada",
      state: "open",
    });
    expect(groups.map((group) => group.label)).toEqual(["Others"]);
  });

  it("falls back to one unlabelled list without a viewer or outside the open tab", () => {
    const withoutViewer = groupPullRequests({
      entries: [entry({ number: 1, viewerReviewRequested: true })],
      viewer: null,
      state: "open",
    });
    expect(withoutViewer).toHaveLength(1);
    expect(withoutViewer[0]?.label).toBeNull();

    const merged = groupPullRequests({
      entries: [entry({ number: 1, state: "merged", viewerIsAuthor: true })],
      viewer: "ada",
      state: "merged",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBeNull();
  });

  it("counts only the rows that need the viewer", () => {
    expect(
      countNeedsYou([
        entry({ number: 1, viewerReviewRequested: true }),
        entry({ number: 2, viewerIsAuthor: true }),
        entry({ number: 3 }),
      ]),
    ).toBe(1);
  });
});

describe("linkThreadsToPullRequests", () => {
  it("links live threads on the same branch, most recently updated first", () => {
    const row = entry();
    const older = thread({
      id: ThreadId.make("thread-old"),
      updatedAt: "2026-09-01T09:00:00.000Z",
    });
    const newer = thread({
      id: ThreadId.make("thread-new"),
      updatedAt: "2026-09-01T14:00:00.000Z",
    });

    const linked = linkThreadsToPullRequests([row], [older, newer], PROJECTS);

    expect(linked.get(pullRequestEntryKey(row))?.map((match) => match.id)).toEqual([
      "thread-new",
      "thread-old",
    ]);
  });

  it("links a thread from a sibling project on the same repository", () => {
    const row = entry();
    const linked = linkThreadsToPullRequests(
      [row],
      [thread({ id: ThreadId.make("worktree-thread"), projectId: WORKTREE_PROJECT_ID })],
      PROJECTS,
    );

    expect(linked.get(pullRequestEntryKey(row))?.map((match) => match.id)).toEqual([
      "worktree-thread",
    ]);
  });

  it("leaves an authored row alone, whatever repository the listing says it is on", () => {
    // The row's project is only the checkout its host tool ran in, so a thread
    // in that project is not working it even where the names line up.
    const row = entry({ origin: "authored" });
    const linked = linkThreadsToPullRequests([row], [thread()], PROJECTS);

    expect(linked.has(pullRequestEntryKey(row))).toBe(false);
  });

  it("ignores archived threads, other branches, other repositories, and other environments", () => {
    const row = entry();
    const linked = linkThreadsToPullRequests(
      [row],
      [
        thread({ id: ThreadId.make("archived"), archivedAt: "2026-09-01T10:00:00.000Z" }),
        thread({ id: ThreadId.make("other-branch"), branch: "main" }),
        thread({ id: ThreadId.make("no-branch"), branch: null }),
        thread({ id: ThreadId.make("other-repository"), projectId: OTHER_PROJECT_ID }),
        thread({ id: ThreadId.make("other-env"), environmentId: OTHER_ENVIRONMENT_ID }),
      ],
      PROJECTS,
    );

    expect(linked.has(pullRequestEntryKey(row))).toBe(false);
  });
});

function gitStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/pull-requests",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const MERGED_STATUS_PR = {
  number: 7,
  title: "Merged already",
  url: "https://github.com/threadlines/threadlines/pull/7",
  baseRef: "main",
  headRef: "feature/pull-requests",
  state: "merged",
} as const;

describe("resolveThreadPullRequest", () => {
  it("prefers the checkout's own status, which is the only source that sees a merge", () => {
    const resolved = resolveThreadPullRequest({
      thread: thread(),
      gitStatus: gitStatus({ pr: MERGED_STATUS_PR }),
      openEntries: [entry({ number: 412 })],
      projects: PROJECTS,
    });

    expect(resolved).toEqual({
      number: 7,
      state: "merged",
      isDraft: false,
      title: "Merged already",
      url: "https://github.com/threadlines/threadlines/pull/7",
      repository: "threadlines/threadlines",
    });
  });

  it("falls back to the open listing when the checkout stands on another branch", () => {
    const resolved = resolveThreadPullRequest({
      thread: thread(),
      gitStatus: gitStatus({ refName: "main", pr: MERGED_STATUS_PR }),
      openEntries: [entry({ number: 412, isDraft: true })],
      projects: PROJECTS,
    });

    expect(resolved).toMatchObject({ number: 412, state: "open", isDraft: true });
  });

  it("learns a branch landed from the merged listing when the open one has dropped it", () => {
    const resolved = resolveThreadPullRequest({
      thread: thread(),
      gitStatus: gitStatus({ refName: "main" }),
      openEntries: [],
      settledEntries: [entry({ number: 412, state: "merged" })],
      projects: PROJECTS,
    });

    expect(resolved).toMatchObject({ number: 412, state: "merged" });
  });

  it("never reads an authored row as a thread's own work", () => {
    expect(
      resolveThreadPullRequest({
        thread: thread(),
        gitStatus: null,
        openEntries: [entry({ number: 412, origin: "authored" })],
        projects: PROJECTS,
      }),
    ).toBeNull();
  });

  it("has nothing to say about a thread with no branch, an archived one, or an unlisted branch", () => {
    const openEntries = [entry({ number: 412 })];
    for (const subject of [
      thread({ branch: null }),
      thread({ archivedAt: "2026-09-01T13:00:00.000Z" }),
      thread({ branch: "feature/something-else" }),
      thread({ projectId: OTHER_PROJECT_ID }),
    ]) {
      expect(
        resolveThreadPullRequest({
          thread: subject,
          gitStatus: null,
          openEntries,
          projects: PROJECTS,
        }),
      ).toBeNull();
    }
  });
});

describe("matchesPullRequestQuery", () => {
  const row = entry({
    number: 412,
    title: "Add the pull requests page",
    author: { login: "ada", isBot: false, avatarUrl: null },
    headBranch: "feature/pull-requests",
    repository: "threadlines/threadlines",
    labels: [{ name: "needs-design", color: "d73a4a" }],
  });

  it("matches the title, number, author, branch, repository, and labels", () => {
    for (const query of [
      "PULL requests",
      "#412",
      "412",
      "ada",
      "feature/pull",
      "threadlines/threadlines",
      "needs-design",
    ]) {
      expect(matchesPullRequestQuery(row, query)).toBe(true);
    }
  });

  it("ANDs the words, so more typing narrows", () => {
    expect(matchesPullRequestQuery(row, "ada page")).toBe(true);
    expect(matchesPullRequestQuery(row, "ada terminal")).toBe(false);
  });

  it("keeps everything for an empty query", () => {
    expect(matchesPullRequestQuery(row, "   ")).toBe(true);
  });
});

describe("narrowPullRequests", () => {
  const rows = [
    entry({
      number: 1,
      author: { login: "ada", isBot: false, avatarUrl: null },
      labels: [{ name: "bug", color: null }],
      reviewDecision: "approved",
      checksState: "success",
    }),
    entry({
      number: 2,
      author: { login: "Grace", isBot: false, avatarUrl: null },
      labels: [
        { name: "bug", color: null },
        { name: "wip", color: null },
      ],
      isDraft: true,
      checksState: "failure",
    }),
    entry({ number: 3, author: null, labels: [] }),
  ];
  const numbersFor = (filters: Partial<PullRequestFilters>) =>
    narrowPullRequests(rows, { ...EMPTY_PULL_REQUEST_FILTERS, ...filters }).map(
      (row) => row.number,
    );

  it("keeps every row when nothing is asked of it", () => {
    expect(narrowPullRequests(rows, EMPTY_PULL_REQUEST_FILTERS)).toBe(rows);
  });

  it("matches an author whatever the case, and drops the rows with none", () => {
    expect(numbersFor({ author: " grace " })).toEqual([2]);
  });

  it("requires every included label and refuses any excluded one", () => {
    expect(numbersFor({ labels: "bug" })).toEqual([1, 2]);
    expect(numbersFor({ labels: "bug, wip" })).toEqual([2]);
    expect(numbersFor({ labels: "bug", excludeLabels: "wip" })).toEqual([1]);
  });

  it("splits the drafts, the verdicts and the checks", () => {
    expect(numbersFor({ draft: "only" })).toEqual([2]);
    expect(numbersFor({ draft: "hide" })).toEqual([1, 3]);
    expect(numbersFor({ review: "approved" })).toEqual([1]);
    expect(numbersFor({ checks: "failing" })).toEqual([2]);
    expect(numbersFor({ checks: "passing" })).toEqual([1]);
  });

  it("narrows on everything at once", () => {
    expect(numbersFor({ author: "ada", labels: "bug", checks: "passing" })).toEqual([1]);
    expect(numbersFor({ author: "ada", labels: "bug", checks: "failing" })).toEqual([]);
  });
});

describe("sortPullRequests", () => {
  const rows = [
    entry({
      number: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      additions: 1,
      deletions: 1,
    }),
    entry({
      number: 2,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      additions: 400,
      deletions: 0,
    }),
    entry({
      number: 3,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      additions: 10,
      deletions: 5,
    }),
  ];
  const numbersFor = (sort: PullRequestSort) =>
    sortPullRequests(rows, sort).map((row) => row.number);

  it("orders by the last update, the opening, or the size of the change", () => {
    expect(numbersFor("updated")).toEqual([1, 3, 2]);
    expect(numbersFor("created")).toEqual([2, 3, 1]);
    expect(numbersFor("size")).toEqual([2, 3, 1]);
  });

  it("carries the sort into the groups", () => {
    const groups = groupPullRequests({ entries: rows, viewer: null, state: "open", sort: "size" });
    expect(groups[0]?.entries.map((row) => row.number)).toEqual([2, 3, 1]);
  });
});

describe("the filter chips and the route's params", () => {
  it("names each narrowing and gives back the filters without it", () => {
    const filters: PullRequestFilters = {
      ...EMPTY_PULL_REQUEST_FILTERS,
      author: "ada",
      labels: "bug, wip",
      excludeLabels: "stale",
      checks: "failing",
    };
    const chips = pullRequestFilterChips(filters);

    expect(chips.map((chip) => chip.label)).toEqual([
      "Author: ada",
      "Label: bug",
      "Label: wip",
      "Not label: stale",
      "Checks failing",
    ]);
    // Removing one label leaves the other, and the rest of the filters stand.
    expect(chips[1]?.next).toEqual({ ...filters, labels: "wip" });
    expect(chips[4]?.next.checks).toBe("any");
  });

  it("reads the filters off a link and writes only what is not resting", () => {
    const search = parsePullRequestsSearch({
      state: "closed",
      author: " ada ",
      labels: "bug",
      draft: "hide",
      review: "nonsense",
      checks: "failing",
      sort: "size",
    });

    expect(search).toEqual({
      state: "closed",
      author: "ada",
      labels: "bug",
      draft: "hide",
      checks: "failing",
      sort: "size",
    });
    expect(pullRequestFiltersToSearch(pullRequestFiltersFromSearch(search), "size")).toEqual({
      author: "ada",
      labels: "bug",
      draft: "hide",
      checks: "failing",
      sort: "size",
    });
    expect(
      pullRequestFiltersToSearch(EMPTY_PULL_REQUEST_FILTERS, DEFAULT_PULL_REQUEST_SORT),
    ).toEqual({});
  });
});

describe("summarizePullRequestChecks", () => {
  const check = (name: string, status: "pending" | "success" | "failure" | "skipped") => ({
    name,
    status,
    description: null,
    url: null,
  });

  it("lists only what is failing or still running, failures first", () => {
    const summary = summarizePullRequestChecks([
      check("build", "success"),
      check("deploy", "pending"),
      check("lint", "failure"),
      check("docs", "skipped"),
    ]);

    expect(summary.state).toBe("failure");
    expect(summary.attention.map((entry) => entry.name)).toEqual(["lint", "deploy"]);
    expect(formatPullRequestChecksSummary(summary)).toBe(
      "1 failing, 1 running, 1 passed, 1 skipped",
    );
  });

  it("reads all-green as one line with nothing to list", () => {
    const summary = summarizePullRequestChecks([
      check("build", "success"),
      check("e2e", "skipped"),
    ]);

    expect(summary.state).toBe("success");
    expect(summary.attention).toEqual([]);
    expect(formatPullRequestChecksSummary(summary)).toBe("1 passed, 1 skipped");
  });

  it("has nothing to say without checks", () => {
    const summary = summarizePullRequestChecks([]);

    expect(summary.state).toBe("none");
    expect(formatPullRequestChecksSummary(summary)).toBe("No checks reported.");
  });
});

describe("resolvePullRequestMergeBlock", () => {
  it("names what is in the way, draft before conflicts, and nothing when clear", () => {
    expect(resolvePullRequestMergeBlock({ mergeability: "conflicting", isDraft: true })).toBe(
      "Mark as ready first",
    );
    expect(resolvePullRequestMergeBlock({ mergeability: "conflicting", isDraft: false })).toBe(
      "Resolve the conflicts first",
    );
    expect(resolvePullRequestMergeBlock({ mergeability: "unknown", isDraft: false })).toBeNull();
  });
});

describe("handing a review comment to a thread", () => {
  it("quotes the comment line by line and lands under what the user was typing", () => {
    const handoff = buildReviewCommentHandoff({
      number: 42,
      author: "grace",
      body: "Rename this.\n\nIt shadows the outer one.\n",
    });

    expect(handoff).toBe(
      "Address this review comment on pull request #42 by grace:\n\n" +
        "> Rename this.\n>\n> It shadows the outer one.",
    );
    expect(appendHandoffToDraft("", handoff)).toBe(handoff);
    expect(appendHandoffToDraft("Half a thought\n", handoff)).toBe(`Half a thought\n\n${handoff}`);
  });

  it("replaces the last hand-off and nothing else", () => {
    const first = "Fix this.";
    const second = "Fix that.";

    // The user's words survive on both sides of the hand-off that leaves.
    expect(appendHandoffToDraft(`Mine\n\n${first}`, second, first)).toBe(`Mine\n\n${second}`);
    expect(appendHandoffToDraft(`${first}\n\nMine after`, second, first)).toBe(
      `Mine after\n\n${second}`,
    );
    // A hand-off the user has since edited away is left alone.
    expect(appendHandoffToDraft("Mine only", second, first)).toBe(`Mine only\n\n${second}`);
  });
});

/**
 * One hunk covering old lines 1-3 and new lines 1-4: a context line, then one
 * line replaced by two, then a context line.
 */
const REVIEW_FILE: PullRequestDiffFile = {
  hunks: [
    {
      deletionStart: 1,
      additionStart: 1,
      hunkContent: [
        { type: "context", lines: 1 },
        { type: "change", deletions: 1, additions: 2 },
        { type: "context", lines: 1 },
      ],
    },
  ],
};

describe("resolvePullRequestReviewPosition", () => {
  it("reads a marked line as added, deleted, or context on the marked side", () => {
    expect(resolvePullRequestReviewPosition(REVIEW_FILE, 2, "right")).toEqual({
      kind: "added",
      newLine: 2,
    });
    expect(resolvePullRequestReviewPosition(REVIEW_FILE, 2, "left")).toEqual({
      kind: "deleted",
      oldLine: 2,
    });
    // A context line exists in both files, so it is the only kind with a side.
    expect(resolvePullRequestReviewPosition(REVIEW_FILE, 4, "right")).toEqual({
      kind: "context",
      oldLine: 3,
      newLine: 4,
      side: "right",
    });
  });

  it("refuses a line the diff does not draw", () => {
    expect(resolvePullRequestReviewPosition(REVIEW_FILE, 4, "left")).toBeNull();
    expect(resolvePullRequestReviewPosition(REVIEW_FILE, 99, "right")).toBeNull();
  });
});

const TIMELINE_DETAIL = {
  createdAt: "2026-09-01T09:00:00.000Z",
  author: { login: "ada", isBot: false, avatarUrl: null },
  mergedAt: null,
  closedAt: null,
  url: "https://github.com/threadlines/threadlines/pull/42",
} satisfies Parameters<typeof buildPullRequestTimeline>[0];

function timelineComment(
  id: string,
  createdAt: string,
  overrides: Partial<PullRequestComment> = {},
): PullRequestComment {
  return {
    id,
    kind: "issue-comment",
    author: { login: "grace", isBot: false, avatarUrl: null },
    body: `body ${id}`,
    createdAt,
    url: null,
    reviewState: null,
    reactions: [],
    viewerIsAuthor: false,
    ...overrides,
  };
}

describe("buildPullRequestTimeline", () => {
  it("lists everything newest first and links a commit to its page on the host", () => {
    const events = buildPullRequestTimeline(TIMELINE_DETAIL, {
      comments: [timelineComment("c1", "2026-09-01T10:00:00.000Z")],
      commits: [
        {
          oid: "abc1234def",
          messageHeadline: "Add the review bar",
          committedDate: "2026-09-01T09:30:00.000Z",
          authorLogin: "ada",
        },
      ],
      reviewThreads: [],
    });

    expect(events.map((event) => event.id)).toEqual(["c1", "abc1234def", "opened"]);
    expect(events[1]?.url).toBe(
      "https://github.com/threadlines/threadlines/pull/42/commits/abc1234def",
    );
  });

  it("reports a merge rather than the close the host records alongside it", () => {
    const events = buildPullRequestTimeline(
      {
        ...TIMELINE_DETAIL,
        mergedAt: "2026-09-02T09:00:00.000Z",
        closedAt: "2026-09-02T09:00:00.000Z",
      },
      { comments: [], commits: [], reviewThreads: [] },
    );

    expect(events.map((event) => event.kind)).toEqual(["merged", "opened"]);
  });

  it("carries each remark written on a diff line, with the line it was written on", () => {
    const events = buildPullRequestTimeline(TIMELINE_DETAIL, {
      comments: [],
      commits: [],
      reviewThreads: [
        {
          id: "thread-1",
          path: "src/app.ts",
          line: 12,
          side: "right",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "line-1",
              author: { login: "grace", isBot: false, avatarUrl: null },
              body: "Name this something else.",
              createdAt: "2026-09-01T10:20:00.000Z",
              url: "https://github.com/threadlines/threadlines/pull/42#discussion_r1",
              reactions: [],
              viewerIsAuthor: false,
            },
            {
              id: "line-2",
              author: { login: "ada", isBot: false, avatarUrl: null },
              body: "Done.",
              createdAt: "2026-09-01T10:30:00.000Z",
              url: null,
              reactions: [],
              viewerIsAuthor: true,
            },
          ],
        },
      ],
    });

    expect(events.map((event) => event.id)).toEqual(["line-2", "line-1", "opened"]);
    expect(events[1]).toMatchObject({
      kind: "comment",
      body: "Name this something else.",
      actor: { login: "grace" },
      url: "https://github.com/threadlines/threadlines/pull/42#discussion_r1",
      path: "src/app.ts",
      line: 12,
    });
  });
});

describe("formatPullRequestBaseFreshness", () => {
  it("states the count when the host gave one and drops it when it did not", () => {
    const behind = { baseComparison: "behind", baseBranch: "main" } as const;

    expect(formatPullRequestBaseFreshness({ ...behind, behindBy: 3 })).toBe(
      "Behind main by 3 commits",
    );
    expect(formatPullRequestBaseFreshness({ ...behind, behindBy: 1 })).toBe(
      "Behind main by 1 commit",
    );
    expect(formatPullRequestBaseFreshness({ ...behind, behindBy: null })).toBe("Behind main");
    expect(
      formatPullRequestBaseFreshness({
        baseComparison: "up-to-date",
        baseBranch: "main",
        behindBy: null,
      }),
    ).toBeNull();
  });
});

describe("groupTimelineRows", () => {
  it("folds consecutive remarks and leaves a verdict and a commit standing", () => {
    const events = buildPullRequestTimeline(TIMELINE_DETAIL, {
      comments: [
        timelineComment("c1", "2026-09-01T10:00:00.000Z"),
        timelineComment("c2", "2026-09-01T10:05:00.000Z"),
        timelineComment("c3", "2026-09-01T10:10:00.000Z"),
        timelineComment("approval", "2026-09-01T10:15:00.000Z", {
          kind: "review",
          reviewState: "approved",
        }),
      ],
      commits: [
        {
          oid: "abc1234def",
          messageHeadline: "Add the review bar",
          committedDate: "2026-09-01T09:30:00.000Z",
          authorLogin: "ada",
        },
      ],
      reviewThreads: [],
    });

    const rows = groupTimelineRows(events);

    expect(
      rows.map((row) => (row.kind === "comments" ? `comments:${row.events.length}` : row.event.id)),
    ).toEqual(["approval", "comments:3", "abc1234def", "opened"]);
  });
});

describe("applyPendingPullRequestReactions", () => {
  it("moves the count while a press is in flight and drops a chip that empties", () => {
    const reactions = [
      { content: "thumbs-up" as const, count: 2, viewerReacted: false },
      { content: "heart" as const, count: 1, viewerReacted: true },
    ];

    expect(
      applyPendingPullRequestReactions(
        reactions,
        new Map([
          ["thumbs-up" as const, true],
          ["heart" as const, false],
        ]),
      ),
    ).toEqual([{ content: "thumbs-up", count: 3, viewerReacted: true }]);
  });
});
