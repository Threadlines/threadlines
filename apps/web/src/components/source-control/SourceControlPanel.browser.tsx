import "../../index.css";

import {
  EnvironmentId,
  type EnvironmentApi,
  type VcsCommitGraphResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { __resetLocalApiForTests } from "../../localApi";
import { SourceControlPanel, type SourceControlProjectTarget } from "./SourceControlPanel";

const gitStatusMock = vi.hoisted(() => ({
  data: null as VcsStatusResult | null,
  refreshGitStatus: vi.fn(async () => null),
  refreshLocalGitStatus: vi.fn(async () => null),
}));

vi.mock("~/lib/gitStatusState", () => ({
  useGitStatus: () => ({
    data: gitStatusMock.data,
    error: null,
    cause: null,
    isPending: false,
  }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: gitStatusMock.refreshGitStatus,
  refreshLocalGitStatus: gitStatusMock.refreshLocalGitStatus,
  resetGitStatusStateForTests: () => {
    gitStatusMock.data = null;
  },
}));

const ENVIRONMENT_ID = EnvironmentId.make("source-control-browser-test");
const CWD = "/repo/project";
const TARGET: SourceControlProjectTarget = {
  environmentId: ENVIRONMENT_ID,
  cwd: CWD,
  name: "BadCode",
  environmentLabel: null,
  worktreePath: null,
};

const GRAPH: VcsCommitGraphResult = {
  truncated: false,
  commits: [
    {
      sha: "abc1234abc1234abc1234abc1234abc1234abc1234",
      shortSha: "abc1234",
      parents: [
        "def5678def5678def5678def5678def5678def5678",
        "fed4321fed4321fed4321fed4321fed4321fed4321",
      ],
      refs: ["main", "origin/main", "origin/HEAD", "refs/tags/v1.0.0"],
      subject: "Polish source control graph",
      authorName: "Ada Lovelace",
      committedAt: "2026-05-25T12:00:00.000Z",
    },
    {
      sha: "def5678def5678def5678def5678def5678def5678",
      shortSha: "def5678",
      parents: ["0000001000000100000010000001000000100001"],
      refs: [],
      subject: "Prepare base timeline",
      authorName: "Grace Hopper",
      committedAt: "2026-05-24T12:00:00.000Z",
    },
    {
      sha: "fed4321fed4321fed4321fed4321fed4321fed4321",
      shortSha: "fed4321",
      parents: ["0000001000000100000010000001000000100001"],
      refs: ["origin/feature/source-control"],
      subject: "Refine source control branch",
      authorName: "Grace Hopper",
      committedAt: "2026-05-24T11:00:00.000Z",
    },
    {
      sha: "0000001000000100000010000001000000100001",
      shortSha: "0000001",
      parents: [],
      refs: [],
      subject: "Initial import",
      authorName: "Grace Hopper",
      committedAt: "2026-05-23T12:00:00.000Z",
    },
  ],
};

function makeStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  const baseStatus: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
  return {
    ...baseStatus,
    ...overrides,
    workingTree: overrides.workingTree ?? baseStatus.workingTree,
  };
}

function makeEnvironmentApi(
  overrides: { readonly vcs?: Partial<EnvironmentApi["vcs"]> } = {},
): EnvironmentApi {
  return {
    vcs: {
      listRefs: vi.fn(async () => ({
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
        refs: [
          {
            name: "main",
            current: true,
            isDefault: true,
            worktreePath: null,
          },
        ],
      })),
      commitGraph: vi.fn(async () => GRAPH),
      discardChanges: vi.fn(async (input: { readonly filePaths: string[] }) => ({
        discardedPaths: input.filePaths,
      })),
      stageChanges: vi.fn(async (input: { readonly filePaths: string[] }) => ({
        stagedPaths: input.filePaths,
      })),
      unstageChanges: vi.fn(async (input: { readonly filePaths: string[] }) => ({
        unstagedPaths: input.filePaths,
      })),
      createTag: vi.fn(async (input: { readonly tagName: string; readonly targetSha: string }) => ({
        tagName: input.tagName,
        targetSha: input.targetSha,
      })),
      deleteBranch: vi.fn(async (input: { readonly branchName: string }) => ({
        branchName: input.branchName,
      })),
      ...overrides.vcs,
    },
  } as unknown as EnvironmentApi;
}

function createTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => children,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

async function renderPanel(
  input: {
    readonly status?: VcsStatusResult;
    readonly environmentApi?: EnvironmentApi;
  } = {},
) {
  const environmentApi = input.environmentApi ?? makeEnvironmentApi();
  gitStatusMock.data = input.status ?? makeStatus();
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, environmentApi);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  host.style.width = "420px";
  host.style.height = "720px";
  document.body.append(host);

  const router = createTestRouter(
    <QueryClientProvider client={queryClient}>
      <SourceControlPanel target={TARGET} activeThreadRef={null} />
    </QueryClientProvider>,
  );
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    environmentApi,
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("SourceControlPanel changes", () => {
  beforeEach(async () => {
    gitStatusMock.refreshGitStatus.mockClear();
    gitStatusMock.refreshLocalGitStatus.mockClear();
    window.localStorage.clear();
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    __resetEnvironmentApiOverridesForTests();
    await __resetLocalApiForTests();
  });

  it("confirms and discards a selected file change", async () => {
    const discardChanges: EnvironmentApi["vcs"]["discardChanges"] = vi.fn(async (input) => ({
      discardedPaths: input.filePaths,
    }));
    const status = makeStatus({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "src/app.ts",
            indexStatus: null,
            worktreeStatus: "modified",
            insertions: 2,
            deletions: 1,
          },
          {
            path: "src/new.ts",
            indexStatus: null,
            worktreeStatus: "untracked",
            insertions: 1,
            deletions: 0,
          },
        ],
        insertions: 3,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({
      status,
      environmentApi: makeEnvironmentApi({ vcs: { discardChanges } }),
    });

    try {
      await expect.element(page.getByText("app.ts")).toBeVisible();
      const statusBadge = document.querySelector('[title="Working tree: Modified"]');
      expect(statusBadge).toBeInstanceOf(HTMLElement);
      expect(statusBadge?.textContent).toBe("M");
      const untrackedBadge = document.querySelector('[title="Untracked"]');
      expect(untrackedBadge).toBeInstanceOf(HTMLElement);
      expect(untrackedBadge?.textContent).toBe("U");

      await page.getByRole("button", { name: "Discard changes to src/app.ts" }).click();

      await expect.element(page.getByText("Discard changes?")).toBeVisible();
      await expect.element(page.getByText(/Staged changes will be preserved/)).toBeVisible();

      await page.getByRole("button", { name: "Discard" }).click();

      await vi.waitFor(() => {
        expect(discardChanges).toHaveBeenCalledWith({
          cwd: CWD,
          filePaths: ["src/app.ts"],
          scope: "unstaged",
        });
      });
      await vi.waitFor(() => {
        expect(gitStatusMock.refreshGitStatus).toHaveBeenCalledWith({
          environmentId: ENVIRONMENT_ID,
          cwd: CWD,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles changed files into a compact tree view", async () => {
    const status = makeStatus({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "apps/web/src/components/source-control/SourceControlPanel.tsx",
            indexStatus: null,
            worktreeStatus: "modified",
            insertions: 2,
            deletions: 1,
          },
          {
            path: "apps/web/src/components/source-control/SourceControlPanel.browser.tsx",
            indexStatus: null,
            worktreeStatus: "modified",
            insertions: 11,
            deletions: 1,
          },
        ],
        insertions: 13,
        deletions: 2,
      },
    });
    const mounted = await renderPanel({ status });

    try {
      await page.getByRole("button", { name: "View changes as tree" }).click();

      await expect
        .element(page.getByRole("button", { name: "View changes as list" }))
        .toBeVisible();
      await expect.element(page.getByText("apps/web/src/components/source-control")).toBeVisible();
      await expect.element(page.getByText("SourceControlPanel.tsx")).toBeVisible();
      await expect.element(page.getByText("SourceControlPanel.browser.tsx")).toBeVisible();

      await page
        .getByRole("button", { name: "Collapse apps/web/src/components/source-control" })
        .click();

      await expect.element(page.getByText("SourceControlPanel.tsx")).not.toBeInTheDocument();
      await expect
        .element(page.getByText("SourceControlPanel.browser.tsx"))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("separates staged and unstaged changes with scoped row actions", async () => {
    const stageChanges: EnvironmentApi["vcs"]["stageChanges"] = vi.fn(async (input) => ({
      stagedPaths: input.filePaths,
    }));
    const unstageChanges: EnvironmentApi["vcs"]["unstageChanges"] = vi.fn(async (input) => ({
      unstagedPaths: input.filePaths,
    }));
    const status = makeStatus({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "README.md",
            indexStatus: "modified",
            worktreeStatus: null,
            insertions: 4,
            deletions: 1,
            stagedInsertions: 4,
            stagedDeletions: 1,
            unstagedInsertions: 0,
            unstagedDeletions: 0,
          },
          {
            path: "src/app.ts",
            indexStatus: null,
            worktreeStatus: "modified",
            insertions: 2,
            deletions: 0,
            stagedInsertions: 0,
            stagedDeletions: 0,
            unstagedInsertions: 2,
            unstagedDeletions: 0,
          },
        ],
        insertions: 6,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({
      status,
      environmentApi: makeEnvironmentApi({ vcs: { stageChanges, unstageChanges } }),
    });

    try {
      await expect.element(page.getByText("Staged Changes")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Stage changes to src/app.ts" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Stage changes to src/app.ts" }).click();
      await vi.waitFor(() => {
        expect(stageChanges).toHaveBeenCalledWith({ cwd: CWD, filePaths: ["src/app.ts"] });
      });

      await page.getByRole("button", { name: "Unstage changes to README.md" }).click();
      await vi.waitFor(() => {
        expect(unstageChanges).toHaveBeenCalledWith({ cwd: CWD, filePaths: ["README.md"] });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});

describe("SourceControlPanel commit graph", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    __resetEnvironmentApiOverridesForTests();
    await __resetLocalApiForTests();
  });

  it("shows commit details on hover without dense inline sha metadata", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText("Polish source control graph")).toBeVisible();
      expect(document.body.textContent).not.toContain("abc1234 -");
      expect(document.body.textContent).not.toContain("origin/HEAD");
      expect(document.querySelectorAll("svg path").length).toBeGreaterThan(0);

      await page.getByText("Polish source control graph").hover();

      await expect.element(page.getByText("Ada Lovelace")).toBeVisible();
      await expect.element(page.getByText("2 parents - merge commit")).toBeVisible();

      await page.getByRole("button", { name: "Copy commit id" }).click();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("abc1234abc1234abc1234abc1234abc1234abc1234");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders a split/merge topology with continuous lane heights", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText("Polish source control graph")).toBeVisible();

      const commitRows = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label^="Commit "]'),
      );
      expect(commitRows.length).toBe(GRAPH.commits.length);

      const heights = commitRows.map((row) => Math.round(row.getBoundingClientRect().height));
      const uniqueHeights = new Set(heights);
      expect(uniqueHeights.size).toBe(1);

      const crossLanePaths = document.querySelectorAll('svg path[d^="M "]');
      expect(crossLanePaths.length).toBeGreaterThanOrEqual(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens commit context actions from right click", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText("Polish source control graph")).toBeVisible();
      const row = document.querySelector(
        '[aria-label="Commit abc1234: Polish source control graph"]',
      );
      expect(row).toBeInstanceOf(HTMLElement);

      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 160,
          clientY: 180,
        }),
      );

      await expect.element(page.getByText("Copy commit id")).toBeVisible();
      await page.getByText("Copy commit id").click();

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("abc1234abc1234abc1234abc1234abc1234abc1234");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a tag from the commit graph context menu", async () => {
    const createTag: EnvironmentApi["vcs"]["createTag"] = vi.fn(async (input) => ({
      tagName: input.tagName,
      targetSha: input.targetSha,
    }));
    const mounted = await renderPanel({
      environmentApi: makeEnvironmentApi({ vcs: { createTag } }),
    });

    try {
      await expect.element(page.getByText("Polish source control graph")).toBeVisible();
      const row = document.querySelector(
        '[aria-label="Commit abc1234: Polish source control graph"]',
      );
      expect(row).toBeInstanceOf(HTMLElement);

      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 160,
          clientY: 180,
        }),
      );

      await page.getByText("Create tag...").click();

      await expect.element(page.getByRole("heading", { name: "Create tag" })).toBeVisible();
      await expect.element(page.getByText(/abc1234/)).toBeVisible();
      const popup = document.querySelector('[data-slot="dialog-popup"]');
      const input = document.querySelector<HTMLInputElement>('input[placeholder="v1.0.0"]');
      expect(popup).toBeInstanceOf(HTMLElement);
      expect(input).toBeInstanceOf(HTMLInputElement);
      const popupRect = popup!.getBoundingClientRect();
      const inputRect = input!.getBoundingClientRect();
      expect(inputRect.left - popupRect.left).toBeGreaterThanOrEqual(20);
      expect(popupRect.right - inputRect.right).toBeGreaterThanOrEqual(20);

      await page.getByPlaceholder("v1.0.0").fill("v2.0.0");
      await page.getByRole("button", { name: "Create tag" }).click();

      await vi.waitFor(() => {
        expect(createTag).toHaveBeenCalledWith({
          cwd: CWD,
          tagName: "v2.0.0",
          targetSha: "abc1234abc1234abc1234abc1234abc1234abc1234",
        });
      });
      await vi.waitFor(() => {
        expect(gitStatusMock.refreshGitStatus).toHaveBeenCalledWith({
          environmentId: ENVIRONMENT_ID,
          cwd: CWD,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a tag from the commit graph row action", async () => {
    const createTag: EnvironmentApi["vcs"]["createTag"] = vi.fn(async (input) => ({
      tagName: input.tagName,
      targetSha: input.targetSha,
    }));
    const mounted = await renderPanel({
      environmentApi: makeEnvironmentApi({ vcs: { createTag } }),
    });

    try {
      await page.getByRole("button", { name: "Create tag at abc1234" }).click();

      await expect.element(page.getByRole("heading", { name: "Create tag" })).toBeVisible();
      await expect.element(page.getByText(/abc1234/)).toBeVisible();

      await page.getByPlaceholder("v1.0.0").fill("v2.1.0");
      await page.getByRole("button", { name: "Create tag" }).click();

      await vi.waitFor(() => {
        expect(createTag).toHaveBeenCalledWith({
          cwd: CWD,
          tagName: "v2.1.0",
          targetSha: "abc1234abc1234abc1234abc1234abc1234abc1234",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("deletes a local branch from the commit graph context menu", async () => {
    const branchSha = "1234567123456712345671234567123456712345";
    const graph: VcsCommitGraphResult = {
      truncated: false,
      commits: [
        {
          sha: branchSha,
          shortSha: "1234567",
          parents: ["abc1234abc1234abc1234abc1234abc1234abc1234"],
          refs: ["feature/remove-me", "origin/feature/remove-me", "refs/tags/v1.0.0"],
          subject: "Remove temporary branch",
          authorName: "Ada Lovelace",
          committedAt: "2026-05-26T12:00:00.000Z",
        },
        ...GRAPH.commits,
      ],
    };
    const deleteBranch: EnvironmentApi["vcs"]["deleteBranch"] = vi.fn(async (input) => ({
      branchName: input.branchName,
    }));
    const mounted = await renderPanel({
      environmentApi: makeEnvironmentApi({
        vcs: {
          commitGraph: vi.fn(async () => graph),
          deleteBranch,
        },
      }),
    });

    try {
      await expect.element(page.getByText("Remove temporary branch")).toBeVisible();
      const row = document.querySelector('[aria-label="Commit 1234567: Remove temporary branch"]');
      expect(row).toBeInstanceOf(HTMLElement);

      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 160,
          clientY: 180,
        }),
      );

      await page.getByText("Delete branch 'feature/remove-me'...").click();
      await expect.element(page.getByRole("heading", { name: "Delete branch?" })).toBeVisible();
      await expect
        .element(page.getByRole("alertdialog").getByText("feature/remove-me"))
        .toBeVisible();

      await page.getByRole("button", { name: "Delete branch" }).click();

      await vi.waitFor(() => {
        expect(deleteBranch).toHaveBeenCalledWith({
          cwd: CWD,
          branchName: "feature/remove-me",
        });
      });
      await vi.waitFor(() => {
        expect(gitStatusMock.refreshGitStatus).toHaveBeenCalledWith({
          environmentId: ENVIRONMENT_ID,
          cwd: CWD,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
