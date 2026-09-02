import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  type EnvironmentApi,
  type ExecutionEnvironmentDescriptor,
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
import type { ReactNode } from "react";
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
import { PullRequestsView } from "./PullRequestsView";

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
    author: { login: "ada", isBot: false },
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
    ...overrides,
  };
}

function makeEnvironmentApi(result: PullRequestListResult): EnvironmentApi {
  return {
    pullRequests: {
      list: vi.fn(async () => result),
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
      <QueryClientProvider client={queryClient}>
        <PullRequestsView state="open" onStateChange={() => undefined} />
      </QueryClientProvider>
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
