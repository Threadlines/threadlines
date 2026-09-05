import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@threadlines/contracts";

import {
  createThreadJumpHintVisibilityController,
  canMarkThreadDone,
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  orderItemsByPreferredIds,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  THREAD_STATUS_DOT_CLASSES,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  buildProjectScopeOptions,
  isThreadDone,
  mergeThreadDoneOverride,
  mergeThreadLastSeenAt,
  sortInboxThreads,
  windowInboxThreads,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_COMPOSER_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewThreadSeedContext", () => {
  it("prefers the default worktree mode over active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "feature/existing",
          worktreePath: "/repo/.threadlines/worktrees/existing",
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/draft",
          worktreePath: "/repo/.threadlines/worktrees/draft",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });

  it("inherits the active server thread context when creating a new thread in the same project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "effect-atom",
      worktreePath: null,
      envMode: "local",
    });
  });

  it("prefers the active draft thread context when it matches the target project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
    });
  });

  it("falls back to the default env mode when there is no matching active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-2",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        cwd: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        cwd: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        cwd: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.cwd)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
      pendingBackgroundTaskCount: 0,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({
      label: "Awaiting Input",
      dotClass: THREAD_STATUS_DOT_CLASSES.amber,
      pulse: false,
    });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({
      label: "Working",
      dotClass: THREAD_STATUS_DOT_CLASSES.blue,
      pulse: true,
    });
  });

  it("keeps working visible while a non-blocking question is open", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
          hasBlockingUserInput: false,
        },
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows working from the orchestration running status even if the legacy status lags", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "running",
          },
        },
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows starting from the orchestration starting status even if the legacy status lags", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "starting",
          },
        },
      }),
    ).toMatchObject({ label: "Starting", pulse: true });
  });

  it("does not infer working from a recent user message when the provider is ready", () => {
    const threadWithRecentMessage = {
      ...baseThread,
      latestUserMessageAt: "2026-03-09T10:00:10.000Z",
      session: {
        ...baseThread.session,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
        updatedAt: "2026-03-09T10:00:12.000Z",
      },
    };

    expect(
      resolveThreadStatusPill({
        thread: threadWithRecentMessage,
      }),
    ).toBeNull();
  });

  it("does not infer working when the latest user message is newer than the last projected turn", () => {
    const threadWithRecentMessage = {
      ...baseThread,
      latestTurn: makeLatestTurn(),
      latestUserMessageAt: "2026-03-09T10:06:00.000Z",
      session: {
        ...baseThread.session,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
        updatedAt: "2026-03-09T10:06:01.000Z",
      },
    };

    expect(
      resolveThreadStatusPill({
        thread: threadWithRecentMessage,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("does not keep working after the matching latest turn has completed", () => {
    const threadWithMatchingMessage = {
      ...baseThread,
      latestTurn: makeLatestTurn(),
      latestUserMessageAt: "2026-03-09T10:00:00.000Z",
      session: {
        ...baseThread.session,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
      },
    };

    expect(
      resolveThreadStatusPill({
        thread: threadWithMatchingMessage,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("does not infer working for stale historical user messages", () => {
    const threadWithHistoricalMessage = {
      ...baseThread,
      latestTurn: null,
      latestUserMessageAt: "2026-03-09T09:00:00.000Z",
      session: {
        ...baseThread.session,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
        updatedAt: "2026-03-09T09:00:01.000Z",
      },
    };

    expect(
      resolveThreadStatusPill({
        thread: threadWithHistoricalMessage,
      }),
    ).toBeNull();
  });

  it("does not infer working when a completed turn covered the latest user message", () => {
    const threadWithCoveredMessage = {
      ...baseThread,
      latestTurn: {
        ...makeLatestTurn(),
        requestedAt: "2026-03-09T09:59:59.000Z",
        completedAt: "2026-03-09T10:00:11.000Z",
      },
      latestUserMessageAt: "2026-03-09T10:00:10.000Z",
      session: {
        ...baseThread.session,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
      },
    };

    expect(
      resolveThreadStatusPill({
        thread: threadWithCoveredMessage,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows background when a settled turn still has provider tasks running", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
            pendingBackgroundTaskCount: 1,
          },
        },
      }),
    ).toMatchObject({
      label: "Background",
      dotClass: THREAD_STATUS_DOT_CLASSES.cyan,
      pulse: true,
    });
  });

  it("keeps active background-tracked turns in the working state", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn({ completedAt: null }),
          session: {
            ...baseThread.session,
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: "turn-1" as never,
            pendingBackgroundTaskCount: 1,
          },
        },
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({
      label: "Completed",
      dotClass: THREAD_STATUS_DOT_CLASSES.emerald,
      pulse: false,
    });
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    kind: "workspace",
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneOverride: null,
    lastSeenAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          updatedAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          updatedAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), name: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), name: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), name: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          name: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          name: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

describe("inbox done lifecycle", () => {
  const NOW = "2026-07-28T12:00:00.000Z";
  const base = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    session: null,
    latestUserMessageAt: null,
    latestTurn: null,
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: undefined,
    pinnedAt: null,
  };
  const doneMark = { state: "done", at: NOW } as const;

  it("refuses to hide work that is blocked on the user", () => {
    // Hiding a pending approval defeats the approval: the agent waits forever
    // on an answer the user can no longer see the question for.
    expect(isThreadDone({ ...base, hasPendingApprovals: true }, doneMark, { now: NOW })).toBe(
      false,
    );
    expect(isThreadDone({ ...base, hasPendingUserInput: true }, doneMark, { now: NOW })).toBe(
      false,
    );
  });

  it("refuses to hide a running thread, even explicitly marked", () => {
    const running = {
      ...base,
      session: { status: "running" } as never,
    };
    expect(isThreadDone(running, doneMark, { now: NOW })).toBe(false);
  });

  it("refuses to hide attention states until they are inspected", () => {
    const settledTurn = {
      turnId: "turn-settled" as TurnId,
      state: "completed",
      requestedAt: "2026-07-28T11:00:00.000Z",
      startedAt: "2026-07-28T11:00:00.000Z",
      completedAt: "2026-07-28T11:05:00.000Z",
      assistantMessageId: null,
    } as const;
    const settledSession = {
      status: "ready",
      orchestrationStatus: "ready",
      pendingBackgroundTaskCount: 0,
    } as const;

    expect(
      canMarkThreadDone(
        {
          ...base,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: settledTurn,
          session: settledSession as never,
          lastVisitedAt: "2026-07-28T11:06:00.000Z",
        },
        { now: NOW },
      ),
    ).toBe(false);
    expect(
      canMarkThreadDone(
        {
          ...base,
          latestTurn: settledTurn,
          session: { ...settledSession, pendingBackgroundTaskCount: 1 } as never,
          lastVisitedAt: "2026-07-28T11:06:00.000Z",
        },
        { now: NOW },
      ),
    ).toBe(false);
    expect(
      canMarkThreadDone(
        {
          ...base,
          latestTurn: settledTurn,
          session: settledSession as never,
          lastVisitedAt: "2026-07-28T11:04:00.000Z",
        },
        { now: NOW },
      ),
    ).toBe(false);
    expect(
      canMarkThreadDone(
        {
          ...base,
          latestTurn: settledTurn,
          session: settledSession as never,
          lastVisitedAt: "2026-07-28T11:06:00.000Z",
        },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("treats a just-sent message as pending work until a turn adopts it", () => {
    // Between send and adoption there is no turn and no running session --
    // the gap where marking Done would hide a message about to run.
    const queued = {
      ...base,
      latestUserMessageAt: "2026-07-28T11:59:30.000Z",
    };
    expect(isThreadDone(queued, doneMark, { now: NOW })).toBe(false);
    // Past the grace window the same shape is a failed start, not pending
    // work; holding it undoneable forever would strand the thread.
    expect(
      isThreadDone({ ...base, latestUserMessageAt: "2026-07-28T11:00:00.000Z" }, doneMark, {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("lets a failed thread be marked done only after the failure was inspected", () => {
    // "I saw it, I'm done with it" must remain expressible for failures, but
    // the first hover after a failure must not be able to dismiss it unseen.
    const failed = {
      ...base,
      session: {
        status: "error",
        orchestrationStatus: "error",
        updatedAt: "2026-07-28T11:55:00.000Z",
      } as never,
    };
    expect(isThreadDone(failed, doneMark, { now: NOW })).toBe(false);
    expect(
      isThreadDone({ ...failed, lastVisitedAt: "2026-07-28T11:56:00.000Z" }, doneMark, {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("keeps a thread live without an explicit done mark", () => {
    expect(isThreadDone(base, null, { now: NOW })).toBe(false);
    expect(isThreadDone(base, { state: "active", at: NOW }, { now: NOW })).toBe(false);
  });

  it("ignores an override older than the thread's last activity", () => {
    // New work outranks an old word, in both directions: the done thread that
    // starts again returns by itself, the reopened one may re-file itself.
    const activeAgain = {
      ...base,
      latestUserMessageAt: "2026-07-28T11:00:00.000Z",
    };
    expect(
      isThreadDone(activeAgain, { state: "done", at: "2026-07-28T10:00:00.000Z" }, { now: NOW }),
    ).toBe(false);
  });

  it("files an idle thread under Done on its own", () => {
    const staleThread = {
      ...base,
      latestUserMessageAt: "2026-07-24T12:00:00.000Z",
    };
    expect(isThreadDone(staleThread, null, { now: NOW, autoDoneAfterDays: 2 })).toBe(true);
    // Fresh activity holds it live under the same rule.
    expect(
      isThreadDone({ ...base, latestUserMessageAt: "2026-07-28T09:00:00.000Z" }, null, {
        now: NOW,
        autoDoneAfterDays: 2,
      }),
    ).toBe(false);
  });

  it("never auto-files a pinned thread, however stale", () => {
    // A pin is "keep this at hand"; the idle timer must not overrule it. The
    // user's explicit word still does -- pinning guards the automatic filing
    // only.
    const pinnedStale = {
      ...base,
      pinnedAt: "2026-07-20T12:00:00.000Z",
      latestUserMessageAt: "2026-07-24T12:00:00.000Z",
    };
    expect(isThreadDone(pinnedStale, null, { now: NOW, autoDoneAfterDays: 2 })).toBe(false);
    expect(
      isThreadDone(pinnedStale, { state: "done", at: NOW }, { now: NOW, autoDoneAfterDays: 2 }),
    ).toBe(true);
  });

  it("files a thread at once when its pull request lands, pin and timer aside", () => {
    // A merged branch is finished work: it does not wait out the idle timer,
    // and a pin does not hold it in the live list.
    const pinnedAndFresh = {
      ...base,
      pinnedAt: "2026-07-27T12:00:00.000Z",
      latestUserMessageAt: "2026-07-28T11:00:00.000Z",
    };
    expect(
      isThreadDone(pinnedAndFresh, null, {
        now: NOW,
        autoDoneAfterDays: 2,
        pullRequestSettledAt: "2026-07-28T11:30:00.000Z",
      }),
    ).toBe(true);
    // A thread that is still moving was never eligible in the first place.
    expect(
      isThreadDone({ ...pinnedAndFresh, session: { status: "running" } as never }, null, {
        now: NOW,
        autoDoneAfterDays: 2,
        pullRequestSettledAt: "2026-07-28T11:30:00.000Z",
      }),
    ).toBe(false);
  });

  it("files a landing once: a later message or a later keep-active brings the thread back", () => {
    // The merge is the thread's last word only while nothing has happened
    // since. A message sent after it is new work; so is an explicit "keep
    // active" given after it, even once later agent activity has aged that
    // override out of the override rule.
    const landedAt = "2026-07-28T11:30:00.000Z";
    const options = { now: NOW, autoDoneAfterDays: 2, pullRequestSettledAt: landedAt };
    const spokeAfter = { ...base, latestUserMessageAt: "2026-07-28T11:45:00.000Z" };
    expect(isThreadDone(spokeAfter, null, options)).toBe(false);

    const quietSince = {
      ...base,
      latestUserMessageAt: "2026-07-28T11:00:00.000Z",
      latestTurn: {
        requestedAt: "2026-07-28T11:00:00.000Z",
        completedAt: "2026-07-28T11:50:00.000Z",
      } as never,
      lastVisitedAt: "2026-07-28T11:55:00.000Z",
    };
    expect(isThreadDone(quietSince, null, options)).toBe(true);
    expect(
      isThreadDone(quietSince, { state: "active", at: "2026-07-28T11:40:00.000Z" }, options),
    ).toBe(false);
    // A keep-active from before the landing is not a word on the landing.
    expect(
      isThreadDone(quietSince, { state: "active", at: "2026-07-28T11:20:00.000Z" }, options),
    ).toBe(true);
  });

  it("never files a completion the user has not seen", () => {
    // Filing unread work is the sidebar reading your mail for you. The row
    // should offer Wrap up only after the completed thread has been inspected.
    const unseen = {
      ...base,
      latestTurn: { completedAt: "2026-07-24T12:00:00.000Z" } as never,
      lastVisitedAt: undefined,
    };
    expect(isThreadDone(unseen, null, { now: NOW, autoDoneAfterDays: 2 })).toBe(false);
    expect(
      isThreadDone(unseen, { state: "done", at: NOW }, { now: NOW, autoDoneAfterDays: 2 }),
    ).toBe(false);
  });
});

describe("merging device-local and server-held inbox state", () => {
  const serverMark = { state: "done", at: "2026-07-28T10:00:00.000Z" } as const;

  it("lets the freshest word win, whichever device gave it", () => {
    const newerLocal = { state: "active", at: "2026-07-28T11:00:00.000Z" } as const;
    const olderLocal = { state: "active", at: "2026-07-28T09:00:00.000Z" } as const;

    expect(mergeThreadDoneOverride(newerLocal, serverMark)).toBe(newerLocal);
    expect(mergeThreadDoneOverride(olderLocal, serverMark)).toBe(serverMark);
  });

  it("falls back to whichever side has a word at all", () => {
    expect(mergeThreadDoneOverride(undefined, serverMark)).toBe(serverMark);
    expect(mergeThreadDoneOverride(serverMark, null)).toBe(serverMark);
    expect(mergeThreadDoneOverride(null, null)).toBeNull();
  });

  it("prefers the server on a tie, because a landed write is the same word twice", () => {
    const sameStamp = { state: "done", at: serverMark.at } as const;
    expect(mergeThreadDoneOverride(sameStamp, serverMark)).toBe(serverMark);
  });

  it("reads seen state as pending write, then server, then this device's seed", () => {
    expect(
      mergeThreadLastSeenAt({
        overlayAt: "2026-07-28T12:00:00.000Z",
        serverLastSeenAt: "2026-07-28T10:00:00.000Z",
        seedAt: "2026-07-27T12:00:00.000Z",
      }),
    ).toBe("2026-07-28T12:00:00.000Z");
    expect(
      mergeThreadLastSeenAt({
        serverLastSeenAt: "2026-07-28T10:00:00.000Z",
        seedAt: "2026-07-27T12:00:00.000Z",
      }),
    ).toBe("2026-07-28T10:00:00.000Z");
    // A thread the server has never recorded a visit for is treated as seen
    // as of the moment this device first saw it, so a backlog does not arrive
    // all-unread.
    expect(
      mergeThreadLastSeenAt({ serverLastSeenAt: null, seedAt: "2026-07-27T12:00:00.000Z" }),
    ).toBe("2026-07-27T12:00:00.000Z");
    expect(mergeThreadLastSeenAt({ serverLastSeenAt: null })).toBeUndefined();
  });
});

describe("sortInboxThreads", () => {
  it("keeps pins first and otherwise follows the thread sort preference", () => {
    const rows = [
      {
        id: ThreadId.make("old-recently-used"),
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
        latestUserMessageAt: "2026-07-29T00:00:00.000Z",
        pinnedAt: null,
      },
      {
        id: ThreadId.make("pinned"),
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
        latestUserMessageAt: "2026-07-18T00:00:00.000Z",
        pinnedAt: "2026-07-27T00:00:00.000Z",
      },
      {
        id: ThreadId.make("newer-less-recent"),
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
        latestUserMessageAt: "2026-07-28T00:00:00.000Z",
        pinnedAt: null,
      },
    ];

    expect(sortInboxThreads(rows).map((row) => row.id)).toEqual([
      "pinned",
      "old-recently-used",
      "newer-less-recent",
    ]);
  });
});

describe("buildProjectScopeOptions", () => {
  it("orders by recent activity and carries needs-you counts", () => {
    const options = buildProjectScopeOptions({
      projects: [
        { key: "a", label: "alpha" },
        { key: "b", label: "beta" },
        { key: "c", label: "gamma" },
        { key: "d", label: "delta" },
      ],
      lastActivityMsByKey: new Map([
        ["a", 400],
        ["b", 300],
        ["c", 200],
      ]),
      needsYouCountByKey: new Map([["b", 2]]),
    });

    // "d" has never been touched, so it sorts last rather than dropping out.
    expect(options.map((option) => option.key)).toEqual(["a", "b", "c", "d"]);
    expect(options[1]?.needsYouCount).toBe(2);
    expect(options[0]?.needsYouCount).toBe(0);
  });
});

describe("windowInboxThreads", () => {
  const rows = [
    { id: "a", attention: false },
    { id: "b", attention: false },
    { id: "c", attention: false },
    { id: "d", attention: true },
    { id: "e", attention: false },
  ];
  const hasAttention = (row: { attention: boolean }) => row.attention;

  it("folds quiet rows past the limit but never one that needs you", () => {
    // Hiding a pending approval behind "show more" defeats the approval.
    const { visible, hiddenCount } = windowInboxThreads({
      rows,
      hasAttention,
      limit: 2,
      expanded: false,
    });

    expect(visible.map((row) => row.id)).toEqual(["a", "b", "d"]);
    expect(hiddenCount).toBe(2);
  });

  it("shows everything when expanded or when the list fits", () => {
    expect(windowInboxThreads({ rows, hasAttention, limit: 2, expanded: true }).hiddenCount).toBe(
      0,
    );
    expect(
      windowInboxThreads({ rows: rows.slice(0, 2), hasAttention, limit: 2, expanded: false })
        .visible.length,
    ).toBe(2);
  });
});
