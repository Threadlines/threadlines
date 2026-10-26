import {
  type ComputerLinkPendingRequest,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadMove,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
  ThreadMoveError,
  ThreadMoveId,
  type ThreadMovePreview,
  WS_METHODS,
} from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  __setComputerLinksClientForTests,
  useComputerLinksStore,
} from "../environments/links/computerLinks";
import {
  __resetThreadMovesForTests,
  __setThreadMovesClientForTests,
  readThreadMoveOffered,
} from "../environments/links/threadMoves";
import { __setProjectSetupsClientForTests } from "../environments/projectSetups/projectSetups";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import {
  THREAD_ID,
  THREAD_TITLE,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  rpcHarness,
  WIDE_FOOTER_VIEWPORT,
  isoAt,
  createSnapshotForTargetUser,
  injectRemoteEnvironmentThreads,
  FLEET_REMOTE_ENVIRONMENT_ID,
  FLEET_OFFLINE_ENVIRONMENT_ID,
  saveFleetComputers,
  setPrimaryLinksSnapshot,
  withComputerLinksFixture,
  fleetLinksSnapshot,
  fleetOutboundLink,
  fleetPendingRequest,
  fakeComputerLinksClient,
  type TestFixture,
  waitForElement,
  waitForURL,
  waitForServerConfigToApply,
  openCommandPaletteFromTrigger,
  mountChatView,
  registerChatViewSuiteHooks,
  PROJECT_SETUP_SOURCE,
  fakeProjectSetupsClient,
  projectSetupJob,
  withProjectRepository,
  withProjectSetupFixture,
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

/** This computer's server takes links and moves threads to linked computers. */
function withThreadMoveFixture(nextFixture: TestFixture): void {
  withComputerLinksFixture(nextFixture);
  const capabilities = { ...nextFixture.serverConfig.environment.capabilities, threadMove: true };
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    environment: { ...nextFixture.serverConfig.environment, capabilities },
  };
  nextFixture.welcome = {
    ...nextFixture.welcome,
    environment: { ...nextFixture.welcome.environment, capabilities },
  };
}

/** The test thread's move to Mac mini, as its computer projects it. */
function fleetThreadMove(
  overrides: Partial<OrchestrationThreadMove> = {},
): OrchestrationThreadMove {
  return {
    transferId: ThreadMoveId.make("move-browser"),
    target: { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID, label: "Mac mini" },
    agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    phase: "sending",
    sentBytes: 409,
    totalBytes: 1_000,
    cancelRequested: false,
    startedAt: NOW_ISO,
    ...overrides,
  };
}

/** The test thread with overrides on its projection (its move, its activities). */
function withTestThread(
  snapshot: OrchestrationReadModel,
  overrides: Partial<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, ...overrides } : thread,
    ),
  };
}

/** Where the test thread could go: Windows PC can't take it, Mac mini asks first. */
const FLEET_MOVE_PREVIEW: ThreadMovePreview = {
  changes: {
    branch: "fix/login",
    trackedFiles: 3,
    untrackedFiles: 1,
    unpushedCommits: 2,
    messageCount: 44,
  },
  targets: [
    {
      environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
      label: "Windows PC",
      refusal: "Windows PC has no project for this repository.",
      agents: [],
    },
    {
      environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
      label: "Mac mini",
      projectName: "threadlines",
      access: "ask",
      agents: [
        {
          instanceId: "codex",
          name: "Codex",
          billing: "ChatGPT Pro",
          driver: "codex",
          models: [
            { model: "gpt-5", name: "GPT-5" },
            { model: "gpt-5-mini", name: "GPT-5 mini" },
          ],
        },
      ],
      suggestedAgent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    },
  ],
};

/**
 * Saves Mac mini, where these moves go. Saving a computer is also what starts
 * this app's links streams here: the test server only says it takes links
 * after the app has mounted.
 */
async function saveMacMini(state: "connected" | "disconnected"): Promise<void> {
  await saveFleetComputers([
    { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID, label: "Mac mini", os: "darwin", state },
  ]);
}

/** Waits for the notice docked to the composer to say `text`. */
async function waitForComposerNotice(text: string): Promise<HTMLElement> {
  const dock = () => document.querySelector<HTMLElement>('[data-composer-notice-dock="true"]');
  return waitForElement(
    () => (dock()?.textContent?.includes(text) ? dock() : null),
    () => `The composer notice should say "${text}"; it says "${dock()?.textContent ?? ""}".`,
  );
}

/** Opens the thread row's own menu, the way a right click does. */
async function openSidebarThreadMenu(threadId: ThreadId): Promise<void> {
  const row = await waitForElement(
    () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${threadId}"]`),
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
}

describe("ChatView (full app): moving a thread to another computer", () => {
  registerChatViewSuiteHooks();

  it("offers Move to another computer only where the thread's computer can move it", async () => {
    // Linked, but to nothing yet.
    setPrimaryLinksSnapshot(fleetLinksSnapshot({}));
    const previews: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-move-gating" as MessageId,
        targetText: "move gating",
      }),
      configureFixture: withThreadMoveFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreview) {
          previews.push(body);
          return { refusal: "Finish the running turn first.", targets: [] };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("disconnected");
      await expect.element(page.getByRole("button", { name: "Toggle panel" })).toBeVisible();
      // Nowhere to move it yet: the palette doesn't offer it.
      await openCommandPaletteFromTrigger();
      expect(
        page
          .getByTestId("command-palette")
          .getByText("Move to another computer", { exact: true })
          .elements(),
      ).toHaveLength(0);
      await userEvent.keyboard("{Escape}");

      // A link to Mac mini: the thread's menu offers the move, and so does the palette.
      rpcHarness.emitStreamValue(
        WS_METHODS.linksSubscribe,
        fleetLinksSnapshot({
          outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
        }),
      );
      await vi.waitFor(() => {
        expect(readThreadMoveOffered(LOCAL_ENVIRONMENT_ID, undefined)).toBe(true);
      });
      await openSidebarThreadMenu(THREAD_ID);
      await expect
        .element(page.getByText("Move to another computer", { exact: true }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      // The command palette too, where the dialog opens from here.
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();

      // The thread can't go right now: the dialog says why, and can't move it.
      const dialog = page.getByTestId("thread-move-dialog");
      await expect
        .element(dialog.getByTestId("thread-move-refusal"))
        .toMatchTextContent("Finish the running turn first.");
      await expect.element(dialog.getByTestId("thread-move-confirm")).toBeDisabled();
      expect(previews).toEqual([expect.objectContaining({ threadId: THREAD_ID })]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows where a thread can go and what goes with it, then moves it there", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [
          fleetOutboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "Windows PC"),
          fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini"),
        ],
      }),
    );
    const starts: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-move-dialog" as MessageId,
        targetText: "move dialog",
      }),
      configureFixture: withThreadMoveFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreview) return FLEET_MOVE_PREVIEW;
        if (body._tag === WS_METHODS.movesStart) {
          starts.push(body);
          return { transferId: ThreadMoveId.make("move-started") };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await vi.waitFor(() => {
        expect(readThreadMoveOffered(LOCAL_ENVIRONMENT_ID, undefined)).toBe(true);
      });
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();
      const dialog = page.getByTestId("thread-move-dialog");
      // The first computer that can take it comes picked, with what would go.
      await expect.element(dialog.getByTestId("thread-move-target")).toMatchTextContent("Mac mini");
      const preview = dialog.getByTestId("thread-move-preview");
      await expect.element(preview).toMatchTextContent("Lands in threadlines on Mac mini");
      await expect
        .element(dialog.getByTestId("thread-move-changes"))
        .toMatchTextContent(
          "44 messages · branch fix/login · 3 changed files · 1 new file · 2 commits not pushed",
        );
      await expect
        .element(preview)
        .toMatchTextContent("Staged changes arrive as unstaged changes.");
      await expect.element(preview).toMatchTextContent("Your copy here stays, read-only.");
      await expect
        .element(dialog.getByTestId("thread-move-agent"))
        .toMatchTextContent("Codex · GPT-5");
      await expect
        .element(dialog.getByTestId("thread-move-asks-first"))
        .toMatchTextContent("Mac mini asks its user first.");

      // A computer that can't take it is listed, disabled, with why.
      const targetPicker = dialog.getByTestId("thread-move-target");
      await targetPicker.click();
      // The list's items stay in the page once it closes, so the checks below
      // only mean something while it is open.
      await expect.element(targetPicker).toHaveAttribute("aria-expanded", "true");
      const windows = page.getByTestId(`thread-move-target-${FLEET_REMOTE_ENVIRONMENT_ID}`);
      await expect
        .element(windows)
        .toMatchTextContent("Windows PC has no project for this repository.");
      await expect.element(windows).toHaveAttribute("data-disabled");
      // Escape closes the list and leaves the dialog open. Bounded: an element
      // that is gone (the dialog closed with it) is otherwise waited on until
      // the spec's own timeout, which names no step.
      await userEvent.keyboard("{Escape}");
      await expect
        .element(targetPicker, { timeout: 5_000 })
        .toHaveAttribute("aria-expanded", "false");

      // Mac mini turns the start down: the dialog says why and stays open.
      // (Stood in for here: the test server can't send a typed error.)
      const refusedStart = vi.fn(async () => {
        throw new ThreadMoveError({
          detail: "Mac mini can't find commit 1a2b3c4 on origin. Push it, then try again.",
        });
      });
      __setThreadMovesClientForTests(LOCAL_ENVIRONMENT_ID, {
        preview: async () => FLEET_MOVE_PREVIEW,
        start: refusedStart,
        cancel: async () => undefined,
      });
      await dialog.getByTestId("thread-move-confirm").click();
      await expect
        .element(dialog.getByTestId("thread-move-start-error"))
        .toMatchTextContent("Mac mini can't find commit 1a2b3c4 on origin.");
      expect(refusedStart).toHaveBeenCalledTimes(1);

      // The second goes to this computer's server, and the dialog closes.
      __resetThreadMovesForTests();
      await dialog.getByTestId("thread-move-confirm").click();
      await expect.element(page.getByTestId("thread-move-dialog")).not.toBeInTheDocument();
      expect(starts).toEqual([
        expect.objectContaining({
          threadId: THREAD_ID,
          targetEnvironmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          agent: { instanceId: "codex", model: "gpt-5" },
        }),
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sets up a computer that lacks the project from the move, then offers it", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const mac = fakeProjectSetupsClient();
    __setProjectSetupsClientForTests(FLEET_OFFLINE_ENVIRONMENT_ID, mac.client);
    const macMini = FLEET_MOVE_PREVIEW.targets[1]!;
    let macHasProject = false;
    const previews: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withProjectRepository(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-move-set-up" as MessageId,
          targetText: "move set up",
        }),
      ),
      configureFixture: (next) => {
        withThreadMoveFixture(next);
        withProjectSetupFixture(next);
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreview) {
          previews.push(body);
          return {
            targets: [
              macHasProject
                ? macMini
                : {
                    environmentId: macMini.environmentId,
                    label: "Mac mini",
                    refusal: "Mac mini doesn't have this project.",
                    refusalCode: "no_project",
                    agents: [],
                  },
            ],
          } satisfies ThreadMovePreview;
        }
        if (body._tag === WS_METHODS.projectSetupsSource) return PROJECT_SETUP_SOURCE;
        if (body._tag === WS_METHODS.projectSetupsReadFiles) return { files: [] };
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("disconnected");
      await vi.waitFor(() => {
        expect(readThreadMoveOffered(LOCAL_ENVIRONMENT_ID, undefined)).toBe(true);
      });
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();
      const dialog = page.getByTestId("thread-move-dialog");
      await expect
        .element(dialog.getByTestId("thread-move-target-refusal"))
        .toMatchTextContent("Mac mini doesn't have this project.");
      await expect.element(dialog.getByTestId("thread-move-confirm")).toBeDisabled();
      // This app can't reach Mac mini to set it up: it says to connect first.
      await expect
        .element(dialog.getByTestId("thread-move-connect-first"))
        .toHaveTextContent("Connect to Mac mini in this app first");

      // Connected now, Mac mini can be set up from here.
      useSavedEnvironmentRuntimeStore
        .getState()
        .patch(FLEET_OFFLINE_ENVIRONMENT_ID, { connectionState: "connected", route: "direct" });
      await dialog.getByTestId("thread-move-set-up").click();
      const setup = page.getByTestId("project-setup-dialog");
      await expect
        .element(setup.getByTestId("project-setup-destination"))
        .toHaveTextContent("A new folder.");
      await setup.getByTestId("project-setup-start").click();
      await expect
        .element(setup.getByTestId("project-setup-stage"))
        .toHaveTextContent("Downloading · 12%");
      const started = mac.start.mock.calls[0]![0];
      expect(started).toEqual(
        expect.objectContaining({
          source: expect.objectContaining({ environmentId: LOCAL_ENVIRONMENT_ID }),
        }),
      );

      // Done: the move asks again. That first ask fails: the dialog says so
      // and offers to check again, instead of sitting on the old answer.
      macHasProject = true;
      const preview = vi
        .fn<() => Promise<ThreadMovePreview>>()
        .mockRejectedValueOnce(new ThreadMoveError({ detail: "Mac mini didn't answer." }))
        .mockResolvedValue({ targets: [macMini] });
      __setThreadMovesClientForTests(LOCAL_ENVIRONMENT_ID, {
        preview,
        start: async () => ({ transferId: ThreadMoveId.make("move-after-setup") }),
        cancel: async () => undefined,
      });
      mac.push([
        projectSetupJob({
          setupId: started.setupId,
          stage: "done",
          projectId: ProjectId.make("project-mac-copy"),
          updatedAt: isoAt(9),
        }),
      ]);
      await expect
        .element(setup.getByTestId("project-setup-done"))
        .toMatchTextContent("Project is ready on Mac mini");
      await setup.getByTestId("project-setup-close").click();
      await expect.element(page.getByTestId("project-setup-dialog")).not.toBeInTheDocument();
      await expect
        .element(dialog.getByTestId("thread-move-refresh-failed"))
        .toMatchTextContent("Mac mini didn't answer.");
      await dialog.getByTestId("thread-move-check-again").click();
      await expect
        .element(dialog.getByTestId("thread-move-preview"))
        .toMatchTextContent("Lands in threadlines on Mac mini");
      expect(preview).toHaveBeenCalledTimes(2);
      expect(previews).toHaveLength(1);
      await expect.element(dialog.getByTestId("thread-move-confirm")).toBeEnabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("locks a moving thread and says how far it got, with Cancel, until the link is gone", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [
          fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini", { connection: "connected" }),
        ],
      }),
    );
    const cancels: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-moving" as MessageId,
          targetText: "moving thread",
        }),
        { move: fleetThreadMove() },
      ),
      configureFixture: withThreadMoveFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesCancel) {
          cancels.push(body);
          return null;
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await waitForComposerNotice("Sending to Mac mini · 40%");
      const editor = page.getByTestId("composer-editor");
      await expect.element(editor).toHaveAttribute("contenteditable", "false");
      await expect
        .element(editor)
        .toHaveAttribute("aria-placeholder", "This thread is moving to Mac mini");
      await expect
        .element(page.getByTestId(`thread-meta-${THREAD_ID}`))
        .toMatchTextContent("moving");
      // Nothing else to do with it here, and no other way off it.
      await openCommandPaletteFromTrigger();
      expect(
        page
          .getByTestId("command-palette")
          .getByText("Move to another computer", { exact: true })
          .elements(),
      ).toHaveLength(0);
      await userEvent.keyboard("{Escape}");

      await page.getByRole("button", { name: "Cancel the move" }).click();
      await vi.waitFor(() => {
        expect(cancels).toEqual([expect.objectContaining({ threadId: THREAD_ID })]);
      });
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "event",
        event: {
          sequence: 2,
          eventId: EventId.make("move-cancel-requested"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: NOW_ISO,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.move-cancel-requested",
          payload: {
            threadId: THREAD_ID,
            transferId: ThreadMoveId.make("move-browser"),
            updatedAt: NOW_ISO,
          },
        } satisfies OrchestrationEvent,
      });
      await waitForComposerNotice("Stopping the move…");
      expect(page.getByRole("button", { name: "Cancel the move" }).elements()).toHaveLength(0);

      // The link to Mac mini is gone: the move can't finish or stop, so keep
      // working here in a new thread.
      rpcHarness.emitStreamValue(WS_METHODS.linksSubscribe, fleetLinksSnapshot({}));
      await waitForComposerNotice(
        "Can't reach Mac mini. The move can't finish or stop until the two computers reconnect.",
      );
      await page.getByRole("button", { name: "Continue here as a new thread" }).click();
      await expect
        .element(page.getByRole("alertdialog", { name: "Continue in a new thread?" }))
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("says where a moved thread went, and opens it there once this app has it", async () => {
    const movedThreadId = "thread-on-mac-mini" as ThreadId;
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-moved" as MessageId,
          targetText: "moved thread",
        }),
        {
          move: fleetThreadMove({
            phase: "importing",
            movedAway: { threadId: movedThreadId, movedAt: NOW_ISO },
          }),
        },
      ),
      configureFixture: withThreadMoveFixture,
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerNotice("Moved to Mac mini. Connect to Mac mini to open it.");
      await expect
        .element(page.getByTestId("composer-editor"))
        .toHaveAttribute("aria-placeholder", "This thread moved to Mac mini");
      await expect
        .element(page.getByTestId(`thread-meta-${THREAD_ID}`))
        .toMatchTextContent("moved");

      // Mac mini connects, with the thread: Open goes there.
      await saveMacMini("connected");
      injectRemoteEnvironmentThreads(FLEET_OFFLINE_ENVIRONMENT_ID, [
        { id: movedThreadId, title: "Moved thread" },
      ]);
      await page.getByRole("button", { name: "Open it on Mac mini" }).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${FLEET_OFFLINE_ENVIRONMENT_ID}/${movedThreadId}`,
        "Open should go to the thread on the computer it moved to.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks where a thread that moved here starts being this computer's", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-moved-in" as MessageId,
      targetText: "moved in",
    });
    const thread = base.threads[0]!;
    const importedCount = thread.messages.length - 4;
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(base, {
        messages: thread.messages.map((message, index) =>
          index < importedCount ? { ...message, imported: true as const } : message,
        ),
        movedFrom: {
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          label: "Mac mini",
          threadId: "thread-on-mac-mini" as ThreadId,
          movedAt: isoAt(importedCount * 3 - 1),
        },
        activities: [
          {
            id: EventId.make("activity-moved-in"),
            tone: "info",
            kind: "thread.moved-in",
            summary: "Moved here from Mac mini",
            payload: {
              fromEnvironmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
              fromLabel: "Mac mini",
              fromThreadId: "thread-on-mac-mini",
              movedAt: isoAt(importedCount * 3 - 1),
            },
            turnId: null,
            createdAt: isoAt(importedCount * 3 - 1),
          },
        ],
      }),
    });

    try {
      const boundary = page.getByTestId("moved-in-boundary");
      await expect.element(boundary).toMatchTextContent(/^Moved here from Mac mini · /u);
      // Between the history it brought and what was said here.
      const lastImported = page.getByText(`assistant filler ${importedCount / 2 - 1}`, {
        exact: true,
      });
      const firstHere = page.getByText(`filler user message ${importedCount / 2}`, {
        exact: true,
      });
      const top = (locator: typeof boundary) => locator.element().getBoundingClientRect().top;
      expect(top(lastImported)).toBeLessThan(top(boundary));
      expect(top(boundary)).toBeLessThan(top(firstHere));
    } finally {
      await mounted.cleanup();
    }
  });

  it("reads a request to move a thread as a move, in the thread being moved", async () => {
    const windowsLinks = fakeComputerLinksClient();
    const request: ComputerLinkPendingRequest = {
      ...fleetPendingRequest(LOCAL_ENVIRONMENT_ID, "transfer-browser", THREAD_TITLE),
      kind: "move",
      fromLabel: "Local environment",
      parentThreadId: THREAD_ID,
      parentThreadTitle: THREAD_TITLE,
      prompt: "",
      projectName: "threadlines",
      move: {
        messageCount: 44,
        branch: "fix/login",
        trackedFiles: 3,
        untrackedFiles: 1,
        unpushedCommits: 2,
      },
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-move-request" as MessageId,
          targetText: "move request",
        }),
        {
          move: fleetThreadMove({
            target: { environmentId: FLEET_REMOTE_ENVIRONMENT_ID, label: "Windows PC" },
            phase: "awaiting_approval",
          }),
        },
      ),
      configureFixture: withThreadMoveFixture,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
      ]);
      __setComputerLinksClientForTests(FLEET_REMOTE_ENVIRONMENT_ID, windowsLinks.client);
      useComputerLinksStore
        .getState()
        .put(FLEET_REMOTE_ENVIRONMENT_ID, fleetLinksSnapshot({ pending: [request] }));

      await waitForComposerNotice("Waiting for Windows PC to allow the move");
      const card = page.getByTestId("remote-start-panel");
      await expect
        .element(card.getByTestId("remote-start-panel-heading"))
        .toMatchTextContent("Local environment wants to move a thread to Windows PC");
      await expect
        .element(card.getByTestId("remote-start-panel-title"))
        .toMatchTextContent(THREAD_TITLE);
      await expect
        .element(card.getByTestId("remote-start-panel-summary"))
        .toMatchTextContent(
          "44 messages · branch fix/login · 3 changed files · 1 new file · 2 commits not pushed",
        );
      await expect
        .element(card.getByTestId("remote-start-panel-where"))
        .toMatchTextContent("Lands in threadlines with up to Auto access.");
      // The inbox row reads the same way.
      await expect
        .element(page.getByTestId("link-request-where-transfer-browser"))
        .toMatchTextContent("Local environment wants to move a thread to Windows PC");

      await card.getByTestId("remote-start-panel-allow").click();
      await vi.waitFor(() => {
        expect(windowsLinks.respondRequest).toHaveBeenCalledWith({
          deviceId: request.deviceId,
          requestId: request.requestId,
          allow: true,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
