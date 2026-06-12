import "../../index.css";

import {
  EnvironmentId,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type EnvironmentApi,
  type LocalApi,
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
import { resetGitActionProgressStateForTests } from "../gitActionProgressState";
import { SourceControlPanel, type SourceControlProjectTarget } from "./SourceControlPanel";

const gitStatusMock = vi.hoisted(() => ({
  data: null as VcsStatusResult | null,
  refreshGitStatus: vi.fn(async () => null),
  refreshLocalGitStatus: vi.fn(async () => null),
}));

const gitActionMock = vi.hoisted(() => ({
  runStackedAction: vi.fn(),
  generateCommitMessage: vi.fn(async () => ({
    subject: "Update app change",
    body: "",
    message: "Update app change",
  })),
  toastAdd: vi.fn(() => "toast-1"),
  toastClose: vi.fn(),
  toastPromise: vi.fn(),
  toastUpdate: vi.fn(),
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

vi.mock("~/environments/runtime", () => {
  const connection = {
    ensureBootstrapped: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    client: {
      git: {
        runStackedAction: gitActionMock.runStackedAction,
        generateCommitMessage: gitActionMock.generateCommitMessage,
      },
    },
  };

  return {
    addSavedEnvironment: vi.fn(async () => undefined),
    connectDesktopSshEnvironment: vi.fn(async () => undefined),
    disconnectSavedEnvironment: vi.fn(async () => undefined),
    ensureEnvironmentConnectionBootstrapped: vi.fn(async () => undefined),
    getEnvironmentHttpBaseUrl: vi.fn(() => null),
    getPrimaryEnvironmentConnection: vi.fn(() => connection),
    getSavedEnvironmentRecord: vi.fn(() => null),
    getSavedEnvironmentRuntimeState: vi.fn(() => null),
    hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
    listSavedEnvironmentRecords: vi.fn(() => []),
    readEnvironmentConnection: vi.fn(() => null),
    reconnectSavedEnvironment: vi.fn(async () => undefined),
    removeSavedEnvironment: vi.fn(async () => undefined),
    requireEnvironmentConnection: vi.fn(() => connection),
    resetEnvironmentServiceForTests: vi.fn(),
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resolveEnvironmentHttpUrl: vi.fn(() => null),
    startEnvironmentConnectionService: vi.fn(() => undefined),
    subscribeEnvironmentConnections: vi.fn(() => () => undefined),
    useSavedEnvironmentRegistryStore: vi.fn((selector: (state: unknown) => unknown) =>
      selector({}),
    ),
    useSavedEnvironmentRuntimeStore: vi.fn((selector: (state: unknown) => unknown) => selector({})),
    waitForSavedEnvironmentRegistryHydration: vi.fn(async () => undefined),
  };
});

vi.mock("../ui/toast", () => ({
  stackedThreadToast: vi.fn((options: unknown) => options),
  toastManager: {
    add: gitActionMock.toastAdd,
    close: gitActionMock.toastClose,
    promise: gitActionMock.toastPromise,
    update: gitActionMock.toastUpdate,
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

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

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

function getCommitMessageTextarea() {
  const textarea = document.querySelector('textarea[placeholder="Commit message"]');
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  return textarea as HTMLTextAreaElement;
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
    readonly onOpenDiff?: (filePath?: string) => void;
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
      <SourceControlPanel
        target={TARGET}
        activeThreadRef={null}
        {...(input.onOpenDiff ? { onOpenDiff: input.onOpenDiff } : {})}
      />
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
    gitActionMock.runStackedAction.mockReset();
    gitActionMock.generateCommitMessage.mockReset();
    gitActionMock.generateCommitMessage.mockResolvedValue({
      subject: "Update app change",
      body: "",
      message: "Update app change",
    });
    gitActionMock.toastAdd.mockClear();
    gitActionMock.toastClose.mockClear();
    gitActionMock.toastPromise.mockClear();
    gitActionMock.toastUpdate.mockClear();
    Reflect.deleteProperty(window, "nativeApi");
    window.localStorage.clear();
    resetGitActionProgressStateForTests();
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    __resetEnvironmentApiOverridesForTests();
    Reflect.deleteProperty(window, "nativeApi");
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

  it("keeps commit message generation unavailable while discard is pending", async () => {
    const deferred = createDeferredPromise<{ readonly discardedPaths: readonly string[] }>();
    const discardChanges: EnvironmentApi["vcs"]["discardChanges"] = vi.fn(async (input) =>
      deferred.promise.then(() => ({ discardedPaths: input.filePaths })),
    );
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({
      status,
      environmentApi: makeEnvironmentApi({ vcs: { discardChanges } }),
    });

    try {
      await page.getByRole("button", { name: "Discard changes to src/app.ts" }).click();
      await page.getByRole("button", { name: "Discard" }).click();

      await vi.waitFor(() => expect(discardChanges).toHaveBeenCalled());
      await expect
        .element(page.getByRole("button", { name: "Source control actions" }))
        .toBeDisabled();
      expect(gitActionMock.generateCommitMessage).not.toHaveBeenCalled();

      deferred.resolve({ discardedPaths: ["src/app.ts"] });
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears the commit message draft when discarding changes", async () => {
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({
      status,
      environmentApi: makeEnvironmentApi({ vcs: { discardChanges } }),
    });

    try {
      await page.getByRole("button", { name: "Source control actions" }).click();
      await page.getByText("Generate message").click();

      await vi.waitFor(() => {
        expect(getCommitMessageTextarea().value).toBe("Update app change");
      });

      await page.getByRole("button", { name: "Discard changes to src/app.ts" }).click();
      await page.getByRole("button", { name: "Discard" }).click();

      await vi.waitFor(() => expect(discardChanges).toHaveBeenCalled());
      await vi.waitFor(() => {
        expect(document.querySelector('textarea[placeholder="Commit message"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the commit message editor after a generated draft is cleared and blurred", async () => {
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({ status });

    try {
      await page.getByRole("button", { name: "Source control actions" }).click();
      await page.getByText("Generate message").click();

      await vi.waitFor(() => {
        expect(getCommitMessageTextarea().value).toBe("Update app change");
      });

      await page.getByPlaceholder("Commit message").fill("");
      expect(getCommitMessageTextarea().value).toBe("");

      getCommitMessageTextarea().blur();

      await vi.waitFor(() => {
        expect(getCommitMessageTextarea().disabled).toBe(true);
      });
      await vi.waitFor(() => {
        expect(document.querySelector('textarea[placeholder="Commit message"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes the empty commit message editor when generation fails without a draft", async () => {
    gitActionMock.generateCommitMessage.mockRejectedValue(new Error("usage limit reached"));
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({ status });

    try {
      await page.getByRole("button", { name: "Source control actions" }).click();
      await page.getByText("Generate message").click();

      await vi.waitFor(() => {
        expect(gitActionMock.toastAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Commit message generation failed",
            description: "usage limit reached",
          }),
        );
      });
      await vi.waitFor(() => {
        expect(document.querySelector('textarea[placeholder="Commit message"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows inline progress while generating a commit message from the dropdown", async () => {
    const deferred = createDeferredPromise<{
      readonly subject: string;
      readonly body: string;
      readonly message: string;
    }>();
    gitActionMock.generateCommitMessage.mockImplementation(async () => deferred.promise);
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({ status });

    try {
      await page.getByRole("button", { name: "Source control actions" }).click();
      await page.getByText("Generate message").click();

      await expect.element(page.getByText("Generating commit message...")).toBeVisible();
      await expect.element(page.getByText("Reading the current Git diff")).toBeVisible();
      expect(getCommitMessageTextarea().disabled).toBe(true);

      deferred.resolve({
        subject: "Update app change",
        body: "",
        message: "Update app change",
      });

      await expect.element(page.getByText("Generating commit message...")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps stacked git action progress inline and reserves toasts for the final result", async () => {
    const actionResult: GitRunStackedActionResult = {
      action: "commit_push",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "abc1234def5678",
        subject: "feat: keep progress inline",
      },
      push: {
        status: "pushed",
        branch: "feature/source-control",
        upstreamBranch: "origin/feature/source-control",
      },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed abc1234 to origin/feature/source-control",
        description: "feat: keep progress inline",
        cta: { kind: "none" },
      },
    };
    const deferred = createDeferredPromise<GitRunStackedActionResult>();
    gitActionMock.runStackedAction.mockImplementation(
      (
        input: { readonly actionId: string; readonly action: "commit_push"; readonly cwd: string },
        options?: { readonly onProgress?: (event: GitActionProgressEvent) => void },
      ) => {
        options?.onProgress?.({
          actionId: input.actionId,
          action: input.action,
          cwd: input.cwd,
          kind: "phase_started",
          phase: "commit",
          label: "Committing...",
        });
        return deferred.promise;
      },
    );
    const status = makeStatus({
      refName: "feature/source-control",
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    const mounted = await renderPanel({ status });

    try {
      await page.getByRole("button", { name: "Generate, commit & push" }).click();

      await expect.element(page.getByText("Committing...")).toBeVisible();
      expect(gitActionMock.toastAdd).not.toHaveBeenCalled();
      expect(gitActionMock.toastUpdate).not.toHaveBeenCalled();

      deferred.resolve(actionResult);

      await vi.waitFor(() => {
        expect(gitActionMock.toastAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "success",
            title: "Pushed abc1234 to origin/feature/source-control",
            description: "feat: keep progress inline",
          }),
        );
      });
      await expect.element(page.getByText("Committing...")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores inline stacked git action progress when the panel remounts mid-action", async () => {
    const actionResult: GitRunStackedActionResult = {
      action: "commit_push",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "abc1234def5678",
        subject: "feat: survive remounts",
      },
      push: {
        status: "pushed",
        branch: "feature/source-control",
        upstreamBranch: "origin/feature/source-control",
      },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed abc1234 to origin/feature/source-control",
        description: "feat: survive remounts",
        cta: { kind: "none" },
      },
    };
    const deferred = createDeferredPromise<GitRunStackedActionResult>();
    gitActionMock.runStackedAction.mockImplementation(
      (
        input: { readonly actionId: string; readonly action: "commit_push"; readonly cwd: string },
        options?: { readonly onProgress?: (event: GitActionProgressEvent) => void },
      ) => {
        options?.onProgress?.({
          actionId: input.actionId,
          action: input.action,
          cwd: input.cwd,
          kind: "phase_started",
          phase: "commit",
          label: "Committing...",
        });
        return deferred.promise;
      },
    );
    gitStatusMock.data = makeStatus({
      refName: "feature/source-control",
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
        ],
        insertions: 2,
        deletions: 1,
      },
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, makeEnvironmentApi());

    // One query client across both mounts: the mutation keeps running in its
    // cache while the panel is unmounted, mirroring the diff viewer round trip.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const mountPanel = async () => {
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
        async unmount() {
          await screen.unmount();
          host.remove();
        },
      };
    };

    let mounted = await mountPanel();
    try {
      await page.getByRole("button", { name: "Generate, commit & push" }).click();
      await expect.element(page.getByText("Committing...")).toBeVisible();

      await mounted.unmount();
      expect(document.body.textContent ?? "").not.toContain("Committing...");

      mounted = await mountPanel();
      await expect.element(page.getByText("Committing...")).toBeVisible();

      deferred.resolve(actionResult);
      await expect.element(page.getByText("Committing...")).not.toBeInTheDocument();
      await vi.waitFor(() => {
        expect(gitActionMock.toastAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "success",
            title: "Pushed abc1234 to origin/feature/source-control",
          }),
        );
      });
    } finally {
      await mounted.unmount();
      queryClient.clear();
    }
  });

  it("opens changed files in the diff panel on left click", async () => {
    const openInEditor = vi.fn(async () => undefined);
    const onOpenDiff = vi.fn();
    window.nativeApi = {
      shell: { openInEditor, openExternal: vi.fn(async () => undefined) },
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["cursor"] })) },
      contextMenu: { show: vi.fn(async () => null) },
    } as unknown as LocalApi;
    const status = makeStatus({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "src/new.ts",
            indexStatus: null,
            worktreeStatus: "untracked",
            insertions: 246,
            deletions: 0,
          },
        ],
        insertions: 246,
        deletions: 0,
      },
    });
    const mounted = await renderPanel({ status, onOpenDiff });

    try {
      await page.getByRole("button", { name: "Open diff for src/new.ts" }).click();

      expect(onOpenDiff).toHaveBeenCalledWith("src/new.ts");
      expect(openInEditor).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens changed files in the preferred editor from the context menu", async () => {
    const openInEditor = vi.fn(async () => undefined);
    const showContextMenu = vi.fn(async () => "open-editor" as const);
    window.nativeApi = {
      shell: { openInEditor, openExternal: vi.fn(async () => undefined) },
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["cursor"] })) },
      contextMenu: { show: showContextMenu },
    } as unknown as LocalApi;
    const status = makeStatus({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: "src/new.ts",
            indexStatus: null,
            worktreeStatus: "untracked",
            insertions: 246,
            deletions: 0,
          },
        ],
        insertions: 246,
        deletions: 0,
      },
    });
    const mounted = await renderPanel({ status, onOpenDiff: vi.fn() });

    try {
      const fileButton = document.querySelector('button[aria-label="Open diff for src/new.ts"]');
      expect(fileButton).toBeInstanceOf(HTMLButtonElement);

      fileButton?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 44,
          clientY: 88,
        }),
      );

      await vi.waitFor(() => {
        expect(showContextMenu).toHaveBeenCalledWith(
          [
            { id: "open-diff", label: "Open diff", disabled: false },
            { id: "open-editor", label: "Open in editor" },
          ],
          { x: 44, y: 88 },
        );
      });
      await vi.waitFor(() => {
        expect(openInEditor).toHaveBeenCalledWith("/repo/project/src/new.ts", "cursor");
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

  it("shows delayed full names for changed file labels", async () => {
    const longFileName =
      "SourceControlPanelNameThatShouldNeedHoverToReadInTheChangesList.browser.tsx";
    const status = makeStatus({
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          {
            path: `apps/web/src/components/source-control/${longFileName}`,
            indexStatus: null,
            worktreeStatus: "modified",
            insertions: 8,
            deletions: 2,
          },
        ],
        insertions: 8,
        deletions: 2,
      },
    });
    const mounted = await renderPanel({ status });

    try {
      const fileLabel = page.getByText(longFileName);
      await expect.element(fileLabel).toBeVisible();

      await fileLabel.hover();
      await new Promise((resolve) => setTimeout(resolve, 600));

      await vi.waitFor(() => {
        const tooltipPopups = Array.from(document.querySelectorAll('[data-slot="tooltip-popup"]'));
        expect(tooltipPopups.some((popup) => popup.textContent?.includes(longFileName))).toBe(true);
      });
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
      const discardFileButton = document.querySelector(
        'button[aria-label="Discard changes to src/app.ts"]',
      );
      const stageFileButton = document.querySelector(
        'button[aria-label="Stage changes to src/app.ts"]',
      );
      const discardAllButton = document.querySelector('button[aria-label="Discard all changes"]');
      const stageAllButton = document.querySelector('button[aria-label="Stage all changes"]');
      if (
        !(discardFileButton instanceof HTMLButtonElement) ||
        !(stageFileButton instanceof HTMLButtonElement) ||
        !(discardAllButton instanceof HTMLButtonElement) ||
        !(stageAllButton instanceof HTMLButtonElement)
      ) {
        throw new Error("Expected source control action buttons to render.");
      }
      expect(discardFileButton.compareDocumentPosition(stageFileButton)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(discardAllButton.compareDocumentPosition(stageAllButton)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      for (const button of [discardFileButton, stageFileButton]) {
        const bounds = button.getBoundingClientRect();
        expect(bounds.width).toBeLessThanOrEqual(18);
        expect(bounds.height).toBeLessThanOrEqual(18);
      }

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
      const crossLanePathData = Array.from(crossLanePaths).map(
        (path) => path.getAttribute("d") ?? "",
      );
      expect(crossLanePathData).toEqual(
        expect.arrayContaining([
          "M 8 18.5 C 8 28, 20 18.5, 20 28",
          "M 20 28 C 20 37.5, 8 28, 8 37.5",
        ]),
      );
      expect(document.querySelector("svg circle.fill-amber-400")?.getAttribute("cy")).toBe("14");
    } finally {
      await mounted.cleanup();
    }
  });

  it("draws an interleaved side branch lane until the shared base commit", async () => {
    const graph: VcsCommitGraphResult = {
      truncated: false,
      commits: [
        {
          sha: "1111111111111111111111111111111111111111",
          shortSha: "1111111",
          parents: [
            "2222222222222222222222222222222222222222",
            "3333333333333333333333333333333333333333",
          ],
          refs: ["origin/main"],
          subject: "Merge feature branch",
          authorName: "Ada Lovelace",
          committedAt: "2026-05-27T12:00:00.000Z",
        },
        {
          sha: "3333333333333333333333333333333333333333",
          shortSha: "3333333",
          parents: ["4444444444444444444444444444444444444444"],
          refs: ["feature/visual-graph"],
          subject: "Polish graph side branch",
          authorName: "Grace Hopper",
          committedAt: "2026-05-27T11:00:00.000Z",
        },
        {
          sha: "2222222222222222222222222222222222222222",
          shortSha: "2222222",
          parents: ["4444444444444444444444444444444444444444"],
          refs: [],
          subject: "Advance main line",
          authorName: "Grace Hopper",
          committedAt: "2026-05-27T10:00:00.000Z",
        },
        {
          sha: "4444444444444444444444444444444444444444",
          shortSha: "4444444",
          parents: [],
          refs: ["main"],
          subject: "Shared base",
          authorName: "Grace Hopper",
          committedAt: "2026-05-27T09:00:00.000Z",
        },
      ],
    };
    const mounted = await renderPanel({
      status: makeStatus({ refName: "ui-polish" }),
      environmentApi: makeEnvironmentApi({
        vcs: {
          commitGraph: vi.fn(async () => graph),
        },
      }),
    });

    try {
      await expect.element(page.getByText("Merge feature branch")).toBeVisible();

      const crossLanePathData = Array.from(document.querySelectorAll('svg path[d^="M "]')).map(
        (path) => path.getAttribute("d") ?? "",
      );
      expect(crossLanePathData).toEqual(
        expect.arrayContaining([
          "M 8 18.5 C 8 28, 20 18.5, 20 28",
          "M 20 28 C 20 37.5, 8 28, 8 37.5",
        ]),
      );
      expect(
        document.querySelectorAll("svg circle.fill-background.stroke-primary-graph"),
      ).toHaveLength(1);
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

  it("keeps create tag out of the commit graph row actions", async () => {
    const mounted = await renderPanel();

    try {
      await expect.element(page.getByText("Polish source control graph")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Create tag at abc1234" }))
        .not.toBeInTheDocument();
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
