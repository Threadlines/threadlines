import {
  ORCHESTRATION_WS_METHODS,
  GENERAL_CHATS_PROJECT_ID,
  type EnvironmentApi,
  type DesktopPreviewUserControl,
  type DesktopPreviewTarget,
  MessageId,
  OrchestrationDispatchCommandError,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  ProviderInstanceId,
  type SideTurnId,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
  WS_METHODS,
} from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import * as Effect from "effect/Effect";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { CLIENT_SETTINGS_STORAGE_KEY } from "../clientPersistenceStorage";
import {
  makeBrowserTab,
  registerPreviewWebview,
  resetPreviewWebviewsForTests,
  useBrowserPanelStore,
} from "../browserPanelStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";

import { DEFAULT_CLIENT_SETTINGS } from "@threadlines/contracts/settings";
import {
  THREAD_ID,
  THREAD_TITLE,
  LOCAL_ENVIRONMENT_ID,
  BrowserHostHarness,
  THREAD_REF,
  THREAD_KEY,
  markThreadDoneInTest,
  UUID_ROUTE_RE,
  PROJECT_LOGICAL_KEY,
  NOW_ISO,
  wsRequests,
  DEFAULT_VIEWPORT,
  isoAt,
  createMockEnvironmentApi,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  materializePromotedDraftThreadViaDomainEvent,
  setPromotedServerThreadRunningViaDomainEvent,
  addPromotedServerUserMessageViaDomainEvent,
  startPromotedServerTurnViaDomainEvent,
  createDraftOnlySnapshot,
  setDraftThreadWithoutWorktree,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  waitForServerConfigToApply,
  mountChatView,
  clickProjectMenuItem,
  registerChatViewSuiteHooks,
} from "./ChatView.browser-harness";

vi.mock("../lib/gitStatusState", () => ({
  // Read synchronously by the draft seeder to skip a checkout already known
  // to be missing; these suites never exercise a deleted checkout.
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

describe("ChatView (full app): sidebar", () => {
  registerChatViewSuiteHooks();

  it("shows an explicit empty state for projects without threads in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect.element(page.getByText("No threads yet")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  function withThreadBranch(
    snapshot: ReturnType<typeof createSnapshotForTargetUser>,
    branch: string,
  ): ReturnType<typeof createSnapshotForTargetUser> {
    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID ? { ...thread, branch } : thread,
      ),
    };
  }

  it("narrows the live list from the scope menu and drops the implied project label", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withThreadBranch(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-scope-target" as MessageId,
          targetText: "scope target",
        }),
        "feature/scope-test",
      ),
    });

    try {
      const threadRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find thread row.",
      );
      // Unscoped: the row names its project and the branch the thread pinned.
      expect(threadRow.textContent).toContain("Project");
      expect(threadRow.textContent).toContain("feature/scope-test");

      await page.getByTestId("inbox-scope-trigger").click();
      await page.getByTestId(`inbox-scope-${PROJECT_LOGICAL_KEY}`).click();

      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().inboxProjectScopeKey).toBe(PROJECT_LOGICAL_KEY);
          const scopedRow = document.querySelector<HTMLElement>(
            `[data-testid="thread-row-${THREAD_ID}"]`,
          );
          expect(scopedRow).not.toBeNull();
          // Scoped: the project is implied, but the row keeps its second line.
          expect(scopedRow?.textContent).not.toContain("Project");
          expect(
            scopedRow?.querySelector(`[data-testid="thread-detail-${THREAD_ID}"]`),
          ).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      useUiStateStore.getState().setInboxProjectScope(null);
      await mounted.cleanup();
    }
  });

  it("narrows the live list to rooms from the scope menu and marks the trigger while it does", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rooms-filter-target" as MessageId,
        targetText: "rooms filter target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: { ...nextFixture.serverConfig.settings, enableRooms: true },
        };
      },
    });
    const threadRow = () => document.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`);

    try {
      await waitForElement(threadRow, "Unable to find thread row.");

      await page.getByTestId("inbox-scope-trigger").click();
      await page.getByTestId("inbox-rooms-filter-only").click();
      await vi.waitFor(
        () => {
          // The fixture thread has no added agent, so it is not a room.
          expect(threadRow()).toBeNull();
          expect(document.querySelector('[data-testid="inbox-rooms-filter-mark"]')).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
      await expect.element(page.getByText("No active rooms")).toBeInTheDocument();

      await page.getByTestId("inbox-scope-trigger").click();
      await page.getByTestId("inbox-rooms-filter-all").click();
      await vi.waitFor(
        () => {
          expect(threadRow()).not.toBeNull();
          expect(document.querySelector('[data-testid="inbox-rooms-filter-mark"]')).toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd for draft threads without a worktree path", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await clickProjectMenuItem("Open in VS Code");

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists every open thread once, floats pins to the top, and refuses Done on active statuses", async () => {
    const pinnedThreadId = "thread-pinned-inbox" as ThreadId;
    const backgroundThreadId = "thread-background-inbox" as ThreadId;
    const completedThreadId = "thread-completed-inbox" as ThreadId;
    const settledThreadId = "thread-settled-inbox" as ThreadId;
    const runningSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-running-pin-test" as MessageId,
      targetText: "running pin target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-running-pin-test" as TurnId,
    });
    const withPinnedThread = addThreadToSnapshot(
      addThreadToSnapshot(
        addThreadToSnapshot(
          addThreadToSnapshot(runningSnapshot, pinnedThreadId),
          backgroundThreadId,
        ),
        completedThreadId,
      ),
      settledThreadId,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...withPinnedThread,
        threads: withPinnedThread.threads.map((thread) =>
          thread.id === pinnedThreadId
            ? { ...thread, pinnedAt: NOW_ISO }
            : thread.id === backgroundThreadId
              ? {
                  ...thread,
                  latestTurn: {
                    turnId: "turn-background-inbox" as TurnId,
                    state: "completed",
                    requestedAt: NOW_ISO,
                    startedAt: NOW_ISO,
                    completedAt: NOW_ISO,
                    assistantMessageId: null,
                  },
                  session: thread.session
                    ? { ...thread.session, pendingBackgroundTaskCount: 1 }
                    : thread.session,
                }
              : thread.id === completedThreadId
                ? {
                    ...thread,
                    latestTurn: {
                      turnId: "turn-completed-inbox" as TurnId,
                      state: "completed",
                      requestedAt: NOW_ISO,
                      startedAt: NOW_ISO,
                      completedAt: NOW_ISO,
                      assistantMessageId: null,
                    },
                    lastSeenAt: "2026-01-01T00:00:00.000Z",
                  }
                : thread,
        ),
      },
    });

    try {
      const runningRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find the running thread's row.",
      );
      const pinnedRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${pinnedThreadId}"]`),
        "Unable to find the pinned thread's row.",
      );
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(`[data-testid="thread-row-${backgroundThreadId}"]`),
        "Unable to find the background thread's row.",
      );
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(`[data-testid="thread-row-${completedThreadId}"]`),
        "Unable to find the completed thread's row.",
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${settledThreadId}"]`),
        "Unable to find the settled thread's row.",
      );

      expect(
        pinnedRow.compareDocumentPosition(runningRow) & Node.DOCUMENT_POSITION_FOLLOWING,
        "A pinned thread sorts above the rest of the live list.",
      ).toBeTruthy();
      expect(
        document.querySelectorAll(`[data-testid="thread-row-${THREAD_ID}"]`).length,
        "Each thread is drawn exactly once.",
      ).toBe(1);
      expect(
        document.querySelector(`[data-testid="thread-done-${THREAD_ID}"]`),
        "A running thread cannot be wrapped up.",
      ).toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-done-${backgroundThreadId}"]`),
        "A background thread cannot be wrapped up before inspection.",
      ).toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-done-${completedThreadId}"]`),
        "A completed-unseen thread cannot be wrapped up before inspection.",
      ).toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-done-${settledThreadId}"]`),
        "A settled inspected thread offers Wrap up.",
      ).not.toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-done-${pinnedThreadId}"]`),
        "A pinned thread never offers Wrap up; the pin means keep it here.",
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not keep sending a visit the server will not take", async () => {
    // A computer that went to sleep fails every command at once. The failed
    // visit used to un-mark the thread, which sent the visit again: about 85
    // commands a second until the window stopped answering.
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-unseen-visit" as MessageId,
      targetText: "unseen visit target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          latestTurn: {
            turnId: "turn-unseen-visit" as TurnId,
            state: "completed",
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: NOW_ISO,
            assistantMessageId: null,
          },
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        })),
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && body.type === "thread.seen.set"
          ? Effect.fail(
              new OrchestrationDispatchCommandError({ message: "The computer is not answering." }),
            )
          : undefined,
    });

    try {
      const visits = () =>
        wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.seen.set",
        );
      await vi.waitFor(
        () => {
          expect(visits().length).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Long enough for a loop to show itself many times over. A thread list
      // arriving in that time may offer the visit again, a few times at most.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(visits().length).toBeLessThanOrEqual(4);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps General Chats as its own destination above the scope row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-general-chats-nav" as MessageId,
        targetText: "general chats nav target",
      }),
    });

    try {
      const chatsRow = page.getByTestId("sidebar-general-chats");
      await expect.element(chatsRow).toBeInTheDocument();
      await chatsRow.click();

      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/chats",
        "General Chats should open the chats page.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("gives a live general chat a line under General Chats that opens it", async () => {
    const workingChatId = "thread-general-chat-working" as ThreadId;
    const quietChatId = "thread-general-chat-quiet" as ThreadId;
    const withChats = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-general-chat-lines" as MessageId,
          targetText: "general chat lines target",
        }),
        workingChatId,
      ),
      quietChatId,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...withChats,
        projects: [
          ...withChats.projects,
          {
            id: GENERAL_CHATS_PROJECT_ID,
            kind: "general-chat" as const,
            title: "General Chats",
            workspaceRoot: "/repo/general-chats",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
        ],
        threads: withChats.threads.map((thread) =>
          thread.id === workingChatId
            ? {
                ...thread,
                projectId: GENERAL_CHATS_PROJECT_ID,
                title: "Best way to store passkeys",
                latestTurn: {
                  turnId: "turn-general-chat-working" as TurnId,
                  state: "running" as const,
                  requestedAt: NOW_ISO,
                  startedAt: NOW_ISO,
                  completedAt: null,
                  assistantMessageId: null,
                },
                session: thread.session
                  ? {
                      ...thread.session,
                      status: "running" as const,
                      activeTurnId: "turn-general-chat-working" as TurnId,
                    }
                  : thread.session,
              }
            : thread.id === quietChatId
              ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Draft reply" }
              : thread,
        ),
      },
    });

    try {
      const line = page.getByTestId(`sidebar-general-chat-${workingChatId}`);
      await expect.element(line).toBeInTheDocument();
      await expect
        .element(page.getByTestId(`sidebar-general-chat-status-${workingChatId}`))
        .toMatchTextContent(/^working/);
      expect(
        document.querySelector(`[data-testid="sidebar-general-chat-${quietChatId}"]`),
        "A quiet chat nobody has open has nothing to say, so it gets no line.",
      ).toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-row-${workingChatId}"]`),
        "General chats still stay out of the inbox.",
      ).toBeNull();

      await line.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${workingChatId}`),
        "The line should open its chat.",
      );
      await expect.element(line).toHaveAttribute("aria-current", "page");

      // The General Chats page says the same thing in the same words.
      await page.getByTestId("sidebar-general-chats").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/chats",
        "General Chats should open the chats page.",
      );
      await expect
        .element(
          page
            .getByTestId("chats-view-row")
            .filter({ hasText: "Best way to store passkeys" })
            .getByTestId("chats-view-row-status"),
        )
        .toMatchTextContent(/^working/);

      // The chat settles while the pointer is still over the sidebar (it just
      // clicked General Chats): its line holds still rather than pulling the
      // rows below out from under the pointer, and leaves once it moves away.
      useStore.setState((state) => {
        const environment = state.environmentStateById[LOCAL_ENVIRONMENT_ID]!;
        const summary = environment.sidebarThreadSummaryById[workingChatId]!;
        return {
          environmentStateById: {
            ...state.environmentStateById,
            [LOCAL_ENVIRONMENT_ID]: {
              ...environment,
              sidebarThreadSummaryById: {
                ...environment.sidebarThreadSummaryById,
                [workingChatId]: {
                  ...summary,
                  latestTurn: null,
                  session: summary.session
                    ? { ...summary.session, status: "ready", orchestrationStatus: "ready" }
                    : null,
                },
              },
            },
          },
        };
      });
      await expect
        .element(page.getByTestId(`sidebar-general-chat-status-${workingChatId}`))
        .not.toMatchTextContent(/^working/);
      await expect.element(line).toBeInTheDocument();
      await page.getByTestId("chats-view-row").first().hover();
      await expect.element(line).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows an agent background tab when automation opens a closed browser", async () => {
    // The agent asks for the page while the panel is shut. It used to be told
    // there was no browser; now the request is what opens one.
    const tab = makeBrowserTab();
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {
        [THREAD_KEY]: { open: false, tabs: [tab], activeTabId: tab.id },
      },
      agentStateByThreadKey: {},
      browserOwnershipByThreadKey: {},
    });

    let deliver: ((request: PreviewAutomationRequest) => void) | null = null;
    const responses: PreviewAutomationResponse[] = [];
    __setEnvironmentApiOverrideForTests(
      LOCAL_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: (() =>
          Promise.reject(new Error("not used"))) as EnvironmentApi["filesystem"]["browse"],
        dispatchCommand: (() =>
          Promise.reject(
            new Error("not used"),
          )) as EnvironmentApi["orchestration"]["dispatchCommand"],
        previewAutomation: {
          connect: (_input: unknown, listener: (request: PreviewAutomationRequest) => void) => {
            deliver = listener;
            return () => {
              deliver = null;
            };
          },
          respond: (response: PreviewAutomationResponse) => {
            responses.push(response);
            return Promise.resolve();
          },
        } as unknown as EnvironmentApi["previewAutomation"],
      }),
    );
    let userControlListener: ((event: DesktopPreviewUserControl) => void) | null = null;
    window.desktopBridge = {
      previewStatus: (input: DesktopPreviewTarget) =>
        Promise.resolve({
          url:
            input.webContentsId === 43 ? "http://localhost:5173/manual" : "http://localhost:5173/",
          title: "Preview",
          loading: false,
        }),
      onPreviewUserControl: (listener: (event: DesktopPreviewUserControl) => void) => {
        userControlListener = listener;
        return () => {
          userControlListener = null;
        };
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;

    const screen = await render(<BrowserHostHarness threadRef={THREAD_REF} />);

    try {
      await vi.waitFor(
        () => {
          expect(deliver, "the host should register with the broker").not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      deliver!({
        requestId: "req-auto-open",
        agentId: "agent-browser",
        operation: "openTab",
        input: { url: "http://localhost:5173/manual", background: true },
      } as unknown as PreviewAutomationRequest);

      // The panel opens on its own...
      await vi.waitFor(
        () => {
          expect(useBrowserPanelStore.getState().browserStateByThreadKey[THREAD_KEY]?.open).toBe(
            true,
          );
        },
        { timeout: 4_000, interval: 16 },
      );

      // The initial blank guest lets the queued operation begin.
      registerPreviewWebview(THREAD_REF, tab.id, {
        getWebContentsId: () => 42,
        loadURL: () => Promise.resolve(),
        getBoundingClientRect: () => ({ width: 900, height: 600 }) as DOMRect,
      });

      let openedTabId = "";
      await vi.waitFor(
        () => {
          const state = useBrowserPanelStore.getState().browserStateByThreadKey[THREAD_KEY];
          expect(state?.tabs).toHaveLength(1);
          expect(state?.tabs[0]?.url).toBe("http://localhost:5173/manual");
          expect(state?.activeTabId).toBe(state?.tabs[0]?.id);
          openedTabId = state?.activeTabId ?? "";
          expect(openedTabId).not.toBe("");
        },
        { timeout: 4_000, interval: 16 },
      );

      registerPreviewWebview(THREAD_REF, openedTabId, {
        getWebContentsId: () => 43,
        loadURL: () => Promise.resolve(),
        getBoundingClientRect: () => ({ width: 900, height: 600 }) as DOMRect,
      });

      await vi.waitFor(
        () => {
          expect(responses).toHaveLength(1);
          expect(responses[0]?.error, "the request should not report a missing browser").toBe(
            undefined,
          );
          expect(responses[0]?.result).toMatchObject({
            tabId: openedTabId,
            url: "http://localhost:5173/manual",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      const notifyUserControl = userControlListener as
        | ((event: DesktopPreviewUserControl) => void)
        | null;
      notifyUserControl?.({ webContentsId: 43, input: "pointer" });
      deliver!({
        requestId: "req-auto-close-after-takeover",
        agentId: "agent-browser",
        operation: "closeTab",
        input: { tabId: openedTabId },
      } as unknown as PreviewAutomationRequest);

      await vi.waitFor(
        () => {
          expect(responses).toHaveLength(2);
          expect(responses[1]?.result).toMatchObject({ panelOpen: true });
          expect(useBrowserPanelStore.getState().browserStateByThreadKey[THREAD_KEY]?.open).toBe(
            true,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      screen.unmount();
      resetPreviewWebviewsForTests();
      useBrowserPanelStore.setState({
        browserStateByThreadKey: {},
        agentStateByThreadKey: {},
        browserOwnershipByThreadKey: {},
      });
      Reflect.deleteProperty(window, "desktopBridge");
      __resetEnvironmentApiOverridesForTests();
    }
  });

  it("keeps a working row's status whole and drops the branch to make room", async () => {
    const longBranch = "feature/a-very-long-branch-name-that-would-never-fit-in-the-sidebar";
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-working-collision" as MessageId,
      targetText: "working collision target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-working-collision" as TurnId,
    });
    const branched = withThreadBranch(base, longBranch);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...branched,
        projects: base.projects.map((project) => ({
          ...project,
          title: "A project with a deliberately long display name",
        })),
        // A running session has a turn under way; that turn is what the
        // elapsed counter counts from.
        threads: branched.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                latestTurn: {
                  turnId: "turn-working-collision" as TurnId,
                  state: "running" as const,
                  requestedAt: NOW_ISO,
                  startedAt: NOW_ISO,
                  completedAt: null,
                  assistantMessageId: null,
                },
              }
            : thread,
        ),
      },
    });

    try {
      const row = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find the working thread's row.",
      );
      const meta = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-meta-${THREAD_ID}"]`),
        "Unable to find the row's status slot.",
      );

      await vi.waitFor(
        () => {
          // A duration, never the relative formatter's "just now".
          expect(meta.textContent).toMatch(/^working\s·\s\d+[smh]/);
        },
        { timeout: 8_000, interval: 16 },
      );

      // The status slot is never the thing that gets cut.
      expect(meta.scrollWidth).toBeLessThanOrEqual(meta.clientWidth + 1);
      expect(meta.getBoundingClientRect().right).toBeLessThanOrEqual(
        row.getBoundingClientRect().right,
      );
      // The branch yields first, and yields completely.
      expect(row.textContent).not.toContain("feature/");
    } finally {
      await mounted.cleanup();
    }
  });

  /** A room row whose added agent has been at work for twelve and a half minutes. */
  async function mountRoomWorkingRow(agent: { readonly model: string; readonly role?: string }) {
    const agentId = "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId;
    // The widest clock a turn shows before its first hour ("12m 30s").
    const startedAt = new Date(Date.now() - 12.5 * 60_000).toISOString();
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-room-working" as MessageId,
      targetText: "room working target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-room-working" as TurnId,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                participants: [
                  {
                    id: agentId,
                    handle: "agent-2",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: agent.model,
                    },
                    ...(agent.role !== undefined ? { role: agent.role } : {}),
                    joinedAt: NOW_ISO,
                    leftAt: null,
                  },
                ],
                session: thread.session ? { ...thread.session, participantId: agentId } : null,
                latestTurn: {
                  turnId: "turn-room-working" as TurnId,
                  state: "running" as const,
                  requestedAt: startedAt,
                  startedAt,
                  completedAt: null,
                  assistantMessageId: null,
                },
              }
            : thread,
        ),
      },
    });
    try {
      const line = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-detail-${THREAD_ID}"]`),
        "Unable to find the working room's row.",
      );
      const meta = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-meta-${THREAD_ID}"]`),
        "Unable to find the row's status slot.",
      );
      await vi.waitFor(
        () => {
          expect(meta.textContent).toMatch(/.\s·\sworking\s·\s12m \d+s$/);
        },
        { timeout: 8_000, interval: 16 },
      );
      const [name, , state, , clock] = [...meta.children] as HTMLElement[];
      const project = [...line.querySelectorAll<HTMLElement>("span")].find(
        (element) => element.textContent === "Project",
      );
      return { mounted, line, name: name!, state: state!, clock: clock!, project };
    } catch (error) {
      await mounted.cleanup();
      throw error;
    }
  }

  /** Whether an element shows its whole text: the laid-out text, fractions
   *  included, fits its box (a fraction over already draws an ellipsis). */
  const showsWholeText = (element: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().width <= element.getBoundingClientRect().width + 0.01;
  };

  it("keeps a room's working agent, state and clock whole at the default width", async () => {
    const { mounted, line, name, state, clock, project } = await mountRoomWorkingRow({
      model: "Opus 5.5",
    });
    try {
      for (const part of [name, state, clock]) {
        expect(showsWholeText(part)).toBe(true);
        expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(
          line.getBoundingClientRect().right + 0.5,
        );
      }
      // The project name stays in the row; it is what gave way.
      expect(project).toBeDefined();
      expect(showsWholeText(project!)).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shortens a long agent name only once the project name is gone", async () => {
    const { mounted, line, name, state, clock, project } = await mountRoomWorkingRow({
      model: "Opus 5.5",
      // Custom names go up to 32 characters.
      role: "Reviewer with a very long name",
    });
    try {
      expect(name.textContent).toBe("Reviewer with a very long name");
      expect(showsWholeText(name)).toBe(false);
      expect(project!.getBoundingClientRect().width).toBeLessThan(0.5);
      for (const part of [state, clock]) {
        expect(showsWholeText(part)).toBe(true);
        expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(
          line.getBoundingClientRect().right + 0.5,
        );
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("follows a side answer's links between its question and where it was posted", async () => {
    const agentId = "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId;
    const sideTurnId = "side-reveal" as SideTurnId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-side-reveal" as MessageId,
      targetText: "side reveal target",
    });
    // Asked early, answered after the rest of the thread went on: the answer
    // is posted far below its question.
    const question = {
      id: "side-question-reveal" as MessageId,
      role: "user" as const,
      text: "Is the lock released on every path?",
      participantId: agentId,
      sideTurnId,
      turnId: null,
      streaming: false,
      createdAt: isoAt(10),
      updatedAt: isoAt(10),
    };
    const answer = {
      id: "side-answer-reveal" as MessageId,
      role: "assistant" as const,
      text: "Yes, except when the write fails.",
      participantId: agentId,
      sideTurnId,
      turnId: null,
      streaming: false,
      createdAt: isoAt(118),
      updatedAt: isoAt(120),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                participants: [
                  {
                    id: agentId,
                    handle: "agent-2",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-6-astra",
                    },
                    joinedAt: NOW_ISO,
                    leftAt: null,
                  },
                ],
                messages: [...thread.messages, question, answer].toSorted((a, b) =>
                  a.createdAt.localeCompare(b.createdAt),
                ),
              }
            : thread,
        ),
      },
    });

    try {
      const list = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-messages-list="true"]'),
        "Unable to find the message list.",
      );
      // Where a followed link puts its row: a fifth of the way down the list,
      // or as far as the list goes when the row is near its end.
      const expectRevealed = async (messageId: string) => {
        await vi.waitFor(
          () => {
            const row = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
            expect(row).not.toBeNull();
            const listRect = list.getBoundingClientRect();
            const top = row!.getBoundingClientRect().top;
            const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
            if (atEnd) {
              expect(top).toBeGreaterThanOrEqual(listRect.top);
              expect(top).toBeLessThan(listRect.bottom - 40);
            } else {
              expect(Math.abs(top - (listRect.top + listRect.height * 0.2))).toBeLessThan(12);
            }
          },
          { timeout: 8_000, interval: 50 },
        );
      };

      // Up from the answer, which the list opens at, to its question...
      const back = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
            button.textContent?.includes("Is the lock released"),
          ) ?? null,
        "Unable to find the answer's link back to its question.",
      );
      back.click();
      await expectRevealed("side-question-reveal");

      // ...and down again from the line under the question.
      const below = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-side-answer-status="answered-below"] button',
          ),
        "Unable to find the line leading to the answer.",
      );
      expect(below.textContent).toContain("answer is below");
      below.click();
      await expectRevealed("side-answer-reveal");
    } finally {
      await mounted.cleanup();
    }
  });

  it("reveals the wrapped tail and folds it back", async () => {
    const doneThreadIds = Array.from(
      { length: 13 },
      (_, index) => `thread-wrapped-${index}` as ThreadId,
    );
    const snapshot = doneThreadIds.reduce(
      (current, threadId) => addThreadToSnapshot(current, threadId),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-done-fold" as MessageId,
        targetText: "done fold target",
      }),
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    const expectDoneRows = async (count: number, revealLabel: string | null) => {
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid^="done-row-"]').length).toBe(count);
          const reveal = document.querySelector('[data-testid="inbox-done-show-more"]');
          if (revealLabel === null) {
            expect(reveal).toBeNull();
          } else {
            expect(reveal?.textContent).toContain(revealLabel);
          }
        },
        { timeout: 8_000, interval: 16 },
      );
    };

    try {
      await expect.element(page.getByTestId(`thread-row-${THREAD_ID}`)).toBeInTheDocument();
      const doneAt = new Date().toISOString();
      for (const threadId of doneThreadIds) {
        markThreadDoneInTest(
          scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId)),
          doneAt,
        );
      }

      // Thirteen wrapped threads, ten previewed, the rest behind the reveal.
      await expectDoneRows(10, "Show 3 more");
      expect(document.querySelector('[data-testid="inbox-done-show-fewer"]')).toBeNull();

      await page.getByTestId("inbox-done-show-more").click();
      // Everything is out, so only the fold-back control remains.
      await expectDoneRows(13, null);

      await page.getByTestId("inbox-done-show-fewer").click();
      await expectDoneRows(10, "Show 3 more");
      expect(document.querySelector('[data-testid="inbox-done-show-fewer"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the thread you are reading on the shelf when Done collapses", async () => {
    const otherDoneThreadId = "thread-done-collapse" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-done-collapse" as MessageId,
          targetText: "done collapse target",
        }),
        otherDoneThreadId,
      ),
    });

    try {
      await expect.element(page.getByTestId(`thread-row-${THREAD_ID}`)).toBeInTheDocument();
      const otherThreadKey = scopedThreadKey(
        scopeThreadRef(LOCAL_ENVIRONMENT_ID, otherDoneThreadId),
      );
      const doneAt = new Date().toISOString();
      markThreadDoneInTest(THREAD_KEY, doneAt);
      markThreadDoneInTest(otherThreadKey, doneAt);

      await vi.waitFor(
        () => {
          expect(document.querySelector(`[data-testid="done-row-${THREAD_ID}"]`)).not.toBeNull();
          expect(
            document.querySelector(`[data-testid="done-row-${otherDoneThreadId}"]`),
          ).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByTestId("inbox-done-toggle").click();

      await vi.waitFor(
        () => {
          // Collapsing a section must not close the thread open inside it.
          expect(document.querySelector(`[data-testid="done-row-${THREAD_ID}"]`)).not.toBeNull();
          expect(
            document.querySelector(`[data-testid="done-row-${otherDoneThreadId}"]`),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves a thread into the Done tail and back with Reopen", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-done-lifecycle" as MessageId,
        targetText: "done lifecycle target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);
      await expect.element(threadRow).toBeInTheDocument();
      await threadRow.hover();
      await page.getByTestId(`thread-done-${THREAD_ID}`).click();

      await vi.waitFor(
        () => {
          expect(document.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`)).toBeNull();
          expect(document.querySelector(`[data-testid="done-row-${THREAD_ID}"]`)).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      const doneRow = page.getByTestId(`done-row-${THREAD_ID}`);
      await doneRow.hover();
      await page.getByTestId(`done-reopen-${THREAD_ID}`).click();

      await vi.waitFor(
        () => {
          expect(document.querySelector(`[data-testid="done-row-${THREAD_ID}"]`)).toBeNull();
          expect(document.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`)).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the full thread title in the row hover card, and nothing else", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      const threadTitle = page.getByTestId(`thread-title-${THREAD_ID}`);

      await expect.element(threadTitle).toBeInTheDocument();
      await threadTitle.hover();

      await vi.waitFor(
        () => {
          const hoverCard = document.querySelector<HTMLElement>(
            '[data-testid="thread-hover-card"]',
          );
          expect(hoverCard).not.toBeNull();
          expect(hoverCard?.textContent).toContain(THREAD_TITLE);
          // The hover card is the only popup: a truncated title must not raise
          // a second one on top of it.
          expect(document.querySelectorAll('[data-testid="thread-hover-card"]').length).toBe(1);
          // And no tooltip stacked on top: the card moved off the tooltip
          // primitive precisely so the two can never compete.
          expect(document.querySelectorAll('[data-slot="tooltip-popup"]').length).toBe(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the confirm archive action after clicking the archive button", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        confirmThreadArchive: true,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-confirm-test" as MessageId,
        targetText: "archive confirm target",
      }),
    });

    try {
      // live -> done -> archived: archive is only offered once a thread has
      // been filed away.
      await expect.element(page.getByTestId(`thread-row-${THREAD_ID}`)).toBeInTheDocument();
      markThreadDoneInTest(THREAD_KEY, new Date().toISOString());

      const doneRow = page.getByTestId(`done-row-${THREAD_ID}`);
      await expect.element(doneRow).toBeInTheDocument();
      await doneRow.hover();

      const archiveButton = page.getByTestId(`thread-archive-${THREAD_ID}`);
      await expect.element(archiveButton).toBeInTheDocument();
      await archiveButton.click();

      const confirmButton = page.getByTestId(`thread-archive-confirm-${THREAD_ID}`);
      await expect.element(confirmButton).toBeInTheDocument();
      await expect.element(confirmButton).toBeVisible();
    } finally {
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
      await mounted.cleanup();
    }
  });

  it("puts a new thread's composer in the middle of the pane until its first turn starts", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-hero-test" as MessageId,
        targetText: "draft hero test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = draftThreadIdFor(draftIdFromPath(newThreadPath));
      const editor = await waitForComposerEditor();

      // The question sits above the composer and the recent threads below
      // it, with the pane's bottom edge well clear of both.
      const column = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-column]:has([data-draft-hero])"),
        "Unable to find the chat column in its hero layout.",
      );
      await vi.waitFor(
        () => {
          const question = column.querySelector<HTMLElement>("[data-draft-hero]");
          const recent = column.querySelector<HTMLElement>(
            '[data-testid="draft-empty-recent-thread"]',
          );
          expect(question).not.toBeNull();
          expect(recent).not.toBeNull();
          const composer = editor.getBoundingClientRect();
          expect(question!.getBoundingClientRect().bottom).toBeLessThanOrEqual(composer.top);
          expect(recent!.getBoundingClientRect().top).toBeGreaterThanOrEqual(composer.bottom);
          expect(column.getBoundingClientRect().bottom - composer.bottom).toBeGreaterThan(250);
        },
        { timeout: 8_000, interval: 16 },
      );

      // The first turn starting ends the hero. The composer drops to the
      // bottom of the pane, and it is the same editor: the layout changed
      // around it without remounting it, so what was typed and focused stays.
      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      await setPromotedServerThreadRunningViaDomainEvent(newThreadId);
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-draft-hero]")).toBeNull();
          expect(
            document
              .querySelector<HTMLElement>('[data-testid="draft-empty-recent-thread"]')
              ?.checkVisibility() ?? false,
          ).toBe(false);
          expect(document.querySelector('[contenteditable="true"]')).toBe(editor);
          expect(
            column.getBoundingClientRect().bottom - editor.getBoundingClientRect().bottom,
          ).toBeLessThan(200);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Real turn activity promotes the draft: the route swaps to the server
      // thread's own chat view. Its composer is a new one, and it has to land
      // at the bottom of the pane too, with no hero left behind.
      await addPromotedServerUserMessageViaDomainEvent(newThreadId);
      await startPromotedServerTurnViaDomainEvent(newThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Promoted drafts should canonicalize to the server thread route.",
      );
      await vi.waitFor(
        () => {
          const promotedColumn = document.querySelector<HTMLElement>("[data-chat-column]");
          const promotedEditor = document.querySelector<HTMLElement>('[contenteditable="true"]');
          expect(promotedColumn).not.toBeNull();
          expect(promotedEditor).not.toBeNull();
          expect(document.querySelector("[data-draft-hero]")).toBeNull();
          expect(
            promotedColumn!.getBoundingClientRect().bottom -
              promotedEditor!.getBoundingClientRect().bottom,
          ).toBeLessThan(200);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
