import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  type EnvironmentApi,
  type ExecutionEnvironmentDescriptor,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestListResult,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { useStore } from "../../store";
import { SidebarProvider } from "../ui/sidebar";
import { PullRequestsView } from "./PullRequestsView";
import { resetPullRequestTabsForTests } from "./pullRequestTabsStore";
import {
  DEFAULT_PULL_REQUEST_SORT,
  EMPTY_PULL_REQUEST_FILTERS,
  pullRequestFiltersToSearch,
  type PullRequestFilters,
  type PullRequestSelection,
  type PullRequestSort,
} from "./pullRequests.logic";

// The dialog watches the checkout's git status, which is a live subscription
// this page never drives. A frozen "not a repo" snapshot keeps it inert.
vi.mock("~/lib/gitStatusState", () => ({
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: async () => null,
  refreshLocalGitStatus: async () => null,
  resetGitStatusStateForTests: () => undefined,
}));

const ENVIRONMENT_ID = EnvironmentId.make("pull-requests-browser-test");
const PROJECT_ID = ProjectId.make("project-threadlines");
const CWD = "/repo/project";

const DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "This device",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true, pullRequests: true },
};

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
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
    additions: 12,
    deletions: 3,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    viewerIsAuthor: false,
    viewerReviewRequested: false,
    labels: [],
    origin: "workspace",
    ...overrides,
  };
}

/** What the GitHub provider reports it can do, as the detail carries it. */
const GITHUB_CAPABILITIES: PullRequestDetail["capabilities"] = {
  diff: true,
  comment: true,
  actions: ["merge", "close", "reopen", "ready", "draft"],
  mergeMethods: ["squash"],
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

function makeDetail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    provider: "github",
    projectId: PROJECT_ID,
    projectTitle: "Threadlines",
    workspaceRoot: CWD,
    repository: "threadlines/threadlines",
    number: 1,
    title: "Add the pull requests page",
    body: "",
    url: "https://github.com/threadlines/threadlines/pull/1",
    author: { login: "ada", isBot: false, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    headBranch: "feature/pull-requests",
    baseBranch: "main",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    viewerIsAuthor: false,
    reviewers: [],
    labels: [],
    checks: [],
    viewer: { canWrite: false, canReview: false, canManage: false },
    mergeMethods: ["squash"],
    capabilities: GITHUB_CAPABILITIES,
    baseComparison: "up-to-date",
    behindBy: 0,
    autoMergeEnabled: false,
    isStacked: false,
    defaultBranch: "main",
    ...overrides,
  };
}

function makeEnvironmentApi(result: PullRequestListResult): EnvironmentApi {
  return {
    pullRequests: {
      list: vi.fn(async () => result),
      detail: vi.fn(async () => makeDetail()),
      activity: vi.fn(async () => ({
        comments: [],
        commits: [],
        reviewThreads: [],
        reactions: [],
      })),
      diff: vi.fn(async () => ({ patch: "", truncated: false })),
      comment: vi.fn(async () => ({ url: null })),
    },
    git: {
      resolvePullRequest: vi.fn(async () => ({
        pullRequest: {
          number: 1,
          title: "Add the pull requests page",
          url: "https://github.com/threadlines/threadlines/pull/1",
          headBranch: "feature/pull-requests",
          baseBranch: "main",
          state: "open" as const,
        },
      })),
    },
  } as unknown as EnvironmentApi;
}

/** One workspace project so a row can find the checkout it belongs to. */
function seedProject(): void {
  useStore.setState({
    activeEnvironmentId: ENVIRONMENT_ID,
    environmentStateById: {
      [ENVIRONMENT_ID]: {
        projectIds: [PROJECT_ID],
        projectById: {
          [PROJECT_ID]: {
            id: PROJECT_ID,
            environmentId: ENVIRONMENT_ID,
            kind: "workspace",
            name: "Threadlines",
            cwd: CWD,
            // The remote is what names the host, which the sign-in page reads
            // to say which tool to sign in with.
            repositoryIdentity: {
              canonicalKey: "github.com/threadlines/threadlines",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/threadlines/threadlines.git",
              },
              displayName: "threadlines/threadlines",
              provider: "github",
              owner: "threadlines",
              name: "threadlines",
            },
          },
        },
        threadIds: [],
        threadIdsByProjectId: {},
        threadShellById: {},
        threadSessionById: {},
        threadTurnStateById: {},
        messageIdsByThreadId: {},
        messageByThreadId: {},
        activityIdsByThreadId: {},
        activityByThreadId: {},
        proposedPlanIdsByThreadId: {},
        proposedPlanByThreadId: {},
        turnDiffIdsByThreadId: {},
        turnDiffSummaryByThreadId: {},
        sidebarThreadSummaryById: {},
        bootstrapComplete: true,
      },
    },
  } as never);
}

function createTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => children });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

/** The params the route would have navigated with, as the page last wrote them. */
let lastSearch: Record<string, unknown> = {};

/** Stands in for the route, which owns the selection, the filters and the sort. */
function SelectablePullRequestsView() {
  const [selection, setSelection] = useState<PullRequestSelection | null>(null);
  const [filters, setFilters] = useState<PullRequestFilters>(EMPTY_PULL_REQUEST_FILTERS);
  const [sort, setSort] = useState<PullRequestSort>(DEFAULT_PULL_REQUEST_SORT);
  return (
    <PullRequestsView
      state="open"
      selection={selection}
      filters={filters}
      sort={sort}
      onStateChange={() => undefined}
      onSelectionChange={setSelection}
      onFiltersChange={(next) => {
        lastSearch = pullRequestFiltersToSearch(next, sort);
        setFilters(next);
      }}
      onSortChange={(next) => {
        lastSearch = pullRequestFiltersToSearch(filters, next);
        setSort(next);
      }}
    />
  );
}

async function renderPage(result: PullRequestListResult) {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, makeEnvironmentApi(result));
  useSavedEnvironmentRuntimeStore.getState().patch(ENVIRONMENT_ID, {
    connectionState: "connected",
    authState: "authenticated",
    descriptor: DESCRIPTOR,
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const host = document.createElement("div");
  host.style.width = "1000px";
  host.style.height = "900px";
  document.body.append(host);

  const router = createTestRouter(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <QueryClientProvider client={queryClient}>
          <SelectablePullRequestsView />
        </QueryClientProvider>
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("PullRequestsView", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    // The strip is a session, not a render: one test's open tabs would
    // otherwise still be open in the next one.
    resetPullRequestTabsForTests();
    seedProject();
  });

  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} } as never);
  });

  it("groups the open list by what needs the viewer", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({ number: 1, title: "Needs a review", viewerReviewRequested: true }),
        makeEntry({ number: 2, title: "Mine and quiet", viewerIsAuthor: true }),
        makeEntry({ number: 3, title: "Mine and approved", viewerIsAuthor: true }),
        makeEntry({ number: 4, title: "Someone else's work" }),
      ],
      errors: [],
    });

    await expect.element(page.getByText("Needs you · 1")).toBeVisible();
    await expect.element(page.getByText("Yours · 2")).toBeVisible();
    await expect.element(page.getByText("Others · 1")).toBeVisible();

    await rendered.cleanup();
  });

  it("asks the user to sign in when every project is unauthenticated", async () => {
    const rendered = await renderPage({
      viewer: null,
      entries: [],
      errors: [
        {
          projectId: PROJECT_ID,
          projectTitle: "Threadlines",
          repository: "threadlines/threadlines",
          reason: "unauthenticated",
          detail: "gh: not logged into any GitHub hosts",
        },
      ],
    });

    await expect.element(page.getByText("Sign in to GitHub CLI")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open Source Control settings" }))
      .toBeVisible();

    await rendered.cleanup();
  });

  it("opens a row into the detail column and closes back to the list", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [makeEntry()],
      errors: [],
    });

    await userEvent.click(page.getByTestId("pull-requests-row"));
    await expect.element(page.getByTestId("pull-requests-detail-column")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Close pull request details" }));
    expect(page.getByTestId("pull-requests-detail-column").elements()).toHaveLength(0);
    await expect.element(page.getByTestId("pull-requests-row")).toBeVisible();

    await rendered.cleanup();
  });

  it("keeps both open pull requests as tabs and closes back onto the other", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({ number: 1, title: "First" }),
        makeEntry({ number: 2, title: "Second" }),
      ],
      errors: [],
    });

    await userEvent.click(page.getByRole("button", { name: "Open pull request #1: First" }));
    await userEvent.click(page.getByRole("button", { name: "Open pull request #2: Second" }));

    const strip = page.getByTestId("pull-request-tab-strip");
    await expect.element(strip.getByRole("tab", { name: /#1/ })).toBeVisible();
    await expect.element(strip.getByRole("tab", { name: /#2/ })).toBeVisible();

    // Closing the one on screen falls back to what is left rather than back to
    // the bare list. Both the tab and its ✕ are named by repository as well as
    // number, since two repositories can hold the same one.
    await userEvent.click(page.getByRole("button", { name: "Close threadlines/threadlines #2" }));

    await vi.waitFor(() => {
      expect(strip.getByRole("tab", { name: /#2/ }).elements()).toHaveLength(0);
    });
    await expect.element(strip.getByRole("tab", { name: /#1/ })).toBeVisible();
    await expect.element(page.getByTestId("pull-requests-detail-column")).toBeVisible();

    await rendered.cleanup();
  });

  it("walks the tab strip with the arrow keys and hands focus on after a close", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({ number: 1, title: "First" }),
        makeEntry({ number: 2, title: "Second" }),
      ],
      errors: [],
    });

    await userEvent.click(page.getByRole("button", { name: "Open pull request #1: First" }));
    await userEvent.click(page.getByRole("button", { name: "Open pull request #2: Second" }));

    const strip = page.getByTestId("pull-request-tab-strip");
    const second = strip.getByRole("tab", { name: /#2/ });
    await userEvent.click(second);
    // The arrows only move the detail; handing the cursor to the new title
    // would end the walk on its first step.
    await userEvent.keyboard("{ArrowLeft}");
    // The title is what used to take the cursor, so the check waits until it is
    // on screen before asking where the cursor is.
    await expect
      .element(page.getByRole("heading", { name: "Add the pull requests page" }))
      .toBeVisible();
    const walked = document.activeElement;
    expect(walked?.getAttribute("role")).toBe("tab");
    expect(walked?.textContent).toContain("#1");
    expect(walked?.getAttribute("aria-selected")).toBe("true");

    // A ✕ pressed from the keyboard takes its own element away, so the tab that
    // steps into its place takes the cursor.
    const close = page.getByRole("button", { name: "Close threadlines/threadlines #1" });
    close.element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      const focused = document.activeElement;
      expect(focused?.getAttribute("role")).toBe("tab");
      expect(focused?.textContent).toContain("#2");
    });

    await rendered.cleanup();
  });

  it("steps back to the list from the detail on a phone", async () => {
    await page.viewport(390, 800);
    try {
      const rendered = await renderPage({
        viewer: "ada",
        entries: [makeEntry()],
        errors: [],
      });

      await userEvent.click(page.getByTestId("pull-requests-row"));
      await expect.element(page.getByTestId("pull-requests-detail-column")).toBeVisible();
      // The detail stands in for the list here, so the way out is a step back
      // rather than the close that sits beside a visible list.
      await expect.element(page.getByTestId("pull-requests-row")).not.toBeVisible();
      expect(
        page.getByRole("button", { name: "Close pull request details" }).elements(),
      ).toHaveLength(0);

      await userEvent.click(page.getByRole("button", { name: "Back to pull requests" }));
      await expect.element(page.getByTestId("pull-requests-row")).toBeVisible();
      expect(page.getByTestId("pull-requests-detail-column").elements()).toHaveLength(0);

      await rendered.cleanup();
    } finally {
      await page.viewport(1_600, 1_300);
    }
  });

  it("narrows the list from the filters menu and gives the rows back from the chip", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({ number: 1, title: "Mine", viewerIsAuthor: true }),
        makeEntry({
          number: 2,
          title: "Someone else's",
          author: { login: "grace", isBot: false, avatarUrl: null },
        }),
      ],
      errors: [],
    });

    await expect.element(page.getByText("Someone else's")).toBeVisible();
    await userEvent.click(page.getByTestId("pull-requests-filters"));
    // The authors are the ones the loaded rows carry, so ada is a line to pick
    // rather than a login to spell.
    await userEvent.click(page.getByRole("menuitem", { name: /^Author/ }));
    // The field keeps its own typing: a menu would otherwise read the letters
    // as a jump to the item that starts with them.
    await userEvent.fill(page.getByRole("textbox", { name: "Search authors" }), "ad");
    // One author at a time, so the choices are radios and a reader hears which
    // one is current.
    await vi.waitFor(() => {
      expect(
        page.getByRole("menuitemradio", { name: "grace", exact: true }).elements(),
      ).toHaveLength(0);
    });
    await userEvent.click(page.getByRole("menuitemradio", { name: "ada", exact: true }));

    await expect.element(page.getByText("Author: ada")).toBeVisible();
    // What the route would put in the URL, which is how a link keeps the filter.
    expect(lastSearch).toEqual({ author: "ada" });
    await vi.waitFor(() => {
      expect(page.getByTestId("pull-requests-row").elements()).toHaveLength(1);
    });

    await userEvent.click(page.getByRole("button", { name: "Remove filter Author: ada" }));
    await expect.element(page.getByText("Someone else's")).toBeVisible();

    await rendered.cleanup();
  });

  it("draws the conflict, the reviews, the checks and an author the host gave no picture for", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({
          number: 7,
          title: "Bump the runner",
          author: { login: "dependabot[bot]", isBot: true, avatarUrl: null },
          mergeability: "conflicting",
          reviewDecision: "approved",
          checksState: "failure",
          labels: [{ name: "dependencies", color: "0366d6" }],
        }),
      ],
      errors: [],
    });

    await expect.element(page.getByText("Bump the runner")).toBeVisible();
    // The triangle stands in for the open glyph, and says so in words.
    expect(page.getByText("Conflicts with main").elements()).toHaveLength(1);
    // The reviews and the checks are both glyphs, and each carries the words
    // the row no longer spends its meta line on.
    expect(page.getByText("Approved").elements()).toHaveLength(1);
    expect(page.getByText("Some checks failed").elements()).toHaveLength(1);
    // No picture to load, so the avatar is the login's first letter.
    expect(document.querySelectorAll("#pull-requests-list img")).toHaveLength(0);
    expect(
      [...document.querySelectorAll("#pull-requests-list span")].filter(
        (element) => element.textContent === "D",
      ),
    ).toHaveLength(1);

    await rendered.cleanup();
  });

  it("names the repository of a pull request from outside the workspace", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({
          number: 9,
          title: "Teach the runner to wait",
          origin: "authored",
          repository: "openai/codex",
          projectTitle: "openai/codex",
          url: "https://github.com/openai/codex/pull/9",
          viewerIsAuthor: true,
        }),
      ],
      errors: [],
    });

    // The list spans one repository, so only the row's own origin earns it a name.
    await expect.element(page.getByText("openai/codex")).toBeVisible();
    // Nothing here is checked out on that branch, so there is nothing to open.
    expect(page.getByRole("button", { name: "Review in a thread" }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Open on GitHub" }).elements()).toHaveLength(1);

    await rendered.cleanup();
  });

  it("opens the checkout dialog prefilled with the pull request URL", async () => {
    const rendered = await renderPage({
      viewer: "ada",
      entries: [
        makeEntry({ number: 42, url: "https://github.com/threadlines/threadlines/pull/42" }),
      ],
      errors: [],
    });

    await expect.element(page.getByTestId("pull-requests-row")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Review in a thread" }));

    const referenceInput = page.getByPlaceholder(/URL, checkout command/);
    await expect.element(referenceInput).toBeVisible();
    await expect
      .element(referenceInput)
      .toHaveValue("https://github.com/threadlines/threadlines/pull/42");

    await rendered.cleanup();
  });
});
