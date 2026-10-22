import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  WS_METHODS,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { useOptimisticThreadMessagesStore } from "../optimisticThreadMessages";
import { useUiStateStore } from "../uiStateStore";

import {
  THREAD_ID,
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
  createUserMessage,
  createAssistantMessage,
  createSnapshotForTargetUser,
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
      initialPath: "/usage",
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

  it("swaps the sidebar Usage action for a history-aware Back action on Usage", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-usage-sidebar-back" as MessageId,
        targetText: "usage sidebar back",
      }),
    });

    try {
      const initialPathname = mounted.router.state.location.pathname;
      const usageButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="sidebar-usage-meter"]'),
        "Unable to find the sidebar Usage button.",
      );
      usageButton.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/usage",
        "Expected the Usage route.",
      );

      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="sidebar-footer"]'),
        "Unable to find the sidebar footer.",
      );
      const backButton = await waitForElement(
        () =>
          Array.from(footer.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Back",
          ) ?? null,
        "Unable to find the Usage Back button.",
      );
      expect(
        Array.from(footer.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Settings",
        ),
      ).toBe(true);
      expect(
        Array.from(footer.querySelectorAll("button")).some((button) =>
          button.textContent?.trim().startsWith("Usage"),
        ),
      ).toBe(false);

      backButton.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === initialPathname,
        "Expected Back to return to the route that opened Usage.",
      );
      await waitForElement(
        () =>
          Array.from(footer.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
            button.textContent?.trim().startsWith("Usage"),
          ) ?? null,
        "Expected Usage to return after leaving Usage.",
      );
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

      const settingsButton = await waitForElement(
        () => findButtonContainingText("Settings"),
        "Unable to find the sidebar settings button.",
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
              linkedPullRequests: [{ number: linkedNumber, url: linkedUrl, autoMerge: null }],
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
