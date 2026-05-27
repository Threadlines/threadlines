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

function makeStatus(): VcsStatusResult {
  return {
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
}

function makeEnvironmentApi(): EnvironmentApi {
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

async function renderPanel() {
  gitStatusMock.data = makeStatus();
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, makeEnvironmentApi());

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
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

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
});
