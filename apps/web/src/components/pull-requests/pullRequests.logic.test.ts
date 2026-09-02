import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestListEntry,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary } from "../../types";
import {
  countNeedsYou,
  groupPullRequests,
  linkThreadsToPullRequests,
  matchesPullRequestQuery,
  pullRequestEntryKey,
  resolveNeedsYouReason,
  type PullRequestEntry,
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
    author: { login: "ada", isBot: false },
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

describe("matchesPullRequestQuery", () => {
  const row = entry({
    number: 412,
    title: "Add the pull requests page",
    author: { login: "ada", isBot: false },
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
