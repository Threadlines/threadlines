import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  MessageId,
  type OrchestrationReadModel,
  type ThreadId,
  type TurnId,
  WS_METHODS,
} from "@threadlines/contracts";
import { MAX_THREAD_ACTIVITIES } from "@threadlines/shared/threadLimits";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { isMacPlatform } from "../lib/utils";
import { RIGHT_PANEL_RAIL_WIDTH } from "../rightPanelLayout";
import { useTerminalStateStore } from "../terminalStateStore";

import {
  THREAD_ID,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_KEY,
  THREAD_REF,
  PROJECT_DRAFT_KEY,
  NOW_ISO,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  PHONE_VIEWPORT,
  createSnapshotForTargetUser,
  createDraftOnlySnapshot,
  createSnapshotWithChangedFileSummary,
  createSnapshotForRevertPreview,
  withProjectScripts,
  setDraftThreadWithoutWorktree,
  waitForLayout,
  waitForElement,
  waitForServerConfigToApply,
  mountChatView,
  openProjectMenu,
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

describe("ChatView (full app): right panel and header actions", () => {
  registerChatViewSuiteHooks();

  /** Binds the open-favorite shortcut, which the default fixture leaves unbound. */
  const OPEN_FAVORITE_EDITOR_KEYBINDING = {
    command: "editor.openFavorite",
    shortcut: {
      key: "o",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
  } as const;

  async function openDefaultEditorSubmenu() {
    await openProjectMenu();
    await page.getByRole("menuitem", { name: /^Default/ }).click();
  }

  /** Presses the open-favorite shortcut until an open request goes out: the
   *  crumb menu that owns it mounts, and picks up its keybinding, after the
   *  server config lands. */
  async function pressOpenFavoriteEditorShortcut() {
    await waitForElement(
      () => document.querySelector('button[aria-label$=", project options"]'),
      "Unable to find the project crumb menu that owns the shortcut.",
    );
    const useMetaForMod = isMacPlatform(navigator.platform);
    await vi.waitFor(
      () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "o",
            metaKey: useMetaForMod,
            ctrlKey: !useMetaForMod,
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(wsRequests.some((request) => request._tag === WS_METHODS.shellOpenInEditor)).toBe(
          true,
        );
      },
      { timeout: 8_000, interval: 50 },
    );
  }

  it("keeps source control closed by default on wide draft thread routes and opens it from the toggle", async () => {
    const draftId = DraftId.make("draft-source-control-before-start");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      const railToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );
      expect(railToggle.disabled).toBe(false);
      expect(railToggle.hasAttribute("data-pressed")).toBe(false);
      expect(document.querySelector("[data-chat-right-panel='true']")).toBeNull();

      // The header button opens the sidebar's own chrome, never a bare panel:
      // on a fresh draft nothing is open yet, so that chrome is the launcher.
      railToggle.click();

      const changesTile = await waitForElement(
        () =>
          document.querySelector(
            "[data-right-panel-launcher-row='sourceControl']",
          ) as HTMLElement | null,
        "The header button did not open the sidebar's launcher.",
      );
      expect(railToggle.hasAttribute("data-pressed")).toBe(true);
      expect(document.querySelector("[data-right-panel-strip='true']")).not.toBeNull();
      // A draft has no turn, so Agents is not one of its surfaces.
      expect(document.querySelector("[data-right-panel-launcher-row='agents']")).toBeNull();

      changesTile.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "1" });
          expect(document.querySelector("[data-right-panel-tab='sourceControl']")).not.toBeNull();
          expect(document.querySelector("[data-source-control-panel='true']")).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      railToggle.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "0" });
          expect(railToggle.hasAttribute("data-pressed")).toBe(false);
          expect(document.querySelector("[data-chat-right-panel='true']")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  /** Every open tab stays mounted so its queries and scroll state survive a tab
   *  switch, so "showing" has to mean laid out, not just mounted. */
  function visibleSourceControlPanel(): HTMLElement | null {
    const panel = document.querySelector(
      "[data-source-control-panel='true']",
    ) as HTMLElement | null;
    return panel && panel.getClientRects().length > 0 ? panel : null;
  }

  /** Opens a surface from the launcher, which is what the sidebar shows before
   *  a thread has any tab in its strip. */
  async function openRightPanelSurfaceFromLauncher(tab: string): Promise<void> {
    const tile = await waitForElement(
      () =>
        document.querySelector(`[data-right-panel-launcher-row='${tab}']`) as HTMLElement | null,
      `Unable to find the sidebar launcher's ${tab} tile.`,
    );
    tile.click();
  }

  it("builds a tab strip from the launcher and switches between its tabs", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rail-tabs" as MessageId,
        targetText: "rail tabs",
      }),
    });

    try {
      const railToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );
      railToggle.click();

      // Nothing open yet, so the sidebar opens on the launcher and offers all
      // three of a server thread's surfaces.
      await openRightPanelSurfaceFromLauncher("sourceControl");

      const changesTab = await waitForElement(
        () =>
          document.querySelector("[data-right-panel-tab='sourceControl']") as HTMLElement | null,
        "Unable to find the sidebar's Source tab.",
      );
      expect(changesTab.getAttribute("data-active")).toBe("true");
      expect(visibleSourceControlPanel()).not.toBeNull();
      expect(document.querySelector("[data-agents-panel]")).toBeNull();

      // The `+` menu adds the second tab and focuses it.
      (document.querySelector("[data-right-panel-add-tab='true']") as HTMLElement).click();
      const agentsMenuItem = await waitForElement(
        () => document.querySelector("[data-right-panel-menu-tab='agents']") as HTMLElement | null,
        "The + menu never listed Agents.",
      );
      agentsMenuItem.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ agents: "1" });
          expect(document.querySelector("[data-agents-panel='tree']")).not.toBeNull();
          // Source stays in the strip and stays mounted to keep its queries
          // warm; the Agents tab is the one on screen.
          expect(document.querySelector("[data-right-panel-tab='sourceControl']")).not.toBeNull();
          expect(visibleSourceControlPanel()).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      (
        document.querySelector("[data-right-panel-tab='sourceControl'] [role='tab']") as HTMLElement
      ).click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "1" });
          expect(visibleSourceControlPanel()).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      // Closing a background tab leaves the active one on screen.
      (
        document.querySelector("[data-right-panel-close-tab='sourceControl']") as HTMLElement
      ).click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-right-panel-tab='sourceControl']")).toBeNull();
          expect(document.querySelector("[data-agents-panel='tree']")).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      // Closing the last tab dismisses the whole sidebar.
      (document.querySelector("[data-right-panel-close-tab='agents']") as HTMLElement).click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-chat-right-panel='true']")).toBeNull();
          expect(railToggle.hasAttribute("data-pressed")).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );

      // The header button brings the sidebar back; with the strip empty it
      // opens on the launcher.
      railToggle.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-right-panel-launcher='true']")).not.toBeNull();
          expect(railToggle.hasAttribute("data-pressed")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the tab strip inside the overlay sheet on phone widths", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-rail-sheet" as MessageId,
        targetText: "rail sheet",
      }),
    });

    try {
      const railToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );
      railToggle.click();

      // The launcher and the strip live in the sheet at this width, not in an
      // inline sidebar.
      const launcher = await waitForElement(
        () => document.querySelector("[data-right-panel-launcher='true']") as HTMLElement | null,
        "The sidebar never opened on a phone width.",
      );
      expect(launcher.closest('[data-slot="sheet-popup"]')).not.toBeNull();
      expect(document.querySelector("[data-right-panel-strip='true']")).not.toBeNull();

      await openRightPanelSurfaceFromLauncher("agents");

      const agentsPanel = await waitForElement(
        () => document.querySelector("[data-agents-panel='tree']") as HTMLElement | null,
        "The agents tab never opened on a phone width.",
      );
      expect(agentsPanel.closest('[data-slot="sheet-popup"]')).not.toBeNull();
      await expect.element(page.getByText(/No agents yet\./u)).toBeVisible();

      // Closed and reopened, the sheet comes back on Agents — the same
      // closed-to-`agents=1` transition the activity chip performs, which is
      // where the sheet used to fail to appear at all.
      railToggle.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-agents-panel]")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      railToggle.click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ agents: "1" });
          const reopened = document.querySelector("[data-agents-panel='tree']");
          expect(reopened).not.toBeNull();
          expect(reopened?.closest('[data-slot="sheet-popup"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("remembers a thread's source control panel across leaving and returning", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-source-control-memory" as MessageId,
      targetText: "source control memory",
    });
    const secondThreadId = "thread-browser-test-second" as ThreadId;
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: [
        ...baseSnapshot.threads,
        { ...baseSnapshot.threads[0]!, id: secondThreadId, title: "Second thread" },
      ],
    };

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot,
    });

    try {
      const railToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );
      railToggle.click();
      await openRightPanelSurfaceFromLauncher("sourceControl");
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "1" });
          expect(document.querySelector("[data-source-control-panel='true']")).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      // Sidebar-style navigation carries no search params, which used to reset
      // the panel. The other thread still starts closed; the strip and its
      // active tab are remembered per thread.
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: secondThreadId },
      });
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(
            `/${LOCAL_ENVIRONMENT_ID}/${secondThreadId}`,
          );
          expect(document.querySelector("[data-chat-right-panel='true']")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
      });
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-right-panel-tab='sourceControl']")).not.toBeNull();
          expect(document.querySelector("[data-source-control-panel='true']")).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps source control closed by default on compact draft thread routes", async () => {
    const draftId = DraftId.make("draft-source-control-compact-before-start");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      const sourceControlToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );

      expect(sourceControlToggle.disabled).toBe(false);
      expect(sourceControlToggle.hasAttribute("data-pressed")).toBe(false);
      expect(document.querySelector("[data-chat-right-panel='true']")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-hides explicit source control on compact routes and reopens as a partial-width sheet", async () => {
    const draftId = DraftId.make("draft-source-control-compact-reopen");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}?sourceControl=1`,
    });

    try {
      const sourceControlToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "0" });
          expect(sourceControlToggle.hasAttribute("data-pressed")).toBe(false);
          expect(document.querySelector("[data-chat-right-panel='true']")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      // The auto-hide left the deep-linked tab in the strip, so reopening the
      // sidebar lands straight back on Source rather than on the launcher.
      sourceControlToggle.click();

      const sourceControlPanel = await waitForElement(
        () => document.querySelector("[data-source-control-panel='true']") as HTMLElement | null,
        "Unable to find the source control panel.",
      );
      const sheetPopup = sourceControlPanel.closest(
        '[data-slot="sheet-popup"]',
      ) as HTMLElement | null;
      expect(sheetPopup).not.toBeNull();
      await waitForLayout();

      expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "1" });
      // The rail overlays as a partial sheet on phones, so a dismissible slice
      // of the conversation remains visible beside it.
      const sheetWidth = Math.round(sheetPopup?.getBoundingClientRect().width ?? 0);
      expect(sheetWidth).toBeLessThanOrEqual(RIGHT_PANEL_RAIL_WIDTH);
      expect(sheetWidth).toBeLessThan(COMPACT_FOOTER_VIEWPORT.width);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the whole chat turn diff in the Diff tab with a way back to Source", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithChangedFileSummary(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
          return {
            diff: [
              "diff --git a/apps/web/src/components/DiffPanel.tsx b/apps/web/src/components/DiffPanel.tsx",
              "index 1111111..2222222 100644",
              "--- a/apps/web/src/components/DiffPanel.tsx",
              "+++ b/apps/web/src/components/DiffPanel.tsx",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
          };
        }
        return undefined;
      },
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Turn changes (1)",
          ) ?? null,
        "Changed-file summary should render.",
      );
      const viewTurnDiffButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "View turn diff",
          ) ?? null,
        "View turn diff button should render.",
      );
      viewTurnDiffButton.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffTurnId: "turn-chat-diff",
          });
          expect(mounted.router.state.location.search).not.toHaveProperty("diffFilePath");
          // The link opens the sidebar on its Diff tab, tab strip and all.
          expect(
            document.querySelector("[data-right-panel-tab='diff'][data-active='true']"),
          ).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      // The strip is the only navigation the embedded Diff needs: no in-panel
      // back-to-Source control, and no header bar restating the active tab --
      // the diff's own toolbar starts straight under the strip.
      const diffToolbar = await waitForElement(
        () => document.querySelector('[aria-label="Select diff source"]'),
        "The diff toolbar should render.",
      );
      expect(document.querySelector('button[aria-label="Back to changes"]')).toBeNull();
      const strip = document.querySelector("[data-right-panel-strip='true']")!;
      expect(
        diffToolbar.getBoundingClientRect().top - strip.getBoundingClientRect().bottom,
      ).toBeLessThanOrEqual(10);
    } finally {
      await mounted.cleanup();
    }
  });

  it("retargets one Diff tab and keeps the Source tab in the strip", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithChangedFileSummary(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
          return {
            diff: [
              "diff --git a/apps/web/src/components/DiffPanel.tsx b/apps/web/src/components/DiffPanel.tsx",
              "index 1111111..2222222 100644",
              "--- a/apps/web/src/components/DiffPanel.tsx",
              "+++ b/apps/web/src/components/DiffPanel.tsx",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
          };
        }
        return undefined;
      },
    });

    try {
      const railToggle = await waitForElement(
        () =>
          document.querySelector('button[aria-label="Toggle panel"]') as HTMLButtonElement | null,
        "Unable to find the rail toggle.",
      );
      railToggle.click();
      await openRightPanelSurfaceFromLauncher("sourceControl");
      await waitForElement(
        () =>
          document.querySelector("[data-right-panel-tab='sourceControl']") as HTMLElement | null,
        "Unable to find the sidebar's Source tab.",
      );

      const viewTurnDiffButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "View turn diff",
          ) ?? null,
        "View turn diff button should render.",
      );
      viewTurnDiffButton.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffTurnId: "turn-chat-diff",
          });
          expect(document.querySelectorAll("[data-right-panel-tab='diff']").length).toBe(1);
          // Source stays in the strip, so tabbing back keeps its list.
          expect(document.querySelector("[data-right-panel-tab='sourceControl']")).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      // Back to Source from its tab, then the link again: still one Diff tab.
      (
        document.querySelector("[data-right-panel-tab='sourceControl'] [role='tab']") as HTMLElement
      ).click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({ sourceControl: "1" });
          expect(visibleSourceControlPanel()).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      viewTurnDiffButton.click();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-right-panel-tab='diff']").length).toBe(1);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Tabbing between Source and Diff keeps the target the Diff tab had.
      (
        document.querySelector("[data-right-panel-tab='sourceControl'] [role='tab']") as HTMLElement
      ).click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).not.toHaveProperty("diffTurnId");
        },
        { timeout: 8_000, interval: 16 },
      );
      (document.querySelector("[data-right-panel-tab='diff'] [role='tab']") as HTMLElement).click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            diff: "1",
            diffTurnId: "turn-chat-diff",
          });
          expect(document.querySelectorAll("[data-right-panel-tab='diff']").length).toBe(1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("previews shared-checkout reverts in a styled dialog and shows conflict outcomes", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForRevertPreview(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.getRevertPlan) {
          return {
            threadId: THREAD_ID,
            turnCount: 0,
            currentTurnCount: 1,
            mode: "selective",
            revertPaths: ["TODO.md", "docs/notes.md"],
            revertFileCount: 2,
            conflicts: [{ path: "REVERT_TEST.md", reason: "interleaved" }],
            conflictCount: 1,
            unattributedPathCount: 3,
            hasProviderSession: true,
          };
        }
        return undefined;
      },
    });

    try {
      // The journaled conflict outcome renders in the timeline.
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("*")).find((element) =>
            element.textContent?.includes(
              "left 1 file with conflicting edits untouched: REVERT_TEST.md",
            ),
          ) ?? null,
        "Conflict outcome activity should render in the timeline.",
      );

      const revertButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Revert to this message"]'),
        "Revert affordance should render on the user message.",
      );
      revertButton.click();

      // The plan-driven preview renders in the styled in-app dialog.
      const dialog = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]')).find(
            (element) => element.textContent?.includes("Revert this thread back to its start?"),
          ) ?? null,
        "Revert preview dialog should open with plan-driven title.",
      );
      expect(dialog.textContent).toContain("2 files from this thread will be reverted:");
      expect(dialog.textContent).toContain("TODO.md");
      expect(dialog.textContent).toContain("docs/notes.md");
      expect(dialog.textContent).toContain("1 file with conflicting edits will be left untouched:");
      expect(dialog.textContent).toContain("REVERT_TEST.md");
      expect(dialog.textContent).toContain("interleaved with another session's edits");
      expect(dialog.textContent).toContain(
        "Changes from other threads, sessions, and manual edits are preserved.",
      );

      // The preview was requested over RPC.
      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.getRevertPlan),
      ).toBe(true);

      // Cancelling closes the dialog without dispatching a revert.
      const cancelButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Cancel",
      );
      expect(cancelButton).toBeDefined();
      cancelButton?.click();
      await vi.waitFor(
        () => {
          expect(
            Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]')).some(
              (element) => element.textContent?.includes("Revert this thread back to its start?"),
            ),
          ).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (request as { type?: string }).type === "thread.checkpoint.revert",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a new terminal tab in the thread's worktree, with that worktree's environment", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-terminal-worktree-target" as MessageId,
      targetText: "terminal follows the worktree",
    });
    const targetThread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (targetThread) {
      Object.assign(targetThread, {
        branch: "feature/branch",
        worktreePath: "/repo/worktrees/feature-branch",
      });
    }

    // Opened the way a person opens it, so its first tab is one to make.
    useTerminalStateStore.getState().setTerminalOpen(THREAD_REF, true);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          ) as
            | {
                _tag: string;
                cwd?: string;
                worktreePath?: string | null;
                attach?: boolean;
                env?: Record<string, string>;
              }
            | undefined;
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            cwd: "/repo/worktrees/feature-branch",
            worktreePath: "/repo/worktrees/feature-branch",
            env: {
              THREADLINES_PROJECT_ROOT: "/repo/project",
              THREADLINES_WORKTREE_PATH: "/repo/worktrees/feature-branch",
            },
          });
          // A tab the server doesn't list yet is made, not attached to.
          expect(openRequest?.attach).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the scroll-to-bottom affordance hidden after closing the terminal while pinned", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {
        [THREAD_KEY]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-close-scroll-target" as MessageId,
        targetText: "terminal close scroll target",
      }),
    });

    try {
      const messagesList = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-messages-list="true"]'),
        "Unable to find messages list.",
      );

      messagesList.scrollTop = messagesList.scrollHeight;
      messagesList.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForLayout();

      const terminalToggle = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Toggle terminal drawer"]'),
        "Unable to find terminal toggle.",
      );
      terminalToggle.click();
      await waitForLayout();
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      await waitForLayout();

      expect(document.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("fetches an older turn's steps as it scrolls near the screen", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-step-history" as MessageId,
      targetText: "step history target",
    });
    const thread = snapshot.threads[0]!;
    // Each reply is its own turn, and the newest turn fills the live window,
    // so every older turn arrives without its steps.
    const messages = thread.messages.map((message, index) =>
      message.role === "assistant"
        ? { ...message, turnId: `turn-${(index - 1) / 2}` as TurnId }
        : message,
    );
    const newestAt = messages.at(-1)!.createdAt;
    const windowRows = Array.from({ length: MAX_THREAD_ACTIVITIES }, (_, index) => ({
      id: EventId.make(`window-${index}`),
      tone: "info" as const,
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens: 1_000, maxTokens: 100_000 },
      turnId: "turn-21" as TurnId,
      sequence: index + 1,
      createdAt: newestAt,
    }));
    const stepText = () =>
      Array.from(document.querySelectorAll('[data-activity-group="true"]'))
        .map((group) => group.textContent ?? "")
        .join("\n");
    const requestedTurnIds = () =>
      wsRequests
        .filter((request) => request._tag === ORCHESTRATION_WS_METHODS.getTurnActivities)
        .map((request) => request.turnId);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: [{ ...thread, messages, activities: windowRows }],
      },
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.getTurnActivities) {
          return undefined;
        }
        const turnId = body.turnId as TurnId;
        const reply = messages.find((message) => message.turnId === turnId)!;
        return {
          activities: [
            {
              id: EventId.make(`command-${turnId}`),
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran command",
              payload: {
                itemType: "command_execution",
                toolCallId: `call-${turnId}`,
                title: "Ran command",
                detail: `rm -rf .scratch-${turnId}`,
              },
              turnId,
              createdAt: new Date(Date.parse(reply.createdAt) - 1_000).toISOString(),
            },
          ],
        };
      },
    });

    try {
      // At the bottom, the turns on screen fetch their steps; the first does not.
      await vi.waitFor(
        () => {
          expect(requestedTurnIds()).toContain("turn-20");
          expect(stepText()).toContain(".scratch-turn-20");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(requestedTurnIds()).not.toContain("turn-0");

      const messagesList = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-messages-list="true"]'),
        "Unable to find messages list.",
      );
      await vi.waitFor(
        () => {
          messagesList.scrollTop = 0;
          messagesList.dispatchEvent(new Event("scroll", { bubbles: true }));
          expect(requestedTurnIds()).toContain("turn-0");
          expect(stepText()).toContain(".scratch-turn-0");
        },
        { timeout: 8_000, interval: 50 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await clickProjectMenuItem("Open in VS Code Insiders");

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows Kiro in the open picker menu and opens the project cwd with it", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["kiro"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      // Keyboard path: focus the crumb, open its menu, and take the first item.
      const trigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label$=", project options"]'),
        "Unable to find the project crumb menu.",
      );
      trigger.focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("menuitem", { name: "Open in Kiro" })).toBeVisible();
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "kiro",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and opens VSCodium from the menu", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await openProjectMenu();

      await expect
        .element(page.getByRole("menuitem", { name: "Open in VS Code Insiders" }))
        .toBeVisible();
      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      await page.getByRole("menuitem", { name: "Open in VSCodium" }).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects the file manager as the sticky open target without opening it immediately", async () => {
    setDraftThreadWithoutWorktree();
    const fileManagerName = isMacPlatform(navigator.platform)
      ? "Finder"
      : navigator.platform.toLowerCase().startsWith("win")
        ? "Explorer"
        : "Files";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["cursor", "file-manager"],
          keybindings: [OPEN_FAVORITE_EDITOR_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await openDefaultEditorSubmenu();
      await page.getByRole("menuitemradio", { name: fileManagerName }).click();

      await vi.waitFor(() => {
        expect(localStorage.getItem("threadlines:last-editor")).toBe(
          JSON.stringify("file-manager"),
        );
      });
      // Picking a default only changes what the shortcut opens.
      expect(wsRequests.some((request) => request._tag === WS_METHODS.shellOpenInEditor)).toBe(
        false,
      );

      await pressOpenFavoriteEditorShortcut();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "file-manager",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("threadlines:last-editor", JSON.stringify("vscodium"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
          keybindings: [OPEN_FAVORITE_EDITOR_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      // The unavailable stored favorite falls back to the first installed
      // editor as the open-favorite shortcut's target.
      await pressOpenFavoriteEditorShortcut();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the open-favorite shortcut working on a phone, where the crumb is hidden", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
          keybindings: [OPEN_FAVORITE_EDITOR_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const trigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label$=", project options"]'),
        "Unable to find the project crumb menu.",
      );
      expect(trigger.checkVisibility()).toBe(false);

      await pressOpenFavoriteEditorShortcut();

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

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      await page.getByRole("button", { name: "Run Lint" }).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            // The thread's unused first tab before a new one.
            reuseTerminalIds: ["default"],
            cwd: "/repo/project",
            env: {
              THREADLINES_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          // Typed into the tab the server picked.
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            terminalId: "default",
            data: "bun run lint\r",
            origin: "script",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      await page.getByRole("button", { name: "Run Test" }).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              THREADLINES_PROJECT_ROOT: "/repo/project",
              THREADLINES_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the server own setup after preparing a pull request worktree thread", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitResolvePullRequest) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/pingdotgg/t3code/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
          };
        }
        if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/pingdotgg/t3code/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
            branch: "archive-settings-overhaul",
            worktreePath: "/repo/worktrees/pr-1359",
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "main",
          ) as HTMLButtonElement | null,
        "Unable to find branch selector button.",
      );
      branchButton.click();

      const branchInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );
      branchInput.focus();
      await page.getByPlaceholder("Search refs...").fill("1359");

      const checkoutItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Checkout pull request",
          ) as HTMLSpanElement | null,
        "Unable to find checkout pull request option.",
      );
      checkoutItem.click();

      const worktreeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Worktree",
          ) as HTMLButtonElement | null,
        "Unable to find Worktree button.",
      );
      worktreeButton.click();

      await vi.waitFor(
        () => {
          const prepareRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitPreparePullRequestThread,
          );
          expect(prepareRequest).toMatchObject({
            _tag: WS_METHODS.gitPreparePullRequestThread,
            cwd: "/repo/project",
            reference: "1359",
            mode: "worktree",
          });
          // The server starts the setup script under this id, so the draft the
          // user lands in has to be that same thread, on the new worktree.
          const setupThreadId = prepareRequest?.threadId;
          expect(setupThreadId).toEqual(expect.any(String));
          const drafts = Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey);
          expect(drafts.find((draft) => draft.threadId === setupThreadId)).toMatchObject({
            worktreePath: "/repo/worktrees/pr-1359",
            branch: "archive-settings-overhaul",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite && request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });
});
