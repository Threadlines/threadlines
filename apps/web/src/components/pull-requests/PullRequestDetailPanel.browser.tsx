import "../../index.css";

import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EnvironmentApi,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReviewThread,
  type ScopedThreadRef,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const ENVIRONMENT_ID = EnvironmentId.make("pull-request-detail-test");
const PROJECT_ID = ProjectId.make("project-threadlines");
const REFERENCE: PullRequestRef = {
  projectId: PROJECT_ID,
  repository: "threadlines/threadlines",
  number: 42,
};

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export { a };
`;

/** What the GitHub provider reports it can do, as the detail carries it. */
const CAPABILITIES: PullRequestDetail["capabilities"] = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "close",
    "reopen",
    "ready",
    "draft",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["squash", "merge"],
  updateMethods: ["merge", "rebase"],
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { pullRequest: true, comment: true },
};

const DETAIL: PullRequestDetail = {
  provider: "github",
  projectId: PROJECT_ID,
  projectTitle: "Threadlines",
  workspaceRoot: "/repo/threadlines",
  repository: "threadlines/threadlines",
  number: 42,
  title: "Read a pull request in the app",
  body: "Adds the detail surface.",
  url: "https://github.com/threadlines/threadlines/pull/42",
  author: { login: "ada", isBot: false, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 120,
  deletions: 8,
  changedFiles: 1,
  headBranch: "feature/pull-requests",
  baseBranch: "main",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  viewerIsAuthor: true,
  reviewers: [{ id: "grace", kind: "user", login: "grace", state: "pending", avatarUrl: null }],
  labels: [],
  checks: [
    { name: "build", status: "success", description: "Passed in 2m", url: null },
    { name: "lint", status: "failure", description: "2 errors", url: "https://ci.example/lint" },
  ],
  checksState: "failure",
  // The viewer's own pull request on a repository they cannot push to: theirs
  // to close and rewrite, nobody's to merge, and not theirs to review.
  viewer: { canWrite: false, canReview: false, canManage: true },
  mergeMethods: ["squash", "merge"],
  capabilities: CAPABILITIES,
  baseComparison: "up-to-date",
  behindBy: 0,
  autoMergeEnabled: false,
  isStacked: false,
  defaultBranch: "main",
};

const THREAD: PullRequestReviewThread = {
  id: "thread-1",
  path: "src/app.ts",
  line: 2,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id: "thread-comment-1",
      author: { login: "grace", isBot: false, avatarUrl: null },
      body: "Name this something else.",
      createdAt: "2026-09-01T11:30:00.000Z",
      url: null,
      reactions: [],
      viewerIsAuthor: false,
    },
  ],
};

function makeComment(id: string, createdAt: string, body = `body ${id}`): PullRequestComment {
  return {
    id,
    kind: "issue-comment",
    author: { login: "grace", isBot: false, avatarUrl: null },
    body,
    createdAt,
    url: null,
    reviewState: null,
    reactions: [],
    viewerIsAuthor: false,
  };
}

const ACTIVITY: PullRequestActivity = {
  comments: [makeComment("comment-1", "2026-09-01T11:00:00.000Z", "Looks good to me.")],
  commits: [],
  reviewThreads: [THREAD],
  reactions: [],
};

function createTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => children });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

async function renderPanel(
  options: {
    readonly detail?: Partial<PullRequestDetail>;
    readonly activity?: Partial<PullRequestActivity>;
    /** Makes the conversation read fail, which the meta rows answer for. */
    readonly activityFails?: boolean;
    readonly composerTarget?: ScopedThreadRef;
  } = {},
) {
  const comment = vi.fn(async () => ({ url: null }));
  const runAction = vi.fn(async () => ({ state: "merged" as const, isDraft: false }));
  const submitReview = vi.fn(async () => ({ url: null }));
  const setThreadResolution = vi.fn(async () => undefined);
  const requestReviewers = vi.fn(async () => undefined);
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    pullRequests: {
      detail: vi.fn(async () => ({ ...DETAIL, ...options.detail })),
      activity: vi.fn(async () => {
        if (options.activityFails) {
          throw new Error("the host said no");
        }
        return { ...ACTIVITY, ...options.activity };
      }),
      diff: vi.fn(async () => ({ patch: PATCH, truncated: false })),
      comment,
      runAction,
      submitReview,
      setThreadResolution,
      replyToThread: vi.fn(async () => undefined),
      setReaction: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      updateComment: vi.fn(async () => undefined),
      reviewerCandidates: vi.fn(async () => ({
        candidates: [
          {
            id: "grace",
            kind: "user" as const,
            login: "grace",
            name: "Grace H",
            avatarUrl: null,
            requested: false,
          },
        ],
      })),
      requestReviewers,
    },
  } as unknown as EnvironmentApi);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const host = document.createElement("div");
  host.style.width = "720px";
  host.style.height = "800px";
  document.body.append(host);

  const router = createTestRouter(
    <QueryClientProvider client={queryClient}>
      <PullRequestDetailPanel
        environmentId={ENVIRONMENT_ID}
        reference={REFERENCE}
        context={options.composerTarget ? "thread" : "page"}
        {...(options.composerTarget ? { composerTarget: options.composerTarget } : {})}
      />
    </QueryClientProvider>,
  );
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    comment,
    runAction,
    submitReview,
    setThreadResolution,
    requestReviewers,
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("PullRequestDetailPanel", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    usePullRequestReviewStore.getState().discard(pullRequestReviewKey(ENVIRONMENT_ID, REFERENCE));
    // The merge dialog remembers this per computer, so one test's tick would
    // otherwise be the next one's default.
    window.localStorage.removeItem(`threadlines:pull-requests:delete-branch:v1:${ENVIRONMENT_ID}`);
  });

  it("renders the header, the checks that need attention, and the conversation", async () => {
    const rendered = await renderPanel();

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    await expect.element(page.getByText("feature/pull-requests")).toBeVisible();
    // A failing check earns a row; a green one is only counted until asked for.
    await expect.element(page.getByText("1 failing, 1 passed")).toBeVisible();
    await expect.element(page.getByText("lint")).toBeVisible();
    expect(page.getByText("build").elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Show all 2" }));
    await expect.element(page.getByText("build")).toBeVisible();
    await expect.element(page.getByText("Looks good to me.")).toBeVisible();

    await rendered.cleanup();
  });

  it("renders the patch's files under the Code tab", async () => {
    const rendered = await renderPanel();

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    await userEvent.click(page.getByRole("tab", { name: /Code/ }));

    await expect.element(page.getByTitle("src/app.ts")).toBeVisible();

    await rendered.cleanup();
  });

  it("drops the Code tab and the comment box on a host that has neither", async () => {
    const rendered = await renderPanel({
      detail: {
        provider: "azure-devops",
        capabilities: {
          ...CAPABILITIES,
          diff: false,
          comment: false,
          review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        },
      },
    });

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Summary" })).toBeVisible();
    expect(page.getByRole("tab", { name: /Code/ }).elements()).toHaveLength(0);
    expect(page.getByTestId("pull-request-comment-input").elements()).toHaveLength(0);

    await rendered.cleanup();
  });

  it("posts a comment and clears the box", async () => {
    const rendered = await renderPanel();

    const box = page.getByTestId("pull-request-comment-input");
    await expect.element(box).toBeVisible();
    await userEvent.fill(box, "Shipping this.");
    // Exactly "Comment": the Summary now also carries a "1 comment" button
    // that jumps to the conversation, and a substring match takes both.
    await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }));

    await vi.waitFor(() => {
      expect(rendered.comment).toHaveBeenCalledWith({ ...REFERENCE, body: "Shipping this." });
    });
    await expect.element(box).toHaveValue("");

    await rendered.cleanup();
  });

  it("offers an author without push access only what the host lets them do", async () => {
    const rendered = await renderPanel();

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    // Landing the branch needs push access; closing your own pull request and
    // rewriting its words do not.
    expect(page.getByTestId("pull-request-merge").elements()).toHaveLength(0);
    await expect.element(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(page.getByTestId("pull-request-edit-title").elements()).toHaveLength(1);
    // No review verdicts either, because a host refuses a self-approval.
    expect(page.getByTestId("pull-request-verdict-approve").elements()).toHaveLength(0);

    await rendered.cleanup();
  });

  it("confirms a merge by name and method before running it", async () => {
    const rendered = await renderPanel({
      detail: { viewer: { canWrite: true, canReview: false, canManage: true } },
    });

    await userEvent.click(page.getByTestId("pull-request-merge"));
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("Merge #42 into main?")).toBeVisible();
    await expect.element(dialog.getByText("Squash and merge.")).toBeVisible();

    await userEvent.click(dialog.getByRole("button", { name: "Merge" }));

    await vi.waitFor(() => {
      expect(rendered.runAction).toHaveBeenCalledWith({
        ...REFERENCE,
        action: "merge",
        mergeMethod: "squash",
      });
    });

    await rendered.cleanup();
  });

  it("switches the submit control to the chosen verdict and submits a review", async () => {
    const rendered = await renderPanel({
      detail: {
        viewerIsAuthor: false,
        viewer: { canWrite: false, canReview: true, canManage: false },
      },
    });

    const submit = page.getByTestId("pull-request-comment-submit");
    await expect.element(submit).toHaveTextContent("Comment");

    await userEvent.click(page.getByTestId("pull-request-verdict-request-changes"));
    await expect.element(submit).toHaveTextContent("Request changes");

    await userEvent.fill(page.getByTestId("pull-request-comment-input"), "Please rename this.");
    await userEvent.click(submit);

    await vi.waitFor(() => {
      expect(rendered.submitReview).toHaveBeenCalledWith({
        ...REFERENCE,
        verdict: "request-changes",
        body: "Please rename this.",
        comments: [],
      });
    });

    await rendered.cleanup();
  });

  it("hands a comment to the thread's composer as a quoted prompt", async () => {
    const composerTarget = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-handoff-test"));
    const rendered = await renderPanel({ composerTarget });

    await userEvent.click(page.getByRole("button", { name: "Send to thread" }));

    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().getComposerDraft(composerTarget)?.prompt).toBe(
        "Address this review comment on pull request #42 by grace:\n\n> Looks good to me.",
      );
    });

    useComposerDraftStore.getState().setPrompt(composerTarget, "");
    await rendered.cleanup();
  });

  it("hands a finding to the composer, then puts the next hand-off in its place", async () => {
    const composerTarget = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-fix-test"));
    const rendered = await renderPanel({ composerTarget });
    const prompt = () =>
      useComposerDraftStore.getState().getComposerDraft(composerTarget)?.prompt ?? "";

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    await userEvent.click(page.getByRole("tab", { name: /Code/ }));
    await userEvent.click(page.getByTestId("pull-request-fix-thread"));

    await vi.waitFor(() => {
      expect(prompt()).toContain(
        "Fix the review finding below on branch feature/pull-requests of PR #42",
      );
      expect(prompt()).toContain("> Name this something else.");
    });

    await userEvent.click(page.getByRole("button", { name: "More pull request actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Explain this pull request" }));

    // The second hand-off takes the first one's place rather than stacking.
    await vi.waitFor(() => {
      expect(prompt()).toContain("Explain this pull request.");
      expect(prompt()).not.toContain("Fix the review finding");
    });

    useComposerDraftStore.getState().setPrompt(composerTarget, "");
    await rendered.cleanup();
  });

  it("pins a conversation to its line in the diff and resolves it", async () => {
    const rendered = await renderPanel();

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    await userEvent.click(page.getByRole("tab", { name: /Code/ }));

    await expect.element(page.getByText("Name this something else.")).toBeVisible();
    await userEvent.click(page.getByTestId("pull-request-thread-resolve"));

    await vi.waitFor(() => {
      expect(rendered.setThreadResolution).toHaveBeenCalledWith({
        ...REFERENCE,
        threadId: "thread-1",
        resolved: true,
      });
    });

    await rendered.cleanup();
  });

  it("sends the review the bar is holding, comments and all", async () => {
    const rendered = await renderPanel({
      detail: {
        viewerIsAuthor: false,
        viewer: { canWrite: false, canReview: true, canManage: false },
      },
    });
    usePullRequestReviewStore
      .getState()
      .addComment(pullRequestReviewKey(ENVIRONMENT_ID, REFERENCE), {
        id: "pending-1",
        path: "src/app.ts",
        position: { kind: "added", newLine: 2 },
        body: "Name this something else.",
      });

    await userEvent.click(page.getByRole("tab", { name: /Code/ }));

    await expect
      .element(page.getByTestId("pull-request-review-bar-count"))
      .toHaveTextContent("1 comment");
    await userEvent.click(page.getByTestId("pull-request-review-bar-approve"));

    await vi.waitFor(() => {
      expect(rendered.submitReview).toHaveBeenCalledWith({
        ...REFERENCE,
        verdict: "approve",
        body: "",
        comments: [
          {
            id: "pending-1",
            path: "src/app.ts",
            position: { kind: "added", newLine: 2 },
            body: "Name this something else.",
          },
        ],
      });
    });

    await rendered.cleanup();
  });

  it("folds a run of comments on the Timeline into one group", async () => {
    const rendered = await renderPanel({
      activity: {
        comments: [
          makeComment("c1", "2026-09-01T11:00:00.000Z"),
          makeComment("c2", "2026-09-01T11:05:00.000Z"),
          makeComment("c3", "2026-09-01T11:10:00.000Z"),
        ],
        // The timeline carries line comments too, and the fixture's thread has
        // one; this test is about the run of three, so it stands alone.
        reviewThreads: [],
      },
    });

    await userEvent.click(page.getByRole("tab", { name: "Timeline" }));

    const group = page.getByTestId("pull-request-timeline-group");
    await expect.element(group).toHaveTextContent("3 comments");
    await expect.element(group).not.toHaveTextContent("body c2");
    await userEvent.click(group.getByRole("button"));
    await expect.element(group).toHaveTextContent("body c2");

    await rendered.cleanup();
  });

  it("offers Update branch only while the branch is behind its base", async () => {
    const current = await renderPanel({
      detail: { viewer: { canWrite: true, canReview: false, canManage: true } },
    });
    await expect.element(page.getByTestId("pull-request-merge")).toBeVisible();
    expect(page.getByTestId("pull-request-update-branch").elements()).toHaveLength(0);
    await current.cleanup();

    const behind = await renderPanel({
      detail: {
        viewer: { canWrite: true, canReview: false, canManage: true },
        baseComparison: "behind",
        behindBy: 3,
      },
    });
    // The branch line carries how far behind it is; the full sentence is its
    // tooltip. Update branch takes the primary slot while it is behind, and the
    // merge it displaces moves into the menu rather than disappearing.
    await expect.element(page.getByTestId("pull-request-behind")).toHaveTextContent("behind by 3");
    expect(page.getByTestId("pull-request-merge").elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "More pull request actions" }));
    await expect.element(page.getByTestId("pull-request-merge-menu-item")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(page.getByTestId("pull-request-update-branch"));
    await userEvent.click(page.getByRole("menuitem", { name: "Rebase onto main" }));

    await vi.waitFor(() => {
      expect(behind.runAction).toHaveBeenCalledWith({
        ...REFERENCE,
        action: "update-branch",
        updateMethod: "rebase",
      });
    });

    await behind.cleanup();
  });

  it("keeps Merge on screen but off while the host's rules refuse it, and says why", async () => {
    const rendered = await renderPanel({
      detail: {
        viewer: { canWrite: true, canReview: false, canManage: true },
        mergeGate: "blocked",
        checks: [
          { name: "build", status: "success", description: null, url: null },
          { name: "lint", status: "pending", description: null, url: null },
          { name: "test", status: "pending", description: null, url: null },
        ],
        checksState: "pending",
      },
    });

    await expect.element(page.getByTestId("pull-request-merge")).toBeDisabled();
    await expect
      .element(page.getByTestId("pull-request-merge-block"))
      .toHaveTextContent("Waiting on 2 checks");

    await rendered.cleanup();
  });

  it("asks someone for a review from the reviewers row", async () => {
    const rendered = await renderPanel({
      detail: { viewer: { canWrite: true, canReview: false, canManage: true } },
    });

    await userEvent.click(page.getByTestId("pull-request-request-reviewers"));
    // The row's own label is what names it, since it says which way the click
    // goes rather than repeating the person's name.
    await userEvent.click(page.getByRole("button", { name: "Request review from grace" }));

    await vi.waitFor(() => {
      expect(rendered.requestReviewers).toHaveBeenCalledWith({
        ...REFERENCE,
        reviewers: [{ id: "grace", kind: "user" }],
        requested: true,
      });
    });

    await rendered.cleanup();
  });

  it("offers only the writes a host says it takes", async () => {
    // A Bitbucket-shaped host: it merges and closes, and knows nothing of
    // drafts, auto-merge or reactions.
    const bitbucket = {
      provider: "bitbucket" as const,
      viewer: { canWrite: true, canReview: false, canManage: true },
      capabilities: {
        ...CAPABILITIES,
        actions: ["merge", "close"] as const,
        reactions: false,
      },
    };
    const open = await renderPanel({ detail: bitbucket });

    await expect.element(page.getByTestId("pull-request-merge")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    // Nothing left for the menu to hold, so there is no menu to open.
    expect(page.getByRole("button", { name: "More pull request actions" }).elements()).toHaveLength(
      0,
    );

    await open.cleanup();

    const closed = await renderPanel({
      detail: { ...bitbucket, state: "closed", capabilities: bitbucket.capabilities },
    });

    await expect.element(page.getByText("Read a pull request in the app")).toBeVisible();
    expect(page.getByRole("button", { name: "Reopen" }).elements()).toHaveLength(0);

    await closed.cleanup();
  });

  it("copies the command that takes this branch on another machine", async () => {
    const writeText = vi.fn(async () => undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const rendered = await renderPanel();

    try {
      await userEvent.click(page.getByTestId("pull-request-checkout-command"));
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("gh pr checkout 42");
      });
      // "Copied" is the only sign it worked, so the button's name says it too
      // rather than staying "Copy" for anyone who cannot see the word.
      await expect
        .element(page.getByRole("button", { name: "Copied gh pr checkout 42" }))
        .toBeVisible();
    } finally {
      if (previous) {
        Object.defineProperty(navigator, "clipboard", previous);
      }
      await rendered.cleanup();
    }
  });

  it("says why the comment count is missing rather than offering a button with none", async () => {
    const rendered = await renderPanel({ activityFails: true });

    await expect
      .element(page.getByTestId("pull-request-comment-count"))
      .toHaveTextContent("Comments unavailable");
    // Nothing to scroll to, so nothing to press.
    expect(page.getByRole("button", { name: "Comments unavailable" }).elements()).toHaveLength(0);

    await rendered.cleanup();
  });

  it("folds the description away and back", async () => {
    const rendered = await renderPanel();

    await expect.element(page.getByText("Adds the detail surface.")).toBeVisible();
    await userEvent.click(page.getByTestId("pull-request-description-toggle"));
    await vi.waitFor(() => {
      expect(page.getByText("Adds the detail surface.").elements()).toHaveLength(0);
    });

    await userEvent.click(page.getByTestId("pull-request-description-toggle"));
    await expect.element(page.getByText("Adds the detail surface.")).toBeVisible();

    await rendered.cleanup();
  });

  it("passes the delete-branch choice to the merge", async () => {
    const rendered = await renderPanel({
      detail: { viewer: { canWrite: true, canReview: false, canManage: true } },
    });

    await userEvent.click(page.getByTestId("pull-request-merge"));
    const dialog = page.getByRole("alertdialog");
    await userEvent.click(dialog.getByTestId("pull-request-delete-branch"));
    await userEvent.click(dialog.getByRole("button", { name: "Merge" }));

    await vi.waitFor(() => {
      expect(rendered.runAction).toHaveBeenCalledWith({
        ...REFERENCE,
        action: "merge",
        mergeMethod: "squash",
        deleteBranch: true,
      });
    });

    await rendered.cleanup();
  });
});
