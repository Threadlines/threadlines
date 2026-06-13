import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  EventId,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EnvironmentState, useStore } from "../store";
import { type Thread } from "../types";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  classifyModelSwitch,
  createLocalDispatchSnapshot,
  deriveLockedProvider,
  deriveComposerSendState,
  deriveProviderAuthReconnectPrompt,
  desktopCapturedScreenshotToFile,
  hasServerAcknowledgedLocalDispatch,
  mergeLocalDraftThreadWithServerThread,
  threadHasPromotableServerActivity,
  reconcileSteeringHandoffStatuses,
  reconcileMountedTerminalThreadIds,
  resolveSendEnvMode,
  shouldConfirmTerminalKill,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("classifyModelSwitch", () => {
  const CODEX = ProviderDriverKind.make("codex");
  const CLAUDE = ProviderDriverKind.make("claudeAgent");

  it("applies a plain in-driver model swap", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CODEX,
        boundContinuationGroupKey: "codex:home:/a",
        pickedContinuationGroupKey: "codex:home:/a",
      }),
    ).toBe("apply");
  });

  it("applies when the thread has no binding yet", () => {
    expect(
      classifyModelSwitch({
        boundProvider: null,
        pickedDriverKind: CLAUDE,
        boundContinuationGroupKey: null,
        pickedContinuationGroupKey: null,
      }),
    ).toBe("apply");
  });

  it("confirms a cross-driver switch", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CLAUDE,
        boundContinuationGroupKey: "codex:home:/a",
        pickedContinuationGroupKey: "claudeAgent:instance:claudeAgent",
      }),
    ).toBe("confirm-cross-driver");
  });

  it("blocks a same-driver switch across an incompatible continuation group", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CODEX,
        boundContinuationGroupKey: "codex:home:/a",
        pickedContinuationGroupKey: "codex:home:/b",
      }),
    ).toBe("blocked-incompatible-instance");
  });

  it("applies a same-driver switch when a continuation group is unknown", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CODEX,
        boundContinuationGroupKey: null,
        pickedContinuationGroupKey: "codex:home:/b",
      }),
    ).toBe("apply");
  });
});

describe("deriveLockedProvider", () => {
  const CODEX = ProviderDriverKind.make("codex");

  it("locks to the resolved driver for custom provider instances", () => {
    const startedThread = {
      latestTurn: null,
      messages: [{ id: "message-1" }],
      session: null,
    } as unknown as Thread;

    expect(
      deriveLockedProvider({
        thread: startedThread,
        selectedProvider: CODEX,
        threadProvider: null,
      }),
    ).toBe(CODEX);
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("desktopCapturedScreenshotToFile", () => {
  it("converts a desktop-captured PNG data URL into a File", async () => {
    const file = desktopCapturedScreenshotToFile({
      name: "screenshot-20260609.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
      width: 1,
      height: 1,
      capturedAt: "2026-06-09T12:00:00.000Z",
      source: "macos-screencapture",
    });

    expect(file).not.toBeNull();
    if (!file) return;
    expect(file?.name).toBe("screenshot-20260609.png");
    expect(file?.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("returns null for non-base64 image data", () => {
    expect(
      desktopCapturedScreenshotToFile({
        name: "bad.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png,not-base64",
        width: 1,
        height: 1,
        capturedAt: "2026-06-09T12:00:00.000Z",
        source: "windows-snipping-tool-clipboard",
      }),
    ).toBeNull();
  });
});

describe("deriveProviderAuthReconnectPrompt", () => {
  const claudeProvider = ProviderDriverKind.make("claudeAgent");

  it("detects Claude authentication failures from the thread error", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        threadError: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      }),
    ).toEqual({
      provider: claudeProvider,
      command: "claude auth login",
      message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    });
  });

  it("detects structured authentication runtime activities", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("evt-auth"),
      tone: "error",
      kind: "runtime.error",
      summary: "Authentication required",
      payload: {
        message: "Failed to authenticate.",
        class: "authentication_error",
        provider: claudeProvider,
      },
      turnId: null,
      createdAt: "2026-03-29T00:00:00.000Z",
    };

    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        activities: [activity],
      }),
    ).toEqual({
      provider: claudeProvider,
      command: "claude auth login",
      message: "Failed to authenticate.",
    });
  });

  it("ignores unrelated runtime errors", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        threadError: "Sandbox setup failed",
      }),
    ).toBeNull();
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
  });

  it("forces local mode for non-git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
    expect(resolveSendEnvMode({ requestedEnvMode: "local", isGitRepo: false })).toBe("local");
  });
});

describe("shouldConfirmTerminalKill", () => {
  it("confirms when the terminal still has a running subprocess", () => {
    expect(
      shouldConfirmTerminalKill({
        runningTerminalIds: ["default", "terminal-2"],
        terminalId: "terminal-2",
        sessionExited: false,
      }),
    ).toBe(true);
  });

  it("does not confirm when no subprocess is running in the terminal", () => {
    expect(
      shouldConfirmTerminalKill({
        runningTerminalIds: ["terminal-2"],
        terminalId: "default",
        sessionExited: false,
      }),
    ).toBe(false);
  });

  it("does not confirm when the close follows a session exit", () => {
    expect(
      shouldConfirmTerminalKill({
        runningTerminalIds: ["default"],
        terminalId: "default",
        sessionExited: true,
      }),
    ).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden"), ThreadId.make("thread-stale")],
        openThreadIds: [ThreadId.make("thread-hidden"), ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.make("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.make("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.make("thread-1"),
          ThreadId.make("thread-2"),
          ThreadId.make("thread-3"),
        ],
        openThreadIds: [
          ThreadId.make("thread-1"),
          ThreadId.make("thread-2"),
          ThreadId.make("thread-3"),
          ThreadId.make("thread-4"),
        ],
        activeThreadId: ThreadId.make("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([ThreadId.make("thread-2"), ThreadId.make("thread-3"), ThreadId.make("thread-4")]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.make("thread-a"),
          ThreadId.make("thread-b"),
          ThreadId.make("thread-c"),
        ],
        openThreadIds: [
          ThreadId.make("thread-a"),
          ThreadId.make("thread-b"),
          ThreadId.make("thread-c"),
        ],
        activeThreadId: ThreadId.make("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([ThreadId.make("thread-b"), ThreadId.make("thread-c"), ThreadId.make("thread-a")]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("routes errors to the active server thread when route and target match", () => {
    const threadId = ThreadId.make("thread-1");
    const routeThreadRef = scopeThreadRef(localEnvironmentId, threadId);

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: {
          environmentId: localEnvironmentId,
          id: threadId,
        },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("does not route draft-thread errors into server-backed state", () => {
    const threadId = ThreadId.make("thread-1");

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: undefined,
        routeThreadRef: scopeThreadRef(localEnvironmentId, threadId),
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  session?: Thread["session"];
  messages?: Thread["messages"];
  activities?: Thread["activities"];
  proposedPlans?: Thread["proposedPlans"];
  turnDiffSummaries?: Thread["turnDiffSummaries"];
  error?: string | null;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}): Thread => ({
  id: input?.id ?? ThreadId.make("thread-1"),
  environmentId: localEnvironmentId,
  codexThreadId: null,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: input?.session ?? null,
  messages: input?.messages ?? [],
  proposedPlans: input?.proposedPlans ?? [],
  error: input?.error ?? null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: input?.turnDiffSummaries ?? [],
  activities: input?.activities ?? [],
});

describe("mergeLocalDraftThreadWithServerThread", () => {
  it("hydrates a promoted draft from the matching server thread without changing route ownership", () => {
    const threadId = ThreadId.make("thread-promoted");
    const localDraftThread = makeThread({
      id: threadId,
      messages: [],
    });
    const serverThread = makeThread({
      id: threadId,
      session: {
        provider: ProviderDriverKind.make("codex"),
        status: "connecting",
        orchestrationStatus: "starting",
        createdAt: "2026-03-29T00:00:01.000Z",
        updatedAt: "2026-03-29T00:00:01.000Z",
      },
      messages: [
        {
          id: "message-promoted" as never,
          role: "user",
          text: "keep this visible",
          createdAt: "2026-03-29T00:00:01.000Z",
          completedAt: "2026-03-29T00:00:01.000Z",
          streaming: false,
        },
      ],
    });

    const merged = mergeLocalDraftThreadWithServerThread(localDraftThread, serverThread);

    expect(merged).toMatchObject({
      id: threadId,
      session: {
        status: "connecting",
        orchestrationStatus: "starting",
      },
      messages: [
        {
          id: "message-promoted",
          text: "keep this visible",
        },
      ],
    });
  });

  it("ignores server state for a different thread", () => {
    const localDraftThread = makeThread({ id: ThreadId.make("thread-local") });
    const serverThread = makeThread({ id: ThreadId.make("thread-server") });

    expect(mergeLocalDraftThreadWithServerThread(localDraftThread, serverThread)).toBe(
      localDraftThread,
    );
  });
});

function setStoreThreads(threads: ReadonlyArray<ReturnType<typeof makeThread>>) {
  const projectId = ProjectId.make("project-1");
  const environmentState: EnvironmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: {
        id: projectId,
        environmentId: localEnvironmentId,
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:00:00.000Z",
        scripts: [],
      },
    },
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId: {
      [projectId]: threads.map((thread) => thread.id),
    },
    threadShellById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          id: thread.id,
          environmentId: thread.environmentId,
          codexThreadId: thread.codexThreadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          error: thread.error,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          pinnedAt: thread.pinnedAt,
          updatedAt: thread.updatedAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      ]),
    ),
    threadSessionById: Object.fromEntries(threads.map((thread) => [thread.id, thread.session])),
    threadTurnStateById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          latestTurn: thread.latestTurn,
          ...(thread.pendingSourceProposedPlan
            ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
            : {}),
        },
      ]),
    ),
    messageIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.messages.map((message) => message.id)]),
    ),
    messageByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.messages.map((message) => [message.id, message])),
      ]),
    ),
    activityIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.activities.map((activity) => activity.id)]),
    ),
    activityByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.activities.map((activity) => [activity.id, activity])),
      ]),
    ),
    proposedPlanIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.proposedPlans.map((plan) => plan.id)]),
    ),
    proposedPlanByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.proposedPlans.map((plan) => [plan.id, plan])),
      ]),
    ),
    turnDiffIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        thread.turnDiffSummaries.map((summary) => summary.turnId),
      ]),
    ),
    turnDiffSummaryByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.turnDiffSummaries.map((summary) => [summary.turnId, summary])),
      ]),
    ),
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  useStore.setState({
    activeEnvironmentId: localEnvironmentId,
    environmentStateById: {
      [localEnvironmentId]: environmentState,
    },
  });
}

describe("threadHasPromotableServerActivity", () => {
  const readySession = {
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:05.000Z",
    orchestrationStatus: "ready" as const,
  };

  it("does not treat server metadata or the echoed user message as turn activity", () => {
    expect(
      threadHasPromotableServerActivity(
        makeThread({
          session: readySession,
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "start this",
              createdAt: "2026-03-29T00:00:04.000Z",
              completedAt: "2026-03-29T00:00:04.000Z",
              streaming: false,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not promote on a running session before turn details arrive", () => {
    expect(
      threadHasPromotableServerActivity(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            orchestrationStatus: "running",
          },
        }),
      ),
    ).toBe(false);
  });

  it("promotes once provider turn activity or failure state is visible", () => {
    expect(
      threadHasPromotableServerActivity(
        makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-activity"),
            state: "running",
            requestedAt: "2026-03-29T00:00:04.000Z",
            startedAt: "2026-03-29T00:00:05.000Z",
            completedAt: null,
          },
        }),
      ),
    ).toBe(true);

    expect(threadHasPromotableServerActivity(makeThread({ error: "Failed to start" }))).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoreThreads([]);
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.make("thread-started");
    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId)),
    ).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.make("thread-wait");
    setStoreThreads([makeThread({ id: threadId })]);

    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.make("thread-race");
    setStoreThreads([makeThread({ id: threadId })]);

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        setStoreThreads([
          makeThread({
            id: threadId,
            latestTurn: {
              turnId: TurnId.make("turn-race"),
              state: "running",
              requestedAt: "2026-03-29T00:00:01.000Z",
              startedAt: "2026-03-29T00:00:01.000Z",
              completedAt: null,
            },
          }),
        ]);
      }
      return originalSubscribe(listener);
    });

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500),
    ).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.make("thread-timeout");
    setStoreThreads([makeThread({ id: threadId })]);
    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.make("project-1");
  const previousLatestTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("does not clear local dispatch while the session is running a newer turn than latestTurn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("does not clear local dispatch while the session is running but latestTurn has not advanced yet", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: undefined,
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch once the running latestTurn matches the active session turn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: null,
        },
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("reconcileSteeringHandoffStatuses", () => {
  const queuedMessage = {
    id: "message-steer",
    threadKey: "environment-local:thread-1",
    createdAt: "2026-03-29T00:01:00.000Z",
    status: "queued" as const,
    text: "adjust the current answer",
  };

  it("marks a queued steering handoff read as soon as the server message is visible", () => {
    const messagesById = {
      [queuedMessage.id]: queuedMessage,
    };

    const next = reconcileSteeringHandoffStatuses({
      messagesById,
      activeThreadKey: queuedMessage.threadKey,
      latestTurn: {
        requestedAt: "2026-03-29T00:00:00.000Z",
      },
      serverMessageIds: new Set([queuedMessage.id]),
    });

    expect(next[queuedMessage.id]?.status).toBe("read");
  });

  it("keeps a queued steering handoff while neither the turn nor server message has acknowledged it", () => {
    const messagesById = {
      [queuedMessage.id]: queuedMessage,
    };

    const next = reconcileSteeringHandoffStatuses({
      messagesById,
      activeThreadKey: queuedMessage.threadKey,
      latestTurn: {
        requestedAt: "2026-03-29T00:00:00.000Z",
      },
      serverMessageIds: new Set(),
    });

    expect(next).toBe(messagesById);
    expect(next[queuedMessage.id]?.status).toBe("queued");
  });
});
