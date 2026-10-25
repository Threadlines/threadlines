import {
  EventId,
  GENERAL_CHATS_PROJECT_ID,
  ORCHESTRATION_WS_METHODS,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ScheduledTaskId,
  type ThreadId,
  WS_METHODS,
} from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { isMacPlatform } from "../lib/utils";
import { useOptimisticThreadMessagesStore } from "../optimisticThreadMessages";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";

import {
  THREAD_ID,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_REF,
  PROJECT_LOGICAL_KEY,
  NOW_ISO,
  BASE_TIME_MS,
  rpcHarness,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  PHONE_VIEWPORT,
  touchSwipe,
  createUserMessage,
  createAssistantMessage,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  serverThreadPath,
  setSidebarThreadWork,
  PULL_REQUEST_NUMBER,
  PULL_REQUEST_REPOSITORY,
  PULL_REQUEST_HEAD_BRANCH,
  PULL_REQUEST_URL,
  withPullRequestFixture,
  resolvePullRequestRpc,
  toShellSnapshot,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  pressComposerKey,
  waitForComposerText,
  findButtonByText,
  findButtonContainingText,
  waitForServerConfigToApply,
  mountChatView,
  registerChatViewSuiteHooks,
  setSuppressInitialShellSnapshot,
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

const SIDEBAR_TOGGLE_KEYBINDING = {
  command: "sidebar.toggle",
  shortcut: {
    key: "b",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  },
  whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
} as const;

describe("ChatView (full app): app shell", () => {
  registerChatViewSuiteHooks();

  it("keeps an optimistic follow-up after acknowledged history despite an earlier timestamp", async () => {
    const initial = createSnapshotForTargetUser({
      targetMessageId: MessageId.make("original"),
      targetText: "Original request",
    });
    const snapshot = {
      ...initial,
      threads: initial.threads.map((thread) => ({
        ...thread,
        messages: [
          {
            ...createUserMessage({
              id: MessageId.make("original"),
              text: "Original request",
              offsetSeconds: 0,
            }),
            eventSequence: 10,
          },
          {
            ...createAssistantMessage({
              id: MessageId.make("answer"),
              text: "Original answer",
              offsetSeconds: 1,
            }),
            eventSequence: 11,
          },
        ],
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useOptimisticThreadMessagesStore.getState().addMessage(THREAD_REF, {
        id: MessageId.make("pending-clock-follow-up"),
        role: "user",
        text: "Follow-up while clock is behind",
        createdAt: new Date(BASE_TIME_MS - 60_000).toISOString(),
        streaming: false,
      });
      await expect
        .element(page.getByText("Follow-up while clock is behind", { exact: true }))
        .toBeVisible();
      const answer = page.getByText("Original answer", { exact: true }).element();
      const followUp = page.getByText("Follow-up while clock is behind", { exact: true }).element();
      expect(
        answer.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "event",
        event: {
          sequence: 12,
          eventId: EventId.make("clock-follow-up-accepted"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: NOW_ISO,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: THREAD_ID,
            messageId: MessageId.make("pending-clock-follow-up"),
            role: "user",
            text: "Acknowledged follow-up",
            turnId: null,
            streaming: false,
            createdAt: new Date(BASE_TIME_MS - 60_000).toISOString(),
            updatedAt: NOW_ISO,
          },
        } satisfies OrchestrationEvent,
      });
      await expect.element(page.getByText("Acknowledged follow-up", { exact: true })).toBeVisible();
      const acknowledged = page.getByText("Acknowledged follow-up", { exact: true }).element();
      expect(
        answer.compareDocumentPosition(acknowledged) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await expect
        .element(page.getByText("Follow-up while clock is behind", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows neutral sidebar row shapes until the first workspace snapshot arrives", async () => {
    setSuppressInitialShellSnapshot(true);
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-sidebar-loading" as MessageId,
      targetText: "sidebar loading skeleton",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      initialPath: "/",
      waitForBootstrap: false,
    });

    try {
      const loadingState = page.getByRole("status", { name: "Loading projects and threads" });
      await expect.element(loadingState).toBeVisible();

      const loadingElement = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-loading-skeleton"]',
      );
      expect(loadingElement).not.toBeNull();
      expect(loadingElement?.querySelector("button, a, [role='button']")).toBeNull();
      expect(loadingElement?.textContent?.trim()).toBe("");
      expect(
        loadingElement?.querySelector('[data-testid="sidebar-loading-live-rows"]')?.children.length,
      ).toBeGreaterThan(0);
      expect(
        loadingElement?.querySelector('[data-testid="sidebar-loading-wrapped-rows"]')?.children
          .length,
      ).toBeGreaterThan(0);

      setSuppressInitialShellSnapshot(false);
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
        kind: "snapshot",
        snapshot: toShellSnapshot(snapshot),
      });

      await expect.element(loadingState).not.toBeInTheDocument();
      await expect.element(page.getByTestId("inbox-thread-list")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens setup from a thread without the error screen showing in between", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-open-setup" as MessageId,
        targetText: "open setup",
      }),
    });

    try {
      // The error screen lasted a frame at most, so look for it ever being
      // added to the page rather than for it being there at some later moment.
      let errorScreenShown = false;
      const noteErrorScreen = (records: MutationRecord[]) => {
        errorScreenShown ||= records.some((record) =>
          Array.from(record.addedNodes).some((node) =>
            node.textContent?.includes("Something went wrong."),
          ),
        );
      };
      const observer = new MutationObserver(noteErrorScreen);
      observer.observe(document.body, { childList: true, subtree: true });

      await mounted.router.navigate({ to: "/setup" });
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("h1")).find(
            (heading) => heading.textContent === "Which agents do you use?",
          ) ?? null,
        "Unable to find the setup screen.",
      );
      noteErrorScreen(observer.takeRecords());
      observer.disconnect();

      expect(errorScreenShown).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the sidebar around the not-found page for an unknown address under setup", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-setup-not-found" as MessageId,
        targetText: "setup not found",
      }),
      initialPath: "/setup/unknown/address",
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("p")).find(
            (paragraph) => paragraph.textContent === "Not Found",
          ) ?? null,
        "Unable to find the not-found page.",
      );
      expect(document.querySelector('[data-slot="sidebar-wrapper"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("goes to Usage from the rail, sliding the selection there, and Threads brings back the thread it left", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rail-usage" as MessageId,
        targetText: "rail usage",
      }),
    });

    try {
      // The rail's one selection fill slides to whichever button is chosen.
      const selectionSitsOn = (testId: string) =>
        expect
          .poll(() => {
            const fill = document
              .querySelector('[data-testid="rail-selection"]')
              ?.getBoundingClientRect();
            const target = document
              .querySelector(`[data-testid="${testId}"]`)
              ?.getBoundingClientRect();
            return fill && target ? Math.round(Math.abs(fill.top - target.top)) : null;
          })
          .toBe(0);
      const initialPathname = mounted.router.state.location.pathname;
      await expect
        .element(page.getByTestId("rail-threads"))
        .toHaveAttribute("aria-current", "page");
      await selectionSitsOn("rail-threads");
      await page.getByTestId("rail-usage").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/usage",
        "Expected the Usage route.",
      );
      await expect.element(page.getByTestId("rail-usage")).toHaveAttribute("aria-current", "page");
      await selectionSitsOn("rail-usage");

      await page.getByTestId("rail-threads").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === initialPathname,
        "Threads should return to the thread that was open.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("brings Threads back to the last thread in a project, never to a general chat opened since", async () => {
    const chatId = "thread-general-chat-visited" as ThreadId;
    const base = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-visited-chat" as MessageId,
        targetText: "visited chat",
      }),
      chatId,
    );
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
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
          thread.id === chatId
            ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Test hello" }
            : thread,
        ),
      },
    });

    try {
      const projectThreadPath = mounted.router.state.location.pathname;
      // While the page changes, the address is the chat's a moment before
      // the open thread is: that moment must not count as a Threads view.
      await mounted.router.navigate({ href: `/${LOCAL_ENVIRONMENT_ID}/${chatId}` });
      await expect.element(page.getByTestId("rail-chats")).toHaveAttribute("aria-current", "page");

      await page.getByTestId("rail-usage").click();
      await waitForURL(mounted.router, (pathname) => pathname === "/usage", "Usage should open.");
      await page.getByTestId("rail-threads").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === projectThreadPath,
        "Threads should return to the last thread in a project, not the chat.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the thread list inside the panel, moving no button, and keeps what needs you on the rail", async () => {
    const askingThreadId = "thread-rail-asking" as ThreadId;
    const workingThreadId = "thread-rail-working" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-rail-hide" as MessageId,
            targetText: "rail hide",
          }),
          askingThreadId,
        ),
        workingThreadId,
      ),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [SIDEBAR_TOGGLE_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, askingThreadId, "needs-you");
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, workingThreadId, "working");
      const threadsButton = page.getByTestId("rail-threads");
      await expect
        .element(threadsButton.getByTestId("rail-needs-you-badge"))
        .toMatchTextContent("1");
      // While the list shows, it says what is working; the rail stays quiet.
      expect(document.querySelector('[data-testid="rail-threads-working"]')).toBeNull();
      const panel = document.querySelector('[data-testid="app-panel"]')!;
      const list = document.querySelector('[data-slot="sidebar-container"]')!;
      // The list opens the work panel, just inside its hairline edge.
      expect(
        Math.abs(list.getBoundingClientRect().left - panel.getBoundingClientRect().left),
      ).toBeLessThanOrEqual(1);
      const frameButtons = ["titlebar-sidebar-toggle", "new-thread-button", "rail-threads"];
      const placeOf = (testId: string) => {
        const rect = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      };
      const placesBefore = frameButtons.map(placeOf);

      await page.getByTestId("titlebar-sidebar-toggle").click();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().sidebarListOpen).toBe(false);
        expect(
          document
            .querySelector('[data-slot="sidebar-wrapper"]')
            ?.getAttribute("data-sidebar-state"),
        ).toBe("collapsed");
      });
      await expect.element(page.getByTestId("rail-threads-working")).toMatchTextContent("1");
      // Hiding the list moves no button in the frame; only the page's edge moves.
      expect(frameButtons.map(placeOf)).toEqual(placesBefore);
      // The selection grows with the button to take in its count.
      await vi.waitFor(() => {
        const button = document
          .querySelector('[data-testid="rail-threads"]')!
          .getBoundingClientRect();
        const fill = document.querySelector('[data-testid="rail-selection"]')!;
        expect(button.height).toBeGreaterThan(34);
        expect(fill.getBoundingClientRect().height).toBe(button.height);
      });
      await vi.waitFor(() => {
        const thread = document.querySelector('[data-slot="sidebar-inset"]')!;
        expect(
          Math.abs(thread.getBoundingClientRect().left - panel.getBoundingClientRect().left),
        ).toBeLessThanOrEqual(1);
      });

      // Mod+B brings the list back.
      const useMetaForMod = isMacPlatform(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "b",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().sidebarListOpen).toBe(true);
        expect(document.querySelector('[data-testid="rail-threads-working"]')).toBeNull();
      });

      // Another page's list says nothing of the threads, so the rail does.
      await mounted.router.navigate({ to: "/chats" });
      await expect.element(page.getByTestId("chats-view-new-chat")).toBeVisible();
      expect(useUiStateStore.getState().sidebarListOpen).toBe(true);
      await expect.element(page.getByTestId("rail-threads-working")).toMatchTextContent("1");

      // Usage has no list: it takes the panel, and the toggle stays, disabled,
      // with the user's choice kept for the pages that have one.
      await mounted.router.navigate({ to: "/usage" });
      await vi.waitFor(() => {
        expect(
          document
            .querySelector('[data-slot="sidebar-wrapper"]')
            ?.getAttribute("data-sidebar-state"),
        ).toBe("collapsed");
      });
      await expect
        .element(page.getByTestId("titlebar-sidebar-toggle"))
        .toHaveAttribute("aria-disabled", "true");
      document.querySelector<HTMLElement>('[data-testid="titlebar-sidebar-toggle"]')!.click();
      expect(useUiStateStore.getState().sidebarListOpen).toBe(true);
      await mounted.router.navigate({ href: serverThreadPath(THREAD_ID) });
      await vi.waitFor(() => {
        expect(
          document
            .querySelector('[data-slot="sidebar-wrapper"]')
            ?.getAttribute("data-sidebar-state"),
        ).toBe("expanded");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides and shows the list from the rail button of the page on screen, and a double-click that opens a page leaves it showing", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rail-reclick" as MessageId,
        targetText: "rail reclick",
      }),
    });
    const listOpen = (open: boolean) =>
      vi.waitFor(() => {
        expect(useUiStateStore.getState().sidebarListOpen).toBe(open);
        expect(
          document
            .querySelector('[data-slot="sidebar-wrapper"]')
            ?.getAttribute("data-sidebar-state"),
        ).toBe(open ? "expanded" : "collapsed");
      });
    // A click as the n-th of a run of quick clicks, the way a double-click lands.
    const clickRail = (testId: string, detail: number) =>
      document
        .querySelector(`[data-testid="${testId}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));

    try {
      await expect
        .element(page.getByTestId("rail-threads"))
        .toHaveAttribute("aria-expanded", "true");
      await page.getByTestId("rail-threads").click();
      await listOpen(false);
      await expect
        .element(page.getByTestId("rail-threads"))
        .toHaveAttribute("aria-expanded", "false");
      await page.getByTestId("rail-threads").click();
      await listOpen(true);

      clickRail("rail-chats", 1);
      await waitForURL(mounted.router, (pathname) => pathname === "/chats", "Chats should open.");
      await expect.element(page.getByTestId("rail-chats")).toHaveAttribute("aria-current", "page");
      clickRail("rail-chats", 2);
      expect(useUiStateStore.getState().sidebarListOpen).toBe(true);

      // A click of its own, on the page now open, hides the list.
      clickRail("rail-chats", 1);
      await listOpen(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("counts the pull requests waiting on the user on the rail", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rail-pull-requests" as MessageId,
        targetText: "rail pull requests",
      }),
      configureFixture: withPullRequestFixture,
      resolveRpc: (body) => {
        const response = resolvePullRequestRpc(body);
        if (body._tag !== WS_METHODS.pullRequestsList || response === undefined) return response;
        const listing = response as { readonly entries: ReadonlyArray<object> };
        return {
          ...listing,
          entries: listing.entries.flatMap((entry) => [
            // A review asked of the user waits on them; their own quiet pull request does not.
            {
              ...entry,
              number: PULL_REQUEST_NUMBER + 1,
              headBranch: "feature/review-me",
              author: { login: "teammate", isBot: false, avatarUrl: null },
              viewerIsAuthor: false,
              viewerReviewRequested: true,
            },
            entry,
          ]),
        };
      },
    });

    try {
      await expect
        .element(page.getByTestId("rail-pull-requests").getByTestId("rail-needs-you-badge"))
        .toMatchTextContent("1");
      await expect
        .element(page.getByTestId("rail-pull-requests"))
        .toHaveAccessibleName(/1 needs you/);
    } finally {
      await mounted.cleanup();
    }
  });

  it("goes back and forward through the app's pages from the title row and the shortcuts", async () => {
    const historyKeybinding = (command: "navigate.back" | "navigate.forward", key: string) =>
      ({
        command,
        shortcut: {
          key,
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
      }) as const;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-app-history" as MessageId,
        targetText: "app history",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            historyKeybinding("navigate.back", "["),
            historyKeybinding("navigate.forward", "]"),
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const back = page.getByTestId("titlebar-back");
      const forward = page.getByTestId("titlebar-forward");
      // The page the window opened on has nowhere to go back or forward to.
      await expect.element(back).toHaveAttribute("aria-disabled", "true");
      await expect.element(forward).toHaveAttribute("aria-disabled", "true");

      await page.getByTestId("rail-usage").click();
      await waitForURL(mounted.router, (pathname) => pathname === "/usage", "Usage should open.");
      await expect.element(back).not.toHaveAttribute("aria-disabled");
      await back.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === serverThreadPath(THREAD_ID),
        "Back should return to the thread.",
      );
      await expect.element(forward).not.toHaveAttribute("aria-disabled");

      // Mod+] goes forward again, and then there is nothing ahead.
      const useMetaForMod = isMacPlatform(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "]",
          code: "BracketRight",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/usage",
        "Forward should return to Usage.",
      );
      await expect.element(forward).toHaveAttribute("aria-disabled", "true");
    } finally {
      await mounted.cleanup();
    }
  });

  it("puts the thread's header in the title row over the content column, moving with the list", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-titlebar-slot" as MessageId,
        targetText: "titlebar slot",
      }),
    });

    try {
      const titleRow = document.querySelector<HTMLElement>('[data-testid="app-titlebar"]')!;
      const slot = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="titlebar-slot"]'),
        "Unable to find the title row's page slot.",
      );
      const cluster = document.querySelector('[data-testid="app-wordmark"]')!.parentElement!
        .parentElement!;
      const thread = () => document.querySelector('[data-slot="sidebar-inset"]')!;
      // The whole header went up: its title and its panel toggles are in the
      // row, and no header row is left in the panel.
      await expect
        .element(page.getByTestId("titlebar-slot").getByRole("button", { name: "Toggle panel" }))
        .toBeVisible();
      expect(titleRow.querySelector("h2")?.textContent).toBe("Browser test thread");
      expect(document.querySelector('header[data-find-region="chat"]')).toBeNull();
      // The app's name leads the row and the frame's buttons stand between
      // it and the header, so it never reads as the first step of the
      // header's project / title path.
      const right = (testId: string) =>
        document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect().right;
      expect(right("app-wordmark")).toBeLessThan(right("titlebar-sidebar-toggle"));
      expect(right("titlebar-forward")).toBeLessThan(slot.getBoundingClientRect().left);
      // Its controls are buttons in a window drag region, never dragging it.
      const panelToggle = slot.querySelector<HTMLElement>('button[aria-label="Toggle panel"]')!;
      expect(getComputedStyle(slot).getPropertyValue("-webkit-app-region")).toBe("drag");
      expect(getComputedStyle(panelToggle).getPropertyValue("-webkit-app-region")).toBe("no-drag");

      // List open: the slot starts where the thread's own content would,
      // past the list and a header's 20px padding.
      await vi.waitFor(() => {
        expect(
          Math.abs(
            slot.getBoundingClientRect().left - (thread().getBoundingClientRect().left + 20),
          ),
        ).toBeLessThanOrEqual(1);
      });

      // Mid-slide the slot keeps pace with the content column: the clamp
      // applies to every frame of the list's slide, not just its two ends.
      useUiStateStore.getState().setSidebarListOpen(false);
      const slide = await vi.waitFor(() => {
        expect(titleRow.getAnimations()).not.toHaveLength(0);
        return document.getAnimations().filter((animation) => animation instanceof CSSTransition);
      });
      for (const animation of slide) {
        animation.pause();
        animation.currentTime = 15;
      }
      expect(
        Math.abs(slot.getBoundingClientRect().left - (thread().getBoundingClientRect().left + 20)),
      ).toBeLessThanOrEqual(1);
      for (const animation of slide) animation.finish();

      // List hidden: the content column starts under the title row's own
      // buttons, so the slot starts just past them instead.
      await vi.waitFor(() => {
        expect(
          Math.abs(
            slot.getBoundingClientRect().left - (cluster.getBoundingClientRect().right + 12),
          ),
        ).toBeLessThanOrEqual(1);
      });
      expect(thread().getBoundingClientRect().left + 20).toBeLessThan(
        cluster.getBoundingClientRect().right + 12,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the title row's page controls clear of the Windows window controls", async () => {
    const root = document.documentElement;
    root.classList.add("electron", "wco");
    // What env(titlebar-area-*) reports with 138px of window controls.
    root.style.setProperty("--workspace-controls-right", "150px");
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-titlebar-wco" as MessageId,
        targetText: "titlebar wco",
      }),
    });

    try {
      const controlsStart = window.innerWidth - 150;
      const slotControlsEnd = () =>
        Math.max(
          ...Array.from(
            document.querySelectorAll('[data-testid="titlebar-slot"] button'),
            (button) => button.getBoundingClientRect().right,
          ),
        );
      await expect
        .element(page.getByTestId("titlebar-slot").getByRole("button", { name: "Toggle panel" }))
        .toBeVisible();
      expect(
        document.querySelector('[data-testid="titlebar-slot"]')!.getBoundingClientRect().right,
      ).toBeLessThanOrEqual(controlsStart + 0.5);
      expect(slotControlsEnd()).toBeLessThanOrEqual(controlsStart);

      // A list dragged wide before the window narrowed leaves the header
      // less room than it needs: what doesn't fit is cut at the slot's end,
      // never drawn under the controls.
      const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
      const slot = document.querySelector<HTMLElement>('[data-testid="titlebar-slot"]')!;
      const listWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${window.innerWidth - 300}px`);
      await vi.waitFor(() => {
        expect(slotControlsEnd()).toBeGreaterThan(slot.getBoundingClientRect().right);
      });
      expect(slot.getBoundingClientRect().right).toBeLessThanOrEqual(controlsStart + 0.5);
      expect(getComputedStyle(slot).overflowX).toBe("clip");
      wrapper.style.setProperty("--sidebar-width", listWidth);
      await vi.waitFor(() => {
        expect(slotControlsEnd()).toBeLessThanOrEqual(controlsStart);
      });

      // A full page's controls go up there too, as clear of them.
      await mounted.router.navigate({ to: "/settings/general" });
      await expect
        .element(
          page.getByTestId("titlebar-slot").getByRole("button", { name: /Restore defaults/ }),
        )
        .toBeInTheDocument();
      expect(slotControlsEnd()).toBeLessThanOrEqual(controlsStart);
    } finally {
      await mounted.cleanup();
      root.style.removeProperty("--workspace-controls-right");
      root.classList.remove("electron", "wco");
    }
  });

  it("keeps the thread's own header in a window too narrow for the title row", async () => {
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, name: "narrow", width: 720 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-titlebar-narrow" as MessageId,
        targetText: "titlebar narrow",
      }),
    });

    try {
      const header = await waitForElement(
        () => document.querySelector<HTMLElement>('header[data-find-region="chat"]'),
        "The thread should keep its own header without a title row.",
      );
      expect(document.querySelector('[data-testid="app-titlebar"]')).toBeNull();
      expect(header.querySelector('[data-sidebar="trigger"]')).not.toBeNull();
      expect(header.querySelector("h2")?.textContent).toBe("Browser test thread");
    } finally {
      await mounted.cleanup();
    }
  });

  it("puts the title row's buttons past the macOS window controls, and the rail under them", async () => {
    const root = document.documentElement;
    root.classList.add("electron", "mac");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rail-mac" as MessageId,
        targetText: "rail mac",
      }),
    });

    try {
      const toggle = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="titlebar-sidebar-toggle"]'),
        "Unable to find the title row's sidebar toggle.",
      );
      const titleRow = document
        .querySelector('[data-testid="app-titlebar"]')!
        .getBoundingClientRect();
      // The traffic lights sit at x 16-68, centered in the 38px title row:
      // the row's buttons start past them, in the same row.
      expect(titleRow.top).toBe(0);
      expect(titleRow.height).toBe(38);
      expect(toggle.getBoundingClientRect().left).toBeGreaterThanOrEqual(76);
      expect(toggle.getBoundingClientRect().bottom).toBeLessThanOrEqual(titleRow.bottom);
      // The rail and the work panel start under the row.
      const newThread = document.querySelector('[data-testid="new-thread-button"]')!;
      expect(newThread.getBoundingClientRect().top).toBeGreaterThanOrEqual(titleRow.bottom);
      expect(document.querySelector('[data-testid="app-panel"]')!.getBoundingClientRect().top).toBe(
        titleRow.bottom,
      );
    } finally {
      await mounted.cleanup();
      root.classList.remove("electron", "mac");
    }
  });

  it("lists All tasks first on the Scheduled page, selected on its overview", async () => {
    const taskId = "task-all-tasks-row" as ScheduledTaskId;
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-scheduled" as MessageId,
        targetText: "scheduled",
      }),
      initialPath: "/scheduled",
      configureFixture: (nextFixture) => {
        const capabilities = { repositoryIdentity: true, scheduledTasks: true } as const;
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: { ...nextFixture.serverConfig.environment, capabilities },
        };
        nextFixture.welcome = {
          ...nextFixture.welcome,
          environment: { ...nextFixture.welcome.environment, capabilities },
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await vi.waitFor(
        () =>
          expect(
            wsRequests.some((request) => request._tag === WS_METHODS.scheduledTasksSubscribe),
          ).toBe(true),
        { timeout: 8_000, interval: 16 },
      );
      rpcHarness.emitStreamValue(WS_METHODS.scheduledTasksSubscribe, {
        tasks: [
          {
            id: taskId,
            name: "Morning review",
            prompt: "Review yesterday's commits.",
            projectId: PROJECT_ID,
            checkout: "local",
            modelSelection: { instanceId: "codex", model: "gpt-5" },
            runtimeMode: "auto",
            interactionMode: "default",
            cadence: { kind: "daily", time: { hour: 9, minute: 0 } },
            timeZone: "UTC",
            target: { kind: "new_thread" },
            status: "error",
            error: "Its agent left the thread. Pick another agent or remove the task.",
            nextRunAt: null,
            lastRun: null,
            workingRuns: 0,
            originThreadId: null,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        requests: [],
        timeZone: "UTC",
      });

      const allTasks = page.getByTestId("scheduled-list-all");
      await expect.element(allTasks).toMatchTextContent("All tasks");
      await expect.element(allTasks).toHaveAttribute("aria-pressed", "true");
      // The stopped task needs the user, counted on the row.
      await expect.element(allTasks).toMatchTextContent("1 needs you");

      // Inside a task, the row is the way back to the overview.
      await page.getByTestId(`scheduled-list-task-${taskId}`).click();
      await vi.waitFor(
        () => expect(mounted.router.state.location.search).toMatchObject({ task: taskId }),
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(allTasks).toHaveAttribute("aria-pressed", "false");
      await allTasks.click();
      await vi.waitFor(
        () => expect(mounted.router.state.location.search).not.toHaveProperty("task"),
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe("/scheduled");
      await expect.element(allTasks).toHaveAttribute("aria-pressed", "true");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders locked single-environment mobile run context as a static workspace label", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-locked-workspace" as MessageId,
        targetText: "locked mobile workspace",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("span")).find(
            (element) => element.textContent?.trim() === "Local checkout",
          ) ?? null,
        "Unable to find static mobile workspace label.",
      );

      expect(findButtonByText("Local checkout")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the full composer editor mounted on phone viewports", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-composer-editor" as MessageId,
        targetText: "phone composer editor",
      }),
    });

    try {
      const composerSurface = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-composer-mobile-collapsed]"),
        "Unable to find composer surface.",
      );
      const composerEditor = await waitForComposerEditor();

      expect(composerSurface.getAttribute("data-chat-composer-mobile-collapsed")).toBe("false");
      expect(findButtonContainingText("Ask anything...")).toBeNull();

      composerEditor.click();
      await waitForLayout();
      expect(
        document.activeElement === composerEditor || composerEditor.matches(":focus-within"),
      ).toBe(true);

      await pressComposerKey("m");
      await waitForComposerText("m");
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts the thread's agent once while a message is typed", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-warm-up" as MessageId,
        targetText: "warm up",
      }),
    });
    const warmUps = () =>
      wsRequests.filter((request) => request._tag === ORCHESTRATION_WS_METHODS.warmUpTurn);

    try {
      for (const key of ["h", "e", "y"]) {
        await pressComposerKey(key);
      }
      await vi.waitFor(() => expect(warmUps()).toHaveLength(1), {
        timeout: 4_000,
        interval: 50,
      });
      expect(warmUps()[0]).toMatchObject({ threadId: THREAD_ID, participantId: null });

      // Still typing the same message to the same agent: nothing new.
      await pressComposerKey("!");
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(warmUps()).toHaveLength(1);

      // The message went out; the agent may stop before the next one, which
      // gets its own warm-up.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => expect(composerEditor.textContent ?? "").toBe(""), {
        timeout: 4_000,
        interval: 16,
      });
      await waitForLayout();
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "next");
      await vi.waitFor(() => expect(warmUps()).toHaveLength(2), {
        timeout: 4_000,
        interval: 50,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows mobile thread timestamps beside the touch actions", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-thread-actions" as MessageId,
        targetText: "phone thread actions",
      }),
    });

    try {
      const sidebarTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-sidebar="trigger"]'),
        "Unable to find mobile sidebar trigger.",
      );

      sidebarTrigger.click();
      await waitForLayout();

      const threadRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find phone thread row.",
      );
      const doneButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>(`[data-testid="thread-done-${THREAD_ID}"]`),
        "Unable to find done button.",
      );
      // Archive belongs to the Done tail and pin to the context menu; a live
      // row's only inline action is done.
      expect(document.querySelector(`[data-testid="thread-archive-${THREAD_ID}"]`)).toBeNull();
      expect(document.querySelector(`[data-testid="thread-pin-${THREAD_ID}"]`)).toBeNull();
      const compactActions = doneButton.parentElement;
      const timestampWrapper = await waitForElement(
        () => threadRow.querySelector<HTMLElement>(`[data-testid="thread-meta-${THREAD_ID}"]`),
        "Unable to find thread timestamp.",
      );

      expect(compactActions).not.toBeNull();
      expect(getComputedStyle(compactActions!).opacity).toBe("1");
      expect(getComputedStyle(compactActions!).pointerEvents).toBe("auto");
      const timestampStyle = getComputedStyle(timestampWrapper);
      expect(timestampStyle.display).not.toBe("none");
      expect(timestampStyle.opacity).toBe("1");
      // The timestamp sits fully left of the always-visible touch actions:
      // both stay readable, neither covers the other.
      const timestampRect = timestampWrapper.getBoundingClientRect();
      const actionsRect = compactActions!.getBoundingClientRect();
      expect(timestampRect.right).toBeLessThanOrEqual(actionsRect.left);
    } finally {
      await mounted.cleanup();
    }
  });

  it("on a phone, a swipe on a thread row wraps it with an undo, and a swipe on the rest of the sheet closes it", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-swipes" as MessageId,
        targetText: "phone swipes",
      }),
    });
    /** A pointer drawn `dx` across an element in ten steps, then lifted. */
    const swipe = (element: Element, dx: number, pointerType = "touch") => {
      const rect = element.getBoundingClientRect();
      const x0 = rect.left + rect.width * 0.75;
      const y = rect.top + rect.height / 2;
      const at = (x: number) => ({
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId: 11,
        pointerType,
        isPrimary: true,
        button: 0,
        buttons: 1,
      });
      element.dispatchEvent(new PointerEvent("pointerdown", at(x0)));
      for (let step = 1; step <= 10; step += 1) {
        element.dispatchEvent(new PointerEvent("pointermove", at(x0 + (dx * step) / 10)));
      }
      element.dispatchEvent(new PointerEvent("pointerup", { ...at(x0 + dx), buttons: 0 }));
    };
    const sheet = () => document.querySelector('[data-slot="sidebar"][data-mobile="true"]');

    try {
      const sidebarTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-sidebar="trigger"]'),
        "Unable to find mobile sidebar trigger.",
      );
      sidebarTrigger.click();
      const threadRow = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find phone thread row.",
      );

      // The row owns its swipe: the thread is wrapped up, the sheet stays open.
      swipe(threadRow, -220);
      await vi.waitFor(
        () => {
          expect(document.querySelector(`[data-testid="done-row-${THREAD_ID}"]`)).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
      expect(sheet()).not.toBeNull();

      // Wrapping up never asks first, so it offers to take it back, inside
      // the sheet where a finger can reach it.
      await expect.element(page.getByTestId("swipe-undo-bar")).toMatchTextContent(/Wrapped up/);
      await page.getByTestId("swipe-undo-bar").getByRole("button", { name: "Undo" }).click();
      await vi.waitFor(
        () => {
          expect(document.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`)).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      // A mouse never drags the panel (a narrow desktop window shows the same
      // drawer, and a drag there selects text)...
      const destinations = page.getByTestId("sidebar-destination-row").element();
      swipe(destinations, -220, "mouse");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sheet()).not.toBeNull();
      // ...but a finger anywhere else on the sheet pushes it closed.
      touchSwipe(destinations, -220);
      await vi.waitFor(() => expect(sheet()).toBeNull(), { timeout: 4_000, interval: 16 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the list with a swipe in from the left edge in the iPhone home-screen app, and not in a browser tab", async () => {
    const sheet = () => document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
    const edge = () => document.querySelector('[data-slot="drawer-swipe-area"]');

    // In a browser tab Safari's back swipe owns the edge: no strip there.
    const inTab = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-edge-tab" as MessageId,
        targetText: "phone edge tab",
      }),
    });
    try {
      await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-sidebar="trigger"]'),
        "Unable to find mobile sidebar trigger.",
      );
      expect(edge()).toBeNull();
    } finally {
      await inTab.cleanup();
    }

    // Opened from the home screen, iOS says so on the navigator, on a touch screen.
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    const installed = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-edge-app" as MessageId,
        targetText: "phone edge app",
      }),
    });
    try {
      const strip = await waitForElement(
        () => edge() as HTMLElement | null,
        "The home-screen app has no edge strip.",
      );
      expect(sheet()).toBeNull();
      touchSwipe(strip, 240);
      await vi.waitFor(() => expect(sheet()).not.toBeNull(), { timeout: 4_000, interval: 16 });

      // The terminal's text runs to 4px from the edge: while it is open, the
      // edge is the terminal's, and the strip comes back once it closes.
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(sheet()).toBeNull(), { timeout: 4_000, interval: 16 });
      const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID);
      useTerminalStateStore.getState().setTerminalOpen(threadRef, true);
      await vi.waitFor(() => expect(edge()).toBeNull(), { timeout: 4_000, interval: 16 });
      useTerminalStateStore.getState().setTerminalOpen(threadRef, false);
      await vi.waitFor(() => expect(edge()).not.toBeNull(), { timeout: 4_000, interval: 16 });
    } finally {
      Reflect.deleteProperty(navigator, "standalone");
      Reflect.deleteProperty(navigator, "maxTouchPoints");
      await installed.cleanup();
    }
  });

  it("on a phone, lists the open page's own items in the sheet, names its icons, and closes on a pick", async () => {
    const readingChatId = "thread-phone-chat-reading" as ThreadId;
    const otherChatId = "thread-phone-chat-other" as ThreadId;
    const base = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-phone-sheet-chats" as MessageId,
          targetText: "phone sheet chats",
        }),
        readingChatId,
      ),
      otherChatId,
    );
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${readingChatId}`,
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
          thread.id === readingChatId
            ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Reading this one" }
            : thread.id === otherChatId
              ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID, title: "Draft reply" }
              : thread,
        ),
      },
    });

    try {
      const sidebarTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-sidebar="trigger"]'),
        "Unable to find mobile sidebar trigger.",
      );
      sidebarTrigger.click();

      // A finger can't hover for the tooltip: each icon says its name.
      await expect
        .element(page.getByTestId("sidebar-destination-row"))
        .toMatchTextContent(/Threads.*Chats.*Settings/);
      // The page shows a thumb's width beside the sheet: a strip to tap it shut.
      const sheet = document.querySelector<HTMLElement>(
        '[data-slot="sidebar"][data-mobile="true"]',
      );
      expect(
        window.innerWidth - (sheet?.getBoundingClientRect().width ?? 0),
      ).toBeGreaterThanOrEqual(44);
      // Reading a chat, the sheet lists the chats, not the project threads.
      await expect
        .element(page.getByTestId("chats-list-row").filter({ hasText: "Reading this one" }))
        .toHaveAttribute("aria-current", "page");
      expect(document.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`)).toBeNull();

      await page.getByTestId("chats-list-row").filter({ hasText: "Draft reply" }).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${otherChatId}`),
        "A chat in the sheet should open that chat.",
      );
      await expect.element(page.getByTestId("sidebar-destination-row")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("navigates phone settings through the full-page section index", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-settings-index" as MessageId,
        targetText: "phone settings index",
      }),
    });

    try {
      const sidebarTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-sidebar="trigger"]'),
        "Unable to find mobile sidebar trigger.",
      );
      sidebarTrigger.click();
      await waitForLayout();

      // The phone has no rail: its destinations are a row in the sheet.
      const settingsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-destination-row"] [data-testid="rail-settings"]',
          ),
        "Unable to find the sheet's Settings button.",
      );
      settingsButton.click();

      // Phone viewports keep /settings as a full-page section index instead
      // of redirecting to a section.
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/settings",
        "Expected the settings section index route.",
      );
      const generalLink = await waitForElement(
        () => document.querySelector<HTMLAnchorElement>('a[href="/settings/general"]'),
        "Unable to find the General section link.",
      );
      expect(document.querySelector('a[href="/settings/providers"]')).not.toBeNull();

      generalLink.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/settings/general",
        "Expected the General section route.",
      );

      // Section pages offer a back control that returns to the index.
      const backButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="All settings"]'),
        "Unable to find the settings back button.",
      );
      backButton.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/settings",
        "Expected to return to the settings section index.",
      );

      const closeButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]'),
        "Unable to find the settings close button.",
      );
      closeButton.click();
      await waitForURL(
        mounted.router,
        (pathname) => !pathname.startsWith("/settings"),
        "Expected closing settings to leave the settings routes.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("docks the version mismatch notice to the composer and dismisses it on mobile", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-version-banner" as MessageId,
        targetText: "mobile version banner",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: {
            ...nextFixture.serverConfig.environment,
            serverVersion: "9.9.9",
          },
        };
      },
    });

    try {
      const dock = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-notice-dock="true"]'),
        "Unable to find the composer notice dock.",
      );
      expect(dock.textContent).toContain("Client and server versions differ.");
      // Version skew is informational, so it never claims a louder colour.
      expect(
        dock
          .querySelector("[data-composer-notice-severity]")
          ?.getAttribute("data-composer-notice-severity"),
      ).toBe("info");

      const composerSurface = document.querySelector<HTMLElement>(
        "[data-chat-composer-mobile-collapsed]",
      );
      expect(composerSurface).toBeTruthy();
      // Docked means attached: the notice sits directly on the composer's top
      // edge, sharing its width.
      expect(
        Math.abs(dock.getBoundingClientRect().left - composerSurface!.getBoundingClientRect().left),
      ).toBeLessThan(2);
      expect(
        Math.abs(
          dock.getBoundingClientRect().bottom - composerSurface!.getBoundingClientRect().top,
        ),
      ).toBeLessThan(2);

      const dismissButton = dock.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss version mismatch warning"]',
      );
      expect(dismissButton).toBeTruthy();
      dismissButton!.click();

      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-composer-notice-dock="true"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("docks the thread's pull request above the notices in one frame", async () => {
    const built = createSnapshotForTargetUser({
      targetMessageId: "msg-user-pull-request-dock" as MessageId,
      targetText: "pull request dock",
    });
    // The transcript opens at its end, so the address that becomes a chip goes
    // in the last message, where it is on screen.
    const snapshot: OrchestrationReadModel = {
      ...built,
      threads: built.threads.map((thread, threadIndex) =>
        threadIndex === 0
          ? {
              ...thread,
              messages: thread.messages.map((message, index, all) =>
                index === all.length - 1
                  ? { ...message, text: `Opened ${PULL_REQUEST_URL} for review.` }
                  : message,
              ),
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: withPullRequestFixture,
      resolveRpc: resolvePullRequestRpc,
    });

    try {
      // The branch, the project and the size only exist on the detail, so
      // waiting for the branch is waiting for the shared read to reach the row.
      const row = await waitForElement(() => {
        const candidate = document.querySelector<HTMLElement>(
          '[data-composer-pull-request-row="true"]',
        );
        return candidate?.textContent?.includes(PULL_REQUEST_HEAD_BRANCH) ? candidate : null;
      }, "Unable to find the composer pull request row with its branch.");
      expect(row.textContent).toContain(`#${PULL_REQUEST_NUMBER}`);
      expect(row.textContent).toContain("+26");
      // Two checks are still running, which is what the chip's word covers and
      // its dot colours.
      expect(row.textContent).toContain("CI");

      // The state glyph is the open one the sidebar badge and the pull
      // requests page use, in the same tone.
      const stateIcon = row.querySelector("svg");
      expect(stateIcon?.getAttribute("class")).toContain("text-emerald-600");

      // One frame, not two: the notice the version skew raises sits inside the
      // same dock, under the pull request row, and the dock's bottom edge is
      // the composer's top edge.
      const dock = document.querySelector<HTMLElement>('[data-composer-notice-dock="true"]');
      expect(dock).toBeTruthy();
      expect(dock!.contains(row)).toBe(true);
      const notice = dock!.querySelector("[data-composer-notice-severity]");
      expect(notice).toBeTruthy();
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        notice!.getBoundingClientRect().top + 1,
      );

      const composerSurface = document.querySelector<HTMLElement>(
        "[data-chat-composer-mobile-collapsed]",
      );
      expect(composerSurface).toBeTruthy();
      expect(
        Math.abs(
          dock!.getBoundingClientRect().bottom - composerSurface!.getBoundingClientRect().top,
        ),
      ).toBeLessThan(2);

      // The address in the message is a chip, and the chip shares the row's
      // hover card: the trigger has to reach the anchor through the link
      // component, which is the part that silently broke once.
      const chip = await waitForElement(
        () => document.querySelector<HTMLAnchorElement>("a.chat-markdown-pull-request-chip"),
        "Unable to find the pull request chip in the transcript.",
      );
      expect(chip.textContent).toBe(`#${PULL_REQUEST_NUMBER}`);
      await page.elementLocator(chip).hover();
      const card = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pull-request-hover-card"]'),
        "Hovering the transcript chip did not open the pull request card.",
      );
      expect(card.textContent).toContain(`${PULL_REQUEST_REPOSITORY} #${PULL_REQUEST_NUMBER}`);
      // Move off so the card does not sit over the row's close control.
      await page.elementLocator(composerSurface!).hover();

      // Closing the row takes it off the composer; the notice stays docked.
      row.querySelector<HTMLButtonElement>('button[aria-label^="Hide pull request"]')!.click();
      await waitForElement(
        () =>
          document.querySelector('[data-composer-pull-request-row="true"]') === null
            ? document.querySelector<HTMLElement>('[data-composer-notice-dock="true"]')
            : null,
        "The pull request row did not leave the composer.",
      );
      expect(document.querySelector("[data-composer-notice-severity]")).toBeTruthy();
      // The thread keeps the word, so the row stays closed after a restart.
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (request as { type?: string }).type === "thread.pull-request.dismiss" &&
            (request as { number?: number }).number === PULL_REQUEST_NUMBER &&
            (request as { dismissed?: boolean }).dismissed === true,
        ),
      ).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a row the thread closed off the composer, and the Pull request tab brings it back", async () => {
    const built = createSnapshotForTargetUser({
      targetMessageId: "msg-user-pull-request-closed-row" as MessageId,
      targetText: "pull request closed row",
    });
    // As a restarted app finds it: the row was closed in an earlier session.
    const snapshot: OrchestrationReadModel = {
      ...built,
      threads: built.threads.map((thread, threadIndex) =>
        threadIndex === 0 ? { ...thread, dismissedPullRequests: [PULL_REQUEST_NUMBER] } : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?pullRequest=1`,
      configureFixture: withPullRequestFixture,
      resolveRpc: resolvePullRequestRpc,
    });

    try {
      const showButton = page.getByRole("button", { name: "Show above message box" });
      await expect.element(showButton).toBeVisible();
      expect(document.querySelector('[data-composer-pull-request-row="true"]')).toBeNull();

      await showButton.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-pull-request-row="true"]'),
        "The pull request row did not come back above the composer.",
      );
      await expect.element(showButton).not.toBeInTheDocument();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (request as { type?: string }).type === "thread.pull-request.dismiss" &&
            (request as { number?: number }).number === PULL_REQUEST_NUMBER &&
            (request as { dismissed?: boolean }).dismissed === false,
        ),
      ).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the Pull request tab on the pull request its link names", async () => {
    const linkedNumber = 294;
    const linkedUrl = `https://github.com/${PULL_REQUEST_REPOSITORY}/pull/${linkedNumber}`;
    const built = createSnapshotForTargetUser({
      targetMessageId: "msg-user-pull-request-tab" as MessageId,
      targetText: "pull request tab",
    });
    // Besides its own #234, the thread's agent opened #294 from another branch.
    const snapshot: OrchestrationReadModel = {
      ...built,
      threads: built.threads.map((thread, threadIndex) =>
        threadIndex === 0
          ? {
              ...thread,
              linkedPullRequests: [
                { number: linkedNumber, url: linkedUrl, autoFix: false, autoMerge: null },
              ],
              participants: [],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      // What the sidebar's tag links to when #294 is the one it shows.
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?pullRequest=1&pullRequestNumber=${linkedNumber}`,
      configureFixture: withPullRequestFixture,
      resolveRpc: (body) => {
        const response = resolvePullRequestRpc(body);
        return body._tag === WS_METHODS.pullRequestsDetail &&
          (body as { number?: number }).number === linkedNumber
          ? { ...(response as object), number: linkedNumber, url: linkedUrl }
          : response;
      },
    });

    try {
      const tabs = () => [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Pull requests in this thread"] [role="tab"]',
        ),
      ];
      const selectedTab = (number: number) =>
        tabs().find(
          (tab) => tab.textContent === `#${number}` && tab.getAttribute("aria-selected") === "true",
        ) ?? null;
      // The thread's own pull request would lead, but the link named #294.
      await waitForElement(
        () => selectedTab(linkedNumber),
        "The Pull request tab did not open on the pull request its link named.",
      );

      // Picking the other one carries the choice in the link too.
      tabs()
        .find((tab) => tab.textContent === `#${PULL_REQUEST_NUMBER}`)!
        .click();
      await waitForElement(
        () => selectedTab(PULL_REQUEST_NUMBER),
        "Picking the thread's own pull request did not switch the tab.",
      );
      expect(mounted.router.state.location.search).toMatchObject({
        pullRequest: "1",
        pullRequestNumber: PULL_REQUEST_NUMBER,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers fixing on every pull request row, each switch set on its own pull request", async () => {
    const linkedNumber = 294;
    const linkedUrl = `https://github.com/${PULL_REQUEST_REPOSITORY}/pull/${linkedNumber}`;
    const built = createSnapshotForTargetUser({
      targetMessageId: "msg-user-pull-request-fix-switches" as MessageId,
      targetText: "pull request fix switches",
    });
    // Besides its own #234, the thread's agent opened #294 from another checkout.
    const snapshot: OrchestrationReadModel = {
      ...built,
      threads: built.threads.map((thread, threadIndex) =>
        threadIndex === 0
          ? {
              ...thread,
              linkedPullRequests: [
                { number: linkedNumber, url: linkedUrl, autoFix: false, autoMerge: null },
              ],
              participants: [],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
      configureFixture: withPullRequestFixture,
      resolveRpc: (body) => {
        const response = resolvePullRequestRpc(body);
        return body._tag === WS_METHODS.pullRequestsDetail &&
          (body as { number?: number }).number === linkedNumber
          ? {
              ...(response as object),
              number: linkedNumber,
              url: linkedUrl,
              headBranch: "fix/lint",
            }
          : response;
      },
    });

    try {
      const rowFor = (number: number) =>
        [...document.querySelectorAll<HTMLElement>('[data-composer-pull-request-row="true"]')].find(
          (row) => row.textContent?.includes(`#${number}`),
        ) ?? null;
      // The thread does not hold its own by number yet, so its switch takes it
      // on with its address.
      for (const [number, url] of [
        [linkedNumber, linkedUrl],
        [PULL_REQUEST_NUMBER, PULL_REQUEST_URL],
      ] as const) {
        const row = await waitForElement(
          () => rowFor(number),
          `The composer had no row for #${number}.`,
        );
        row.querySelector<HTMLButtonElement>('button[aria-label="Checks"]')!.click();
        const fix = page.getByRole("checkbox", { name: "Fix failing checks and review comments" });
        const sent = (autoFix: boolean) =>
          wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request as { type?: string }).type === "thread.pull-request-automation.set" &&
              (request as { pullRequestNumber?: number }).pullRequestNumber === number &&
              (request as { pullRequestUrl?: string }).pullRequestUrl === url &&
              (request as { autoFix?: boolean }).autoFix === autoFix,
          ).length;
        await fix.click();
        await vi.waitFor(() => expect(sent(true)).toBe(1));
        // Taken back before the thread has heard of the first click (it never
        // does here): the second still reaches the server.
        await fix.click();
        await vi.waitFor(() => expect(sent(false)).toBe(1));
        await userEvent.keyboard("{Escape}");
        await expect.element(fix).not.toBeInTheDocument();
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("re-expands the bootstrap project using its logical key", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [PROJECT_LOGICAL_KEY]: false,
      },
      projectOrder: [PROJECT_LOGICAL_KEY],
      seenThreadOverlays: {},
      threadSeedVisitedAtById: {},
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap-project-expand" as MessageId,
        targetText: "bootstrap project expand",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().projectExpandedById[PROJECT_LOGICAL_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
