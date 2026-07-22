import { scopeThreadRef } from "@threadlines/client-runtime";
import { ThreadId } from "@threadlines/contracts";
import * as Option from "effect/Option";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const SHARED_THREAD_ID = ThreadId.make("thread-shared");
const ENVIRONMENT_A = "environment-local" as never;
const ENVIRONMENT_B = "environment-remote" as never;
const GIT_CWD = "/repo/project";
const BRANCH_NAME = "feature/toast-scope";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

const {
  activeRunStackedActionDeferredRef,
  activeDraftThreadRef,
  hasServerThreadRef,
  invalidateGitQueriesSpy,
  publishGitStatusRef,
  publishRepositoryMutateAsyncSpy,
  refreshGitStatusSpy,
  runStackedActionMutateAsyncSpy,
  setDraftThreadContextSpy,
  setThreadBranchSpy,
  sourceControlDiscoveryRef,
  toastAddSpy,
  toastCloseSpy,
  toastPromiseSpy,
  toastUpdateSpy,
} = vi.hoisted(() => ({
  activeRunStackedActionDeferredRef: { current: createDeferredPromise<never>() },
  activeDraftThreadRef: { current: null as unknown },
  hasServerThreadRef: { current: true },
  invalidateGitQueriesSpy: vi.fn(() => Promise.resolve()),
  publishGitStatusRef: { current: null as unknown },
  publishRepositoryMutateAsyncSpy: vi.fn(),
  refreshGitStatusSpy: vi.fn(() => Promise.resolve(null)),
  runStackedActionMutateAsyncSpy: vi.fn(() => activeRunStackedActionDeferredRef.current.promise),
  setDraftThreadContextSpy: vi.fn(),
  setThreadBranchSpy: vi.fn(),
  sourceControlDiscoveryRef: { current: { data: null } as unknown },
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastPromiseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useIsMutating: vi.fn(() => 0),
    useMutation: vi.fn((options: { __kind?: string }) => {
      if (options.__kind === "run-stacked-action") {
        return {
          mutateAsync: runStackedActionMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "pull") {
        return {
          mutateAsync: vi.fn(),
          isPending: false,
        };
      }

      if (options.__kind === "publish-repository") {
        return {
          mutateAsync: publishRepositoryMutateAsyncSpy,
          isPending: false,
        };
      }

      return {
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
      };
    }),
    useQuery: vi.fn((options: { __kind?: string }) => {
      if (options?.__kind === "auth-remediation-plan") {
        // The remediation dialog is closed in these tests; mirror the real
        // disabled-query state so its pending guard holds.
        return { data: null, error: null, isPending: true, isError: false, refetch: vi.fn() };
      }

      return { data: null, error: null };
    }),
    useQueryClient: vi.fn(() => ({})),
  };
});

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
    close: toastCloseSpy,
    promise: toastPromiseSpy,
    update: toastUpdateSpy,
  },
  stackedThreadToast: vi.fn((options: unknown) => options),
}));

vi.mock("~/editorPreferences", () => ({
  openInPreferredEditor: vi.fn(),
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitApplyAuthRemediationMutationOptions: vi.fn(() => ({ __kind: "apply-auth-remediation" })),
  gitAuthRemediationPlanQueryOptions: vi.fn(() => ({ __kind: "auth-remediation-plan" })),
  gitInitMutationOptions: vi.fn(() => ({ __kind: "init" })),
  gitMutationKeys: {
    publishRepository: vi.fn(() => ["publish-repository"]),
    pull: vi.fn(() => ["pull"]),
    runStackedAction: vi.fn(() => ["run-stacked-action"]),
  },
  gitPullMutationOptions: vi.fn(() => ({ __kind: "pull" })),
  gitRunStackedActionMutationOptions: vi.fn(() => ({ __kind: "run-stacked-action" })),
  invalidateGitQueries: invalidateGitQueriesSpy,
  sourceControlPublishRepositoryMutationOptions: vi.fn(() => ({ __kind: "publish-repository" })),
}));

vi.mock("~/lib/gitStatusState", () => ({
  refreshGitStatus: refreshGitStatusSpy,
  resetGitStatusStateForTests: () => undefined,
  useGitStatus: vi.fn(
    () =>
      publishGitStatusRef.current ?? {
        data: {
          isRepo: true,
          sourceControlProvider: {
            kind: "github",
            name: "GitHub",
            baseUrl: "https://github.com",
          },
          hasPrimaryRemote: true,
          isDefaultRef: false,
          refName: BRANCH_NAME,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: true,
          aheadCount: 1,
          behindCount: 0,
          pr: null,
        },
        error: null,
        isPending: false,
      },
  ),
}));

vi.mock("~/lib/sourceControlDiscoveryState", () => ({
  useSourceControlDiscovery: vi.fn(() => sourceControlDiscoveryRef.current),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: vi.fn(() => null),
}));

vi.mock("~/composerDraftStore", async () => {
  const draftStoreState = {
    getDraftThreadByRef: () => activeDraftThreadRef.current,
    getDraftSession: () => activeDraftThreadRef.current,
    getDraftThread: () => activeDraftThreadRef.current,
    getDraftSessionByLogicalProjectKey: () => null,
    setDraftThreadContext: setDraftThreadContextSpy,
    setLogicalProjectDraftThreadId: vi.fn(),
    setProjectDraftThreadId: vi.fn(),
    hasDraftThreadsInEnvironment: () => false,
    clearDraftThread: vi.fn(),
  };

  return {
    DraftId: {
      makeUnsafe: (value: string) => value,
    },
    useComposerDraftStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(draftStoreState),
      { getState: () => draftStoreState },
    ),
    markPromotedDraftThread: vi.fn(),
    markPromotedDraftThreadByRef: vi.fn(),
    markPromotedDraftThreads: vi.fn(),
    markPromotedDraftThreadsByRef: vi.fn(),
    finalizePromotedDraftThreadByRef: vi.fn(),
    finalizePromotedDraftThreadsByRef: vi.fn(),
  };
});

vi.mock("~/store", () => ({
  selectEnvironmentState: (
    state: { environmentStateById: Record<string, unknown> },
    environmentId: string | null,
  ) => {
    if (!environmentId) {
      throw new Error("Missing environment id");
    }
    const environmentState = state.environmentStateById[environmentId];
    if (!environmentState) {
      throw new Error(`Unknown environment: ${environmentId}`);
    }
    return environmentState;
  },
  selectProjectsForEnvironment: () => [],
  selectProjectsAcrossEnvironments: () => [],
  selectThreadsForEnvironment: () => [],
  selectThreadsAcrossEnvironments: () => [],
  selectThreadShellsAcrossEnvironments: () => [],
  selectSidebarThreadsAcrossEnvironments: () => [],
  selectSidebarThreadsForProjectRef: () => [],
  selectSidebarThreadsForProjectRefs: () => [],
  selectBootstrapCompleteForActiveEnvironment: () => true,
  selectProjectByRef: () => null,
  selectThreadByRef: () => null,
  selectSidebarThreadSummaryByRef: () => null,
  selectThreadIdsByProjectRef: () => [],
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      setThreadBranch: setThreadBranchSpy,
      environmentStateById: {
        [ENVIRONMENT_A]: {
          threadShellById: hasServerThreadRef.current
            ? {
                [SHARED_THREAD_ID]: {
                  id: SHARED_THREAD_ID,
                  branch: BRANCH_NAME,
                  worktreePath: null,
                },
              }
            : {},
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
        },
        [ENVIRONMENT_B]: {
          threadShellById: hasServerThreadRef.current
            ? {
                [SHARED_THREAD_ID]: {
                  id: SHARED_THREAD_ID,
                  branch: BRANCH_NAME,
                  worktreePath: null,
                },
              }
            : {},
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
        },
      },
    }),
}));

vi.mock("~/terminal-links", () => ({
  resolvePathLinkTarget: vi.fn(),
}));

import GitActionsControl, { PublishRepositoryDialog } from "./GitActionsControl";

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

function Harness() {
  const [activeThreadRef, setActiveThreadRef] = useState(
    scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setActiveThreadRef(scopeThreadRef(ENVIRONMENT_B, SHARED_THREAD_ID))}
      >
        Switch environment
      </button>
      <GitActionsControl gitCwd={GIT_CWD} activeThreadRef={activeThreadRef} />
    </>
  );
}

function PublishDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open publish
      </button>
      <PublishRepositoryDialog
        open={open}
        onOpenChange={setOpen}
        environmentId={ENVIRONMENT_A}
        gitCwd={GIT_CWD}
      />
    </>
  );
}

describe("GitActionsControl thread-scoped progress toast", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    activeRunStackedActionDeferredRef.current = createDeferredPromise<never>();
    activeDraftThreadRef.current = null;
    hasServerThreadRef.current = true;
    document.body.innerHTML = "";
  });

  it("keeps an in-flight git action toast pinned to the thread ref that started it", async () => {
    vi.useFakeTimers();

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      const quickActionButton = findButtonByText("Push & create PR");
      expect(quickActionButton, 'Unable to find button containing "Push & create PR"').toBeTruthy();
      if (!(quickActionButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Push & create PR"');
      }
      quickActionButton.click();

      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );

      const switchEnvironmentButton = findButtonByText("Switch environment");
      expect(
        switchEnvironmentButton,
        'Unable to find button containing "Switch environment"',
      ).toBeTruthy();
      if (!(switchEnvironmentButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Switch environment"');
      }
      switchEnvironmentButton.click();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadRef: scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID) },
          title: "Pushing...",
          type: "loading",
        }),
      );
    } finally {
      activeRunStackedActionDeferredRef.current.reject(new Error("test cleanup"));
      await Promise.resolve();
      vi.useRealTimers();
      await screen.unmount();
      host.remove();
    }
  });

  it("debounces focus-driven git status refreshes", async () => {
    vi.useFakeTimers();

    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitActionsControl
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
      {
        container: host,
      },
    );

    try {
      window.dispatchEvent(new Event("focus"));
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));

      expect(refreshGitStatusSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(refreshGitStatusSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshGitStatusSpy).toHaveBeenCalledTimes(1);
      expect(refreshGitStatusSpy).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_A,
        cwd: GIT_CWD,
      });
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      }
      vi.useRealTimers();
      await screen.unmount();
      host.remove();
    }
  });

  it("syncs the live branch into the active draft thread when no server thread exists", async () => {
    hasServerThreadRef.current = false;
    activeDraftThreadRef.current = {
      threadId: SHARED_THREAD_ID,
      environmentId: ENVIRONMENT_A,
      branch: null,
      worktreePath: null,
    };

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitActionsControl
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
      {
        container: host,
      },
    );

    try {
      await Promise.resolve();

      expect(setDraftThreadContextSpy).toHaveBeenCalledWith(
        scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID),
        {
          branch: BRANCH_NAME,
          worktreePath: null,
        },
      );
      expect(setThreadBranchSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not overwrite a selected base branch while a new worktree draft is being configured", async () => {
    hasServerThreadRef.current = false;
    activeDraftThreadRef.current = {
      threadId: SHARED_THREAD_ID,
      environmentId: ENVIRONMENT_A,
      branch: "feature/base-branch",
      worktreePath: null,
      envMode: "worktree",
    };

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitActionsControl
        gitCwd={GIT_CWD}
        activeThreadRef={scopeThreadRef(ENVIRONMENT_A, SHARED_THREAD_ID)}
      />,
      {
        container: host,
      },
    );

    try {
      await Promise.resolve();

      expect(setDraftThreadContextSpy).not.toHaveBeenCalled();
      expect(setThreadBranchSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

describe("PublishRepositoryDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    publishGitStatusRef.current = null;
    sourceControlDiscoveryRef.current = { data: null };
    document.body.innerHTML = "";
  });

  function prepareGitHubPublish() {
    sourceControlDiscoveryRef.current = {
      data: {
        versionControlSystems: [],
        sourceControlProviders: [
          {
            kind: "github",
            label: "GitHub",
            status: "available",
            version: Option.some("2.78.0"),
            installHint: "Install GitHub CLI.",
            detail: Option.none(),
            auth: {
              status: "authenticated",
              account: Option.some("badcuban"),
              host: Option.some("github.com"),
              detail: Option.none(),
              preferredProtocol: "https",
            },
          },
        ],
      },
    };
    publishGitStatusRef.current = {
      data: {
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "master",
        headSha: null,
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "one.png" }, { path: "two.png" }, { path: "contract.pdf" }],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      },
      error: null,
      isPending: false,
    };
  }

  it("reviews empty-repository effects and submits provider-aware options", async () => {
    prepareGitHubPublish();
    publishRepositoryMutateAsyncSpy.mockResolvedValue({
      repository: {
        provider: "github",
        nameWithOwner: "acme/dojostorm",
        url: "https://github.com/acme/dojostorm",
        sshUrl: "git@github.com:acme/dojostorm.git",
      },
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/dojostorm",
      branch: "main",
      status: "remote_added",
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<PublishDialogHarness />, { container: host });

    try {
      findButtonByText("Open publish")?.click();
      await vi.waitFor(() => expect(findButtonByText("Next")).toBeTruthy());
      findButtonByText("Next")?.click();

      await page.getByPlaceholder("owner/repo").fill("acme/dojostorm");
      await page
        .getByPlaceholder("A short description of this repository")
        .fill("Dojo Storm assets");

      await page.getByRole("radio", { name: /Internal/u }).click();
      await page.getByPlaceholder("team-slug").fill("design");

      findButtonByText("Next")?.click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("No commits will be uploaded yet.");
        expect(document.body.textContent).toContain("master · aligned to provider default");
        expect(document.body.textContent).toContain("3 changed files remain local");
      });

      findButtonByText("Publish")?.click();
      await vi.waitFor(() =>
        expect(publishRepositoryMutateAsyncSpy).toHaveBeenCalledWith({
          provider: "github",
          repository: "acme/dojostorm",
          visibility: "internal",
          description: "Dojo Storm assets",
          team: "design",
          remoteName: "origin",
          protocol: "https",
        }),
      );
      await vi.waitFor(() => expect(document.body.textContent).toContain("Repository created"));
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("restores private visibility whenever the dialog is reopened", async () => {
    prepareGitHubPublish();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<PublishDialogHarness />, { container: host });

    try {
      findButtonByText("Open publish")?.click();
      await vi.waitFor(() => expect(findButtonByText("Next")).toBeTruthy());
      findButtonByText("Next")?.click();
      await page.getByRole("radio", { name: /Public/u }).click();
      findButtonByText("Back")?.click();
      await vi.waitFor(() => expect(findButtonByText("Cancel")).toBeTruthy());
      findButtonByText("Cancel")?.click();
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

      findButtonByText("Open publish")?.click();
      await vi.waitFor(() => expect(findButtonByText("Next")).toBeTruthy());
      findButtonByText("Next")?.click();
      await expect
        .element(page.getByRole("radio", { name: /Private/u }))
        .toHaveAttribute("aria-checked", "true");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
