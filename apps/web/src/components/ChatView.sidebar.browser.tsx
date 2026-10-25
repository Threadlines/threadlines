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
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { CLIENT_SETTINGS_STORAGE_KEY } from "../clientPersistenceStorage";
import type { SidebarThreadSummary } from "../types";
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
import { getClientSettings, updateSettings } from "../hooks/useSettings";
import { isMacPlatform } from "../lib/utils";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";

import { DEFAULT_CLIENT_SETTINGS } from "@threadlines/contracts/settings";
import {
  THREAD_ID,
  THREAD_TITLE,
  SECOND_PROJECT_ID,
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
  setSidebarThreadWork,
  touchSwipe,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  materializePromotedDraftThreadViaDomainEvent,
  setPromotedServerThreadRunningViaDomainEvent,
  addPromotedServerUserMessageViaDomainEvent,
  startPromotedServerTurnViaDomainEvent,
  createDraftOnlySnapshot,
  setDraftThreadWithoutWorktree,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  waitForServerConfigToApply,
  mountChatView,
  fixture,
  clickProjectMenuItem,
  registerChatViewSuiteHooks,
  openCommandPaletteFromTrigger,
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

  it("narrows the live list from the scope menu and keeps the project name on its rows", async () => {
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
          expect(useUiStateStore.getState().inboxProjectScopeKeys).toEqual([PROJECT_LOGICAL_KEY]);
          expect(
            document.querySelector("[data-testid='inbox-scope-trigger']")?.textContent,
          ).toContain("Project");
          const scopedRow = document.querySelector<HTMLElement>(
            `[data-testid="thread-row-${THREAD_ID}"]`,
          );
          expect(scopedRow).not.toBeNull();
          // Scoped: the row still names its project; the menu that says what
          // the list is narrowed to is out of sight while you read the rows.
          expect(
            scopedRow?.querySelector(`[data-testid="thread-detail-${THREAD_ID}"]`)?.textContent,
          ).toContain("Project");
        },
        { timeout: 4_000, interval: 16 },
      );

      // Clicking it again takes it back out: the list is unscoped.
      await page.getByTestId(`inbox-scope-${PROJECT_LOGICAL_KEY}`).click();
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().inboxProjectScopeKeys).toEqual([]);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      useUiStateStore.getState().setInboxProjectScope([]);
      await mounted.cleanup();
    }
  });

  it("narrows the live list to rooms from the View button and marks it while it does", async () => {
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

      const viewTrigger = () => document.querySelector('[data-testid="inbox-view-trigger"]');
      await page.getByTestId("inbox-view-trigger").click();
      await page.getByTestId("inbox-rooms-filter-only").click();
      await vi.waitFor(
        () => {
          // The fixture thread has no added agent, so it is not a room.
          expect(threadRow()).toBeNull();
          expect(viewTrigger()?.getAttribute("data-filtered")).toBe("true");
        },
        { timeout: 4_000, interval: 16 },
      );
      await expect.element(page.getByText("No active rooms")).toBeInTheDocument();

      await page.getByTestId("inbox-view-trigger").click();
      await page.getByTestId("inbox-rooms-filter-all").click();
      await vi.waitFor(
        () => {
          expect(threadRow()).not.toBeNull();
          expect(viewTrigger()?.hasAttribute("data-filtered")).toBe(false);
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

  it("groups the thread menu, renames from the palette through a dialog, and wraps up a selection by the inbox's rules", async () => {
    const pinnedThreadId = "thread-menu-pinned" as ThreadId;
    const settledThreadId = "thread-menu-settled" as ThreadId;
    const withThreads = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-thread-menu" as MessageId,
          targetText: "thread menu",
        }),
        pinnedThreadId,
      ),
      settledThreadId,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...withThreads,
        threads: withThreads.threads.map((thread) =>
          thread.id === pinnedThreadId ? { ...thread, pinnedAt: NOW_ISO } : thread,
        ),
      },
    });

    try {
      // The row's menu: the thread's own actions, then groups ending in
      // Archive and Delete.
      const row = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "The thread's sidebar row should be on screen.",
      );
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 20,
          clientY: rect.top + 8,
        }),
      );
      for (const label of ["Rename", "Pin", "Mark unread", "Copy path", "Archive", "Delete"]) {
        await expect.element(page.getByRole("button", { name: label, exact: true })).toBeVisible();
      }
      expect(document.querySelectorAll('[role="separator"]').length).toBeGreaterThanOrEqual(2);
      await userEvent.keyboard("{Escape}");

      // The palette's Rename asks in a dialog, and saving sends the new name.
      await openCommandPaletteFromTrigger();
      await page.getByTestId("command-palette").getByText("Rename thread", { exact: true }).click();
      const input = page.getByTestId("thread-rename-input");
      await expect.element(input).toHaveValue(THREAD_TITLE);
      await input.fill("Renamed from the palette");
      await page.getByTestId("thread-rename-save").click();
      await vi.waitFor(() => {
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.meta.update" &&
              request.title === "Renamed from the palette",
          ),
        ).toBe(true);
      });
      await expect.element(page.getByTestId("thread-rename-dialog")).not.toBeInTheDocument();

      // Wrap up over a selection skips what its own menu wouldn't wrap up:
      // the pinned thread stays where it is.
      const keyOf = (threadId: ThreadId) =>
        scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId));
      useThreadSelectionStore.getState().toggleThread(keyOf(pinnedThreadId));
      useThreadSelectionStore.getState().toggleThread(keyOf(settledThreadId));
      const settledRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${settledThreadId}"]`),
        "The settled thread's row should be on screen.",
      );
      const settledRect = settledRow.getBoundingClientRect();
      settledRow.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: settledRect.left + 20,
          clientY: settledRect.top + 8,
        }),
      );
      await page.getByRole("button", { name: "Wrap up (2)", exact: true }).click();
      const wrapped = () =>
        wsRequests.flatMap((request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.done-override.set"
            ? [request.threadId]
            : [],
        );
      await vi.waitFor(() => {
        expect(wrapped()).toEqual([settledThreadId]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("counts general chats on the rail, keeps them out of the inbox, and selects General Chats while one is open", async () => {
    const workingChatId = "thread-general-chat-working" as ThreadId;
    const askingChatId = "thread-general-chat-asking" as ThreadId;
    const withChats = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-general-chat-rail" as MessageId,
          targetText: "general chat rail target",
        }),
        workingChatId,
      ),
      askingChatId,
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
              }
            : thread.id === askingChatId
              ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Draft reply" }
              : thread,
        ),
      },
    });

    try {
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, workingChatId, "working");
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, askingChatId, "needs-you");
      const chatsButton = page.getByTestId("rail-chats");
      // Beside the threads list, the chats' work shows on the rail.
      await expect.element(chatsButton.getByTestId("rail-needs-you-badge")).toMatchTextContent("1");
      await expect.element(page.getByTestId("rail-chats-working")).toMatchTextContent("1");
      // The inbox's own counts leave them out.
      expect(
        document.querySelector('[data-testid="rail-threads"] [data-testid="rail-needs-you-badge"]'),
      ).toBeNull();
      expect(document.querySelector(`[data-testid="thread-row-${workingChatId}"]`)).toBeNull();

      // The count is part of the button: clicking it goes where the icon does.
      await page.getByTestId("rail-chats-working").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/chats",
        "General Chats should open the chats page.",
      );
      // The chats are the list beside the rail; the page offers to start one.
      await expect.element(page.getByTestId("chats-view-new-chat")).toBeVisible();
      await expect
        .element(
          page
            .getByTestId("chats-list-row")
            .filter({ hasText: "Best way to store passkeys" })
            .getByTestId("chats-list-row-status"),
        )
        .toMatchTextContent(/^working/);
      // The list says what is working, so the rail stops saying it.
      expect(document.querySelector('[data-testid="rail-chats-working"]')).toBeNull();

      await page.getByTestId("chats-list-row").filter({ hasText: "Draft reply" }).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${askingChatId}`),
        "A chat row should open its chat.",
      );
      await expect.element(chatsButton).toHaveAttribute("aria-current", "page");
      expect(
        document.querySelector('[data-testid="rail-threads"]')?.getAttribute("aria-current"),
      ).toBeNull();
      // The open chat stays listed beside it, marked as the one on screen.
      await expect
        .element(page.getByTestId("chats-list-row").filter({ hasText: "Draft reply" }))
        .toHaveAttribute("aria-current", "page");
    } finally {
      await mounted.cleanup();
    }
  });

  it("swipes a general chat: left archives it with an undo, right pins it, and a working chat keeps it", async () => {
    const idleChatId = "thread-general-chat-swipe-idle" as ThreadId;
    const workingChatId = "thread-general-chat-swipe-working" as ThreadId;
    const withChats = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-general-chat-swipe" as MessageId,
          targetText: "general chat swipe target",
        }),
        idleChatId,
      ),
      workingChatId,
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
          thread.id === idleChatId
            ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Draft reply" }
            : thread.id === workingChatId
              ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Still thinking" }
              : thread,
        ),
      },
    });
    const row = (title: string) =>
      page.getByTestId("chats-list-row").filter({ hasText: title }).element();
    const swipeAction = () => document.querySelector("[data-testid='row-swipe-action']");

    try {
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, workingChatId, "working", {
        session: {
          provider: "codex",
          status: "running",
          activeTurnId: "turn-still-thinking" as TurnId,
        } as SidebarThreadSummary["session"],
      });
      await page.getByTestId("rail-chats").click();
      await expect.element(page.getByTestId("chats-list-row").first()).toBeVisible();

      // Left: archived, and the list offers it back.
      touchSwipe(row("Draft reply"), -260);
      await expect
        .element(page.getByTestId("swipe-undo-bar"))
        .toMatchTextContent(/Archived Draft reply/);
      await page.getByTestId("swipe-undo-bar").getByRole("button", { name: "Undo" }).click();
      await expect.element(page.getByTestId("swipe-undo-bar")).not.toBeInTheDocument();

      // Right shows Pin under the row.
      const target = row("Draft reply");
      const rect = target.getBoundingClientRect();
      const at = (x: number) => ({
        bubbles: true,
        clientX: x,
        clientY: rect.top + rect.height / 2,
        pointerId: 22,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
      });
      target.dispatchEvent(new PointerEvent("pointerdown", at(rect.left + 20)));
      for (let step = 1; step <= 10; step += 1) {
        target.dispatchEvent(new PointerEvent("pointermove", at(rect.left + 20 + step * 18)));
      }
      await vi.waitFor(() => expect(swipeAction()?.textContent).toBe("Pin"));
      target.dispatchEvent(new PointerEvent("pointercancel", at(rect.left + 200)));
      await vi.waitFor(() => expect(swipeAction()).toBeNull());

      // A chat whose agent is mid-turn can't be archived, so it doesn't swipe left.
      touchSwipe(row("Still thinking"), -260);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(document.querySelector("[data-testid='swipe-undo-bar']")).toBeNull();
      expect(row("Still thinking")).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("steps between general chats with the next and previous shortcuts, and dots an unread one on the rail", async () => {
    // Same timestamps, so the chats page and the shortcuts order them c, b, a.
    const chatA = "thread-chat-traverse-a" as ThreadId;
    const chatB = "thread-chat-traverse-b" as ThreadId;
    const chatC = "thread-chat-traverse-c" as ThreadId;
    const base = [chatA, chatB, chatC].reduce(
      addThreadToSnapshot,
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-traversal" as MessageId,
        targetText: "chat traversal",
      }),
    );
    const traversalKeybinding = (command: "thread.next" | "thread.previous", key: string) =>
      ({
        command,
        shortcut: {
          key,
          metaKey: false,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          modKey: true,
        },
        whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
      }) as const;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${chatB}`,
      snapshot: {
        ...base,
        projects: [
          ...base.projects,
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
        threads: base.threads.map((thread) =>
          thread.id === chatA || thread.id === chatB || thread.id === chatC
            ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID }
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            traversalKeybinding("thread.next", "]"),
            traversalKeybinding("thread.previous", "["),
          ],
        };
      },
    });
    const useMetaForMod = isMacPlatform(navigator.platform);
    const press = (direction: "next" | "previous") =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: direction === "next" ? "}" : "{",
          code: direction === "next" ? "BracketRight" : "BracketLeft",
          shiftKey: true,
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

    try {
      await waitForServerConfigToApply();
      // An answer finishes on a chat that is not open, after the app loaded.
      const answer = {
        turnId: "turn-chat-traverse-c" as TurnId,
        state: "completed",
        requestedAt: NOW_ISO,
        startedAt: NOW_ISO,
        completedAt: new Date(Date.now() + 60_000).toISOString(),
        assistantMessageId: null,
      } as const;
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, chatC, "working", {
        session: null,
        latestTurn: answer,
      });
      // Opening the chat loads the same answer, so only reading it clears the dot.
      fixture.snapshot = {
        ...fixture.snapshot,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === chatC ? { ...thread, latestTurn: answer } : thread,
        ),
      };
      const chatsButton = page.getByTestId("rail-chats");
      // The chats list beside the open chat marks the answer, so the rail leaves it be.
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll('[data-testid="chats-list-row"][data-unread]'),
        ).toHaveLength(1);
      });
      expect(
        document.querySelector('[data-testid="rail-chats"] [data-testid="rail-unread-dot"]'),
      ).toBeNull();
      // With the list hidden, an unread answer is a blue dot, not a count:
      // nothing waits on the user.
      await page.getByTestId("titlebar-sidebar-toggle").click();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().sidebarListOpen).toBe(false);
      });
      await expect.element(chatsButton.getByTestId("rail-unread-dot")).toBeVisible();
      expect(
        document.querySelector('[data-testid="rail-chats"] [data-testid="rail-needs-you-badge"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="rail-threads"] [data-testid="rail-unread-dot"]'),
      ).toBeNull();

      // From a chat, the shortcuts walk the chats, never into the inbox.
      press("next");
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${chatA}`),
        "Next should open the older chat.",
      );
      await waitForLayout();
      press("next");
      press("previous");
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${chatB}`),
        "Next past the last chat stays put; previous steps back.",
      );
      await waitForLayout();
      press("previous");
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${chatC}`),
        "Previous should open the newer chat.",
      );
      // Opening it reads the answer: the dot goes.
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="rail-chats"] [data-testid="rail-unread-dot"]'),
        ).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups the inbox by project with families under their parent, and folds a group", async () => {
    const otherProjectThreadId = "thread-group-other-project" as ThreadId;
    const childThreadId = "thread-group-child" as ThreadId;
    const base = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-inbox-groups" as MessageId,
          targetText: "inbox groups",
        }),
        otherProjectThreadId,
      ),
      childThreadId,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        projects: [
          ...base.projects,
          {
            ...base.projects[0]!,
            id: SECOND_PROJECT_ID,
            title: "Second project",
            workspaceRoot: "/repo/second-project",
          },
        ],
        threads: base.threads.map((thread) =>
          thread.id === otherProjectThreadId
            ? { ...thread, projectId: SECOND_PROJECT_ID, title: "Second project thread" }
            : thread,
        ),
      },
    });

    try {
      // A thread the other project's thread started, filed under the first
      // project: it travels with its parent.
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, childThreadId, "working", {
        parentThreadId: otherProjectThreadId,
        attachedToParent: true,
        title: "Child thread",
      });
      updateSettings({ sidebarGrouping: "project" });
      const headers = () =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="inbox-group-project:"]'));
      await vi.waitFor(() => expect(headers()).toHaveLength(2));
      const secondHeader = headers().find((header) =>
        header.textContent?.includes("Second project"),
      )!;
      // The family's work counts on its parent's group.
      expect(secondHeader.textContent).toContain("1 working");
      const listed = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="inbox-thread-list"] [data-testid^="inbox-group-"], [data-testid="inbox-thread-list"] [data-testid^="thread-row-"]',
        ),
      ).map((element) => element.dataset.testid);
      const parentIndex = listed.indexOf(`thread-row-${otherProjectThreadId}`);
      expect(listed[parentIndex - 1]).toBe(secondHeader.dataset.testid);
      // The child folds into its parent's family line rather than standing
      // in its own project's group.
      await expect.element(page.getByTestId(`thread-family-${otherProjectThreadId}`)).toBeVisible();
      expect(listed).not.toContain(`thread-row-${childThreadId}`);

      secondHeader.click();
      await expect
        .element(page.getByTestId(`thread-row-${otherProjectThreadId}`))
        .not.toBeInTheDocument();
      expect(useUiStateStore.getState().collapsedInboxGroups).toEqual({
        [secondHeader.dataset.testid!.slice("inbox-group-".length)]: true,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps idle threads in the list once Wrap up idle threads is off", async () => {
    const idleThreadId = "thread-idle-for-days" as ThreadId;
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    const base = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-wrap-idle" as MessageId,
        targetText: "wrap idle",
      }),
      idleThreadId,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === idleThreadId
            ? {
                ...thread,
                title: "Quiet for days",
                createdAt: threeDaysAgo,
                updatedAt: threeDaysAgo,
                lastSeenAt: threeDaysAgo,
              }
            : thread,
        ),
      },
    });

    try {
      await page.getByTestId("inbox-done-toggle").click();
      await expect.element(page.getByTestId(`done-row-${idleThreadId}`)).toBeInTheDocument();

      await page.getByTestId("rail-settings").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.startsWith("/settings"),
        "Settings should open from the rail.",
      );
      await mounted.router.navigate({ to: "/settings/threads" });
      await page.getByRole("switch", { name: "Wrap up idle threads" }).click();
      expect(getClientSettings().wrapUpIdleThreads).toBe(false);

      await page.getByTestId("rail-threads").click();
      await expect.element(page.getByTestId(`thread-row-${idleThreadId}`)).toBeInTheDocument();
      expect(document.querySelector(`[data-testid="done-row-${idleThreadId}"]`)).toBeNull();
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

  it("keeps a room's working agent, state, clock and project whole at the default width", async () => {
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
      // The list starts wide enough beside the rail for a short project name
      // too; it is the first thing to give way when it has to (below).
      expect(project).toBeDefined();
      expect(showsWholeText(project!)).toBe(true);
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

      // The shelf starts closed: open it. Thirteen wrapped threads, ten
      // previewed, the rest behind the reveal.
      await page.getByTestId("inbox-done-toggle").click();
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

  it("parks Wrapped closed at the column's foot and opens it to half the column", async () => {
    const liveThreadIds = Array.from(
      { length: 16 },
      (_, index) => `thread-live-${index}` as ThreadId,
    );
    const todayThreadIds = Array.from(
      { length: 3 },
      (_, index) => `thread-wrapped-today-${index}` as ThreadId,
    );
    const idleThreadIds = Array.from(
      { length: 9 },
      (_, index) => `thread-wrapped-idle-${index}` as ThreadId,
    );
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    const base = [...liveThreadIds, ...todayThreadIds, ...idleThreadIds].reduce(
      (current, threadId) => addThreadToSnapshot(current, threadId),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-wrapped-shelf" as MessageId,
        targetText: "wrapped shelf target",
      }),
    );
    const idle = new Set<string>(idleThreadIds);
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, name: "short", height: 720 },
      snapshot: {
        ...base,
        // Quiet for days, so they wrap up on their own, dated then.
        threads: base.threads.map((thread) =>
          idle.has(thread.id)
            ? {
                ...thread,
                createdAt: threeDaysAgo,
                updatedAt: threeDaysAgo,
                lastSeenAt: threeDaysAgo,
              }
            : thread,
        ),
      },
    });
    const shelfAndColumn = () => {
      const shelf = document.querySelector<HTMLElement>('[data-testid="inbox-wrapped-shelf"]');
      expect(shelf).not.toBeNull();
      return {
        shelf: shelf!.getBoundingClientRect(),
        column: shelf!.parentElement!.getBoundingClientRect(),
      };
    };

    try {
      await expect.element(page.getByTestId(`thread-row-${THREAD_ID}`)).toBeInTheDocument();
      const doneAt = new Date().toISOString();
      for (const threadId of todayThreadIds) {
        markThreadDoneInTest(
          scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId)),
          doneAt,
        );
      }

      // Closed: one line at the column's foot that says what wrapped today.
      await vi.waitFor(
        () => {
          const toggle = document.querySelector('[data-testid="inbox-done-toggle"]');
          expect(toggle?.textContent).toContain("Wrapped (12)");
          expect(toggle?.getAttribute("aria-expanded")).toBe("false");
          expect(document.querySelector('[data-testid="inbox-done-today"]')?.textContent).toBe(
            "· 3 today",
          );
          expect(document.querySelectorAll('[data-testid^="done-row-"]').length).toBe(0);
          const { shelf, column } = shelfAndColumn();
          expect(Math.abs(shelf.bottom - column.bottom)).toBeLessThanOrEqual(1);
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByTestId("inbox-done-toggle").click();

      // Open: rows under their days, and the shelf takes half the column
      // while the live list has more than the other half to show.
      await vi.waitFor(
        () => {
          expect(
            [...document.querySelectorAll('[data-testid="inbox-done-day"]')].map(
              (label) => label.textContent,
            ),
          ).toEqual(["Today", "Last 7 days"]);
          expect(document.querySelector('[data-testid="inbox-done-today"]')).toBeNull();
          const { shelf, column } = shelfAndColumn();
          expect(Math.abs(shelf.height - column.height / 2)).toBeLessThanOrEqual(1);
          expect(Math.abs(shelf.bottom - column.bottom)).toBeLessThanOrEqual(1);
          expect(useUiStateStore.getState().inboxWrappedOpen).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      // What the shelf can't fit scrolls inside it.
      const shelfViewport = document.querySelector<HTMLElement>(
        '[data-testid="inbox-wrapped-shelf"] [data-slot="scroll-area-viewport"]',
      )!;
      expect(shelfViewport.scrollHeight).toBeGreaterThan(shelfViewport.clientHeight);
      shelfViewport.scrollTop = shelfViewport.scrollHeight;
      expect(shelfViewport.scrollTop).toBeGreaterThan(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the thread you are reading on the shelf while Wrapped is closed", async () => {
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

      const expectShown = async (other: boolean) => {
        await vi.waitFor(
          () => {
            // A closed shelf must not hide the thread open in the chat.
            expect(document.querySelector(`[data-testid="done-row-${THREAD_ID}"]`)).not.toBeNull();
            expect(
              document.querySelector(`[data-testid="done-row-${otherDoneThreadId}"]`) !== null,
            ).toBe(other);
          },
          { timeout: 8_000, interval: 16 },
        );
      };

      await expectShown(false);
      await page.getByTestId("inbox-done-toggle").click();
      await expectShown(true);
      await page.getByTestId("inbox-done-toggle").click();
      await expectShown(false);
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
