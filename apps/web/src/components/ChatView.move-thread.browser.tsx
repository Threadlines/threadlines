import {
  type ComputerLinkPendingRequest,
  EventId,
  GENERAL_CHATS_PROJECT_ID,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadMove,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
  ThreadMoveBatchId,
  ThreadMoveError,
  ThreadMoveId,
  type ThreadMovePreview,
  ThreadMoveRequestId,
  type ThreadPendingMove,
  WS_METHODS,
} from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  __setComputerLinksClientForTests,
  useComputerLinksStore,
} from "../environments/links/computerLinks";
import { useComposerDraftStore } from "../composerDraftStore";
import { updateSettings } from "../hooks/useSettings";
import {
  __resetThreadMovesForTests,
  __setThreadMovesClientForTests,
  readThreadMoveOffered,
  type ThreadMovesClient,
} from "../environments/links/threadMoves";
import { __setProjectSetupsClientForTests } from "../environments/projectSetups/projectSetups";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import {
  THREAD_ID,
  THREAD_REF,
  THREAD_TITLE,
  LOCAL_ENVIRONMENT_ID,
  PROJECT_ID,
  createUserMessage,
  NOW_ISO,
  rpcHarness,
  wsRequests,
  WIDE_FOOTER_VIEWPORT,
  isoAt,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
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
  withMoveCapabilities(nextFixture, { threadMove: true });
}

/** Like withThreadMoveFixture, on a server that also queues moves (Part 3b). */
function withThreadMoveQueueFixture(nextFixture: TestFixture): void {
  withMoveCapabilities(nextFixture, { threadMove: true, threadMoveQueue: true });
}

function withMoveCapabilities(
  nextFixture: TestFixture,
  moves: {
    readonly threadMove: true;
    readonly threadMoveQueue?: true;
    readonly threadMoveBatch?: true;
    readonly threadMoveStagedApproval?: true;
    readonly threadMoveState?: true;
  },
): void {
  withComputerLinksFixture(nextFixture);
  const capabilities = { ...nextFixture.serverConfig.environment.capabilities, ...moves };
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

/** What didn't come along with a thread that moved here, as the server says it. */
const MOVED_IN_LEFT_SENTENCE =
  "Auto-fix is off here: this computer already has a branch named `fix-login`, so pushes from this thread wouldn't reach pull request #212.";

/** The snapshot with this computer's General Chats, holding the threads `threadIds`. */
function withGeneralChats(
  snapshot: OrchestrationReadModel,
  threadIds: ReadonlyArray<ThreadId>,
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
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
    threads: snapshot.threads.map((thread) =>
      threadIds.includes(thread.id) ? { ...thread, projectId: GENERAL_CHATS_PROJECT_ID } : thread,
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

/** The calls of a waiting move (Part 3b), for a stand-in client whose test never queues. */
const QUEUE_CALLS_UNUSED: Omit<ThreadMovesClient, "preview" | "start" | "cancel"> = {
  queue: async () => {
    throw new Error("This test doesn't queue a move.");
  },
  unqueue: async () => undefined,
  retry: async () => undefined,
  previewMany: async () => {
    throw new Error("This test doesn't move several threads.");
  },
  queueMany: async () => {
    throw new Error("This test doesn't move several threads.");
  },
  setMode: async () => undefined,
  batchStatus: async () => {
    throw new Error("This test doesn't move several threads.");
  },
  respondMany: async () => {
    throw new Error("This test doesn't answer moves.");
  },
};

const QUEUED_REQUEST_ID = ThreadMoveRequestId.make("queued-browser");

/** The test thread's move to Mac mini, waiting for its turn to end. */
function fleetPendingMove(overrides: Partial<ThreadPendingMove> = {}): ThreadPendingMove {
  return {
    requestId: QUEUED_REQUEST_ID,
    target: { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID, label: "Mac mini" },
    agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    mode: "when-done",
    stage: "waiting",
    requestedAt: NOW_ISO,
    requestedBy: { kind: "user" },
    waitsFor: [{ code: "turn", words: "when this turn ends" }],
    ...overrides,
  };
}

/** One event on the open thread's detail stream, after `sequence - 1` others. */
function emitThreadEvent(
  sequence: number,
  event: Pick<OrchestrationEvent, "type" | "payload"> & { readonly eventId: string },
): void {
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
    kind: "event",
    event: {
      sequence,
      eventId: EventId.make(event.eventId),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      occurredAt: NOW_ISO,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: event.type,
      payload: event.payload,
    } as OrchestrationEvent,
  });
}

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
        expect(
          readThreadMoveOffered({ environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID }),
        ).toBe(true);
      });
      // Not for a General Chats thread: this computer doesn't move those.
      expect(
        readThreadMoveOffered({
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: GENERAL_CHATS_PROJECT_ID,
        }),
      ).toBe(false);
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
        expect(
          readThreadMoveOffered({ environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID }),
        ).toBe(true);
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
        ...QUEUE_CALLS_UNUSED,
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

  it("says what comes along, and what won't work there for the agent picked", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const macMini = FLEET_MOVE_PREVIEW.targets[1]!;
    const codexOnly = "Codex on Mac mini can't set check-backs. It's told once what was planned.";
    const github = "GitHub isn't signed in on Mac mini. Sign in there before you turn auto-fix on.";
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-move-brings" as MessageId,
        targetText: "move brings",
      }),
      configureFixture: (fixture) =>
        withMoveCapabilities(fixture, { threadMove: true, threadMoveState: true }),
      resolveRpc: (body) => {
        if (body._tag !== WS_METHODS.movesPreview) return undefined;
        return {
          ...FLEET_MOVE_PREVIEW,
          brings: [
            { words: "Its goal carries on there." },
            { words: "2 queued messages are sent there." },
          ],
          targets: [
            {
              ...macMini,
              agents: [
                ...macMini.agents,
                {
                  instanceId: "claudeAgent",
                  name: "Claude",
                  billing: "Claude Max",
                  driver: "claudeAgent",
                  models: [{ model: "claude-opus-5-5", name: "Opus 5.5" }],
                },
              ],
              notes: [{ words: codexOnly, instanceIds: ["codex"] }, { words: github }],
            },
          ],
        } satisfies ThreadMovePreview;
      },
    });

    const linesOf = (testId: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)).map(
        (line) => line.textContent,
      );
    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();
      const dialog = page.getByTestId("thread-move-dialog");
      await expect
        .element(dialog.getByTestId("thread-move-agent"))
        .toMatchTextContent("Codex · GPT-5");
      // Under the agent: what comes along, then what won't work as it did.
      await expect.element(dialog.getByTestId("thread-move-carries")).toBeVisible();
      expect(linesOf("thread-move-brings")).toEqual([
        "Its goal carries on there.",
        "2 queued messages are sent there.",
      ]);
      expect(linesOf("thread-move-note")).toEqual([codexOnly, github]);

      // Claude picked: the note about Codex goes, the one for any agent stays.
      await dialog.getByTestId("thread-move-agent").click();
      await page.getByRole("option", { name: "Opus 5.5" }).click();
      await expect
        .element(dialog.getByTestId("thread-move-agent"))
        .toMatchTextContent("Claude · Opus 5.5");
      await vi.waitFor(() => expect(linesOf("thread-move-note")).toEqual([github]));
      expect(linesOf("thread-move-brings")).toHaveLength(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers a General Chats thread where its computer moves them, landing in General chats with its files", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const macMini = FLEET_MOVE_PREVIEW.targets[1]!;
    const chatId = "thread-move-general-chat" as ThreadId;
    const withChat = withGeneralChats(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-move-general-chat" as MessageId,
          targetText: "move general chat",
        }),
        chatId,
      ),
      [chatId],
    );
    const previews: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: {
        ...withChat,
        threads: withChat.threads.map((thread) =>
          thread.id === chatId ? { ...thread, title: "Best way to store passkeys" } : thread,
        ),
      },
      configureFixture: (fixture) =>
        withMoveCapabilities(fixture, { threadMove: true, threadMoveState: true }),
      resolveRpc: (body) => {
        if (body._tag !== WS_METHODS.movesPreview) return undefined;
        previews.push(body);
        return {
          folder: { files: 14, bytes: 48_000 },
          targets: [{ ...macMini, projectName: "General chats" }],
        } satisfies ThreadMovePreview;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await vi.waitFor(() => {
        expect(
          readThreadMoveOffered({
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: GENERAL_CHATS_PROJECT_ID,
          }),
        ).toBe(true);
      });
      // The chat's own row menu, in the General Chats list, offers the move.
      await page.getByTestId("rail-chats").click();
      const row = page
        .getByTestId("chats-list-row")
        .filter({ hasText: "Best way to store passkeys" });
      await expect.element(row).toBeVisible();
      const rect = row.element().getBoundingClientRect();
      row.element().dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 20,
          clientY: rect.top + 8,
        }),
      );
      await page.getByText("Move to another computer", { exact: true }).click();
      const dialog = page.getByTestId("thread-move-dialog");
      await expect
        .element(dialog.getByTestId("thread-move-landing"))
        .toHaveTextContent("Lands in General chats on Mac mini · 14 files");
      // No branch: no changes line, and nothing staged to speak of.
      const preview = dialog.getByTestId("thread-move-preview");
      await expect.element(preview).toMatchTextContent("Your copy here stays, read-only.");
      expect(preview.element().textContent).not.toContain("Staged changes");
      expect(dialog.getByTestId("thread-move-changes").elements()).toHaveLength(0);
      await expect.element(dialog.getByTestId("thread-move-confirm")).toBeEnabled();
      expect(previews).toEqual([expect.objectContaining({ threadId: chatId })]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the thread's menu from its title in the header, by click or keyboard", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const previews: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-move-title" as MessageId,
          targetText: "move from title",
        }),
        "thread-move-title-neighbour" as ThreadId,
      ),
      configureFixture: withThreadMoveFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreview) {
          previews.push(body);
          return FLEET_MOVE_PREVIEW;
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await vi.waitFor(() => {
        expect(
          readThreadMoveOffered({ environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID }),
        ).toBe(true);
      });
      const title = page.getByRole("button", { name: `${THREAD_TITLE}, thread menu` });

      // From the keyboard: Enter opens it, the down arrow reaches its first
      // item, and Escape closes it and hands focus back to the title.
      title.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(title).toHaveAttribute("aria-expanded", "true");
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(page.getByRole("button", { name: "Rename" })).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(title).toHaveFocus();
      await expect.element(title).toHaveAttribute("aria-expanded", "false");

      // A click opens the same menu the sidebar row does, and its move opens the dialog.
      await title.click();
      await expect.element(title).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("button", { name: "Move to another computer" }).click();
      await expect
        .element(page.getByTestId("thread-move-dialog").getByTestId("thread-move-target"))
        .toMatchTextContent("Mac mini");
      expect(previews).toEqual([expect.objectContaining({ threadId: THREAD_ID })]);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId("thread-move-dialog")).not.toBeInTheDocument();

      // In the custom sort it offers the row's Move up and Move down too, and
      // they move the thread in the sidebar.
      updateSettings({ inboxSort: "custom" });
      const rowOrder = () =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="thread-row-"]')).map(
          (row) => row.dataset.testid,
        );
      await vi.waitFor(() => expect(rowOrder()).toHaveLength(2));
      const before = rowOrder();
      const isFirst = before[0] === `thread-row-${THREAD_ID}`;
      await title.click();
      const moveUp = page.getByRole("button", { name: "Move up" });
      const moveDown = page.getByRole("button", { name: "Move down" });
      await expect.element(isFirst ? moveUp : moveDown).toBeDisabled();
      await (isFirst ? moveDown : moveUp).click();
      await vi.waitFor(() => expect(rowOrder()).toEqual([...before].toReversed()));
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers a thread whose agent is still working two ways to move, and queues the one picked", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const macMini = FLEET_MOVE_PREVIEW.targets[1]!;
    const queues: Array<NormalizedWsRpcRequestBody> = [];
    let waitsFor: NonNullable<ThreadMovePreview["waitsFor"]> = [
      { code: "turn", words: "when this turn ends" },
      { code: "background", words: "when its background work finishes" },
    ];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-move-working" as MessageId,
        targetText: "move working",
      }),
      configureFixture: withThreadMoveQueueFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreview) {
          return {
            ...FLEET_MOVE_PREVIEW,
            waitsFor,
            targets: [macMini],
          } satisfies ThreadMovePreview;
        }
        if (body._tag === WS_METHODS.movesQueue) {
          queues.push(body);
          return { requestId: QUEUED_REQUEST_ID };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await vi.waitFor(() => {
        expect(
          readThreadMoveOffered({ environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID }),
        ).toBe(true);
      });
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();
      const dialog = page.getByTestId("thread-move-dialog");
      // What the agent is doing, then the two ways: when it finishes comes picked.
      await expect
        .element(dialog.getByTestId("thread-move-doing"))
        .toHaveTextContent(
          "The agent is still working on its reply. Something it started is still running too.",
        );
      await expect
        .element(dialog.getByTestId("thread-move-mode-when-done"))
        .toMatchTextContent(
          "Move when the agent finishesWaits for the agent to finish, then moves to Mac mini.",
        );
      await expect
        .element(dialog.getByTestId("thread-move-mode-stop-now"))
        .toMatchTextContent(
          "Stop the agent and move nowStops the agent and anything it started, then moves.",
        );
      await expect
        .element(dialog.getByRole("radio", { name: /Move when the agent finishes/u }))
        .toBeChecked();
      await expect
        .element(dialog.getByTestId("thread-move-confirm"))
        .toHaveTextContent("Move when it finishes");

      await dialog.getByTestId("thread-move-mode-stop-now").click();
      await expect
        .element(dialog.getByTestId("thread-move-confirm"))
        .toHaveTextContent("Stop and move");
      await dialog.getByTestId("thread-move-confirm").click();
      await expect.element(page.getByTestId("thread-move-dialog")).not.toBeInTheDocument();
      expect(queues).toEqual([
        expect.objectContaining({
          threadId: THREAD_ID,
          targetEnvironmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          agent: { instanceId: "codex", model: "gpt-5" },
          mode: "stop-now",
        }),
      ]);

      // A command runs in the user's terminal, which nothing here stops:
      // stopping isn't offered, says why, and waiting stays picked.
      waitsFor = [{ code: "command_run", words: "when its command finishes running" }];
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();
      await expect
        .element(dialog.getByRole("radio", { name: /Stop the agent and move now/u }))
        .toBeDisabled();
      await expect
        .element(dialog.getByTestId("thread-move-mode-stop-now-detail"))
        .toHaveTextContent(
          "A command from this thread is running in your terminal. Stop it there, or move the thread when it's done.",
        );
      await expect
        .element(dialog.getByRole("radio", { name: /Move when the agent finishes/u }))
        .toBeChecked();
      await expect
        .element(dialog.getByTestId("thread-move-confirm"))
        .toHaveTextContent("Move when it finishes");
    } finally {
      await mounted.cleanup();
    }
  });

  it("queues a free thread's move too, to a computer out of reach with the agent it suggests", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const queues: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-move-offline" as MessageId,
        targetText: "move offline",
      }),
      configureFixture: withThreadMoveQueueFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreview) {
          return {
            changes: FLEET_MOVE_PREVIEW.changes,
            targets: [
              {
                environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
                label: "Mac mini",
                refusal: "Mac mini can't be reached right now.",
                unreachable: true,
                agents: [],
              },
            ],
          } satisfies ThreadMovePreview;
        }
        if (body._tag === WS_METHODS.movesQueue) {
          queues.push(body);
          return { requestId: QUEUED_REQUEST_ID };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("disconnected");
      await vi.waitFor(() => {
        expect(
          readThreadMoveOffered({ environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID }),
        ).toBe(true);
      });
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move to another computer", { exact: true })
        .click();
      const dialog = page.getByTestId("thread-move-dialog");
      await expect
        .element(dialog.getByTestId("thread-move-waits-to-connect"))
        .toHaveTextContent(
          "Mac mini can't be reached right now. The move waits for it to connect, then uses the agent Mac mini suggests.",
        );
      await expect
        .element(dialog.getByTestId("thread-move-confirm"))
        .toHaveTextContent("Move when it connects");
      await dialog.getByTestId("thread-move-confirm").click();
      await expect.element(page.getByTestId("thread-move-dialog")).not.toBeInTheDocument();
      expect(queues).toHaveLength(1);
      expect(queues[0]).toEqual(
        expect.objectContaining({
          threadId: THREAD_ID,
          targetEnvironmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          mode: "when-done",
        }),
      );
      // No agent: Mac mini's suggestion is picked once the move starts.
      expect(queues[0]).not.toHaveProperty("agent");
    } finally {
      await mounted.cleanup();
    }
  });

  it("says when a waiting move goes, holds new messages, and cancels the move it shows", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [
          fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini", { connection: "connected" }),
        ],
      }),
    );
    const calls: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-move-waits" as MessageId,
          targetText: "move waits",
        }),
        { pendingMove: fleetPendingMove() },
      ),
      configureFixture: withThreadMoveFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesUnqueue || body._tag === WS_METHODS.movesRetry) {
          calls.push(body);
          return null;
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await waitForComposerNotice("Moves to Mac mini when this turn ends.");
      await expect
        .element(page.getByTestId(`thread-meta-${THREAD_ID}`))
        .toMatchTextContent("move queued");

      // The box still takes typing, but the message can't go, and says why.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "one more thing");
      const reason =
        "This thread is waiting to move to Mac mini. Cancel the move to keep working here.";
      await expect.element(page.getByRole("button", { name: reason })).toBeDisabled();

      // The agent can't be proven stopped: it says so, with Try again.
      emitThreadEvent(2, {
        eventId: "move-queue-held",
        type: "thread.move-queue-status-set",
        payload: {
          threadId: THREAD_ID,
          requestId: QUEUED_REQUEST_ID,
          waitsFor: [],
          hold: {
            kind: "stop_unconfirmed",
            words: "Couldn't confirm the agent stopped: Codex didn't exit.",
          },
          updatedAt: NOW_ISO,
        },
      });
      await waitForComposerNotice("Couldn't confirm the agent stopped: Codex didn't exit.");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByRole("button", { name: "Cancel the move", exact: true }).click();
      await vi.waitFor(() => {
        expect(calls).toEqual([
          expect.objectContaining({
            _tag: WS_METHODS.movesRetry,
            threadId: THREAD_ID,
            requestId: QUEUED_REQUEST_ID,
          }),
          expect.objectContaining({
            _tag: WS_METHODS.movesUnqueue,
            threadId: THREAD_ID,
            requestId: QUEUED_REQUEST_ID,
          }),
        ]);
      });

      // It couldn't go after all: why, until dismissed, and the box sends again.
      emitThreadEvent(3, {
        eventId: "move-queue-ended",
        type: "thread.move-queue-ended",
        payload: {
          threadId: THREAD_ID,
          requestId: QUEUED_REQUEST_ID,
          reason: "blocked",
          words:
            "this thread's agent set itself a time to come back. Cancel it first, then move again.",
          endedAt: NOW_ISO,
        },
      });
      emitThreadEvent(4, {
        eventId: "move-not-started-activity",
        type: "thread.activity-appended",
        payload: {
          threadId: THREAD_ID,
          activity: {
            id: EventId.make(`move-not-started:${QUEUED_REQUEST_ID}`),
            tone: "error",
            kind: "thread.move-not-started",
            summary: "Didn't move to Mac mini",
            payload: {
              requestId: QUEUED_REQUEST_ID,
              targetLabel: "Mac mini",
              reason: "blocked",
              words:
                "this thread's agent set itself a time to come back. Cancel it first, then move again.",
            },
            turnId: null,
            createdAt: NOW_ISO,
          },
        },
      });
      await waitForComposerNotice(
        "Didn't move: this thread's agent set itself a time to come back. Cancel it first, then move again.",
      );
      await expect.element(page.getByRole("button", { name: "Send message" })).toBeEnabled();
      await page.getByRole("button", { name: "Dismiss why it didn't move to Mac mini" }).click();
      await expect
        .element(page.getByRole("button", { name: "Dismiss why it didn't move to Mac mini" }))
        .not.toBeInTheDocument();

      // A move the user cancelled says nothing back, read from its code.
      const cancelledRequestId = ThreadMoveRequestId.make("queued-cancelled");
      emitThreadEvent(5, {
        eventId: "move-queued-again",
        type: "thread.move-queued",
        payload: {
          threadId: THREAD_ID,
          pendingMove: fleetPendingMove({ requestId: cancelledRequestId }),
        },
      });
      await waitForComposerNotice("Moves to Mac mini");
      emitThreadEvent(6, {
        eventId: "move-queue-cancelled",
        type: "thread.move-queue-ended",
        payload: {
          threadId: THREAD_ID,
          requestId: cancelledRequestId,
          reason: "cancelled",
          endedAt: NOW_ISO,
        },
      });
      await expect
        .element(page.getByRole("button", { name: "Cancel the move", exact: true }))
        .not.toBeInTheDocument();
      expect(
        page.getByRole("button", { name: "Dismiss why it didn't move to Mac mini" }).elements(),
      ).toHaveLength(0);
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
        expect(
          readThreadMoveOffered({ environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID }),
        ).toBe(true);
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
        ...QUEUE_CALLS_UNUSED,
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
    // What Threadlines wrote for the agent on arrival, first in line here.
    const arrival = {
      ...createUserMessage({
        id: "msg-arrival" as MessageId,
        text: "This thread moved from Mac mini to this computer, and your session was restarted for it.\n- Your goal is still on: ship the login fix. Carry on with it.",
        offsetSeconds: importedCount * 3 - 0.5,
      }),
      afterMove: true as const,
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(base, {
        messages: [
          ...thread.messages
            .slice(0, importedCount)
            .map((message) => ({ ...message, imported: true as const })),
          arrival,
          ...thread.messages.slice(importedCount),
        ],
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
              brought: ["its goal", "2 queued messages", "auto-fix for #212"],
              left: [MOVED_IN_LEFT_SENTENCE],
            },
            turnId: null,
            createdAt: isoAt(importedCount * 3 - 1),
          },
        ],
      }),
    });

    try {
      const boundary = page.getByTestId("moved-in-boundary");
      await expect
        .element(boundary)
        .toMatchTextContent(/^Moved here from Mac mini with a summary of the conversation · /u);
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

      // Under it, what came along, then what didn't, with why.
      await expect
        .element(page.getByTestId("moved-in-brought"))
        .toHaveTextContent("Its goal · 2 queued messages · auto-fix for #212");
      await expect
        .element(page.getByTestId("moved-in-left"))
        .toHaveTextContent(MOVED_IN_LEFT_SENTENCE);

      // The arrival message is Threadlines', a quiet row under its name
      // folded to its first line, not the user's bubble.
      const arrivalRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-after-move-message="msg-arrival"]'),
        "The arrival message should show as Threadlines' row.",
      );
      expect(arrivalRow.textContent).toContain("Threadlines·to the agent, about the move");
      expect(arrivalRow.textContent).toContain(
        "This thread moved from Mac mini to this computer, and your session was restarted for it.",
      );
      expect(arrivalRow.textContent).not.toContain("Your goal is still on");
      expect(arrivalRow.closest(".bg-secondary")).toBeNull();
      expect(top(boundary)).toBeLessThan(arrivalRow.getBoundingClientRect().top);
    } finally {
      await mounted.cleanup();
    }
  });

  it("says which pull request switches were on before the move, and turns them on from here", async () => {
    const pullRequest = { number: 212, url: "https://github.com/acme/w/pull/212" };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withTestThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-moved-switches" as MessageId,
          targetText: "moved with switches",
        }),
        {
          linkedPullRequests: [{ ...pullRequest, autoFix: false, autoMerge: null }],
          movedFrom: {
            environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
            label: "Mac mini",
            threadId: "thread-on-mac-mini" as ThreadId,
            movedAt: NOW_ISO,
            fenced: true,
            pullRequestSwitches: {
              autoFix: false,
              autoMerge: null,
              linked: [{ ...pullRequest, autoFix: true, autoMerge: null }],
            },
          },
        },
      ),
    });

    try {
      await expect.element(page.getByText("Auto-fix is off.", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByText("It was on for pull request #212 on Mac mini."))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Turn on", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request as { type?: string }).type === "thread.pull-request-automation.set",
          ),
        ).toMatchObject([
          { pullRequestNumber: 212, pullRequestUrl: pullRequest.url, autoFix: true },
        ]),
      );
      // Left off instead: the notice goes, on this device.
      await page.getByRole("button", { name: "Leave it off" }).click();
      await expect
        .element(page.getByText("Auto-fix is off.", { exact: true }))
        .not.toBeInTheDocument();
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

  it("moves several threads at once: working ones first and ticked, refusals greyed out with why", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const idleId = "thread-batch-idle" as ThreadId;
    const goalId = "thread-batch-goal" as ThreadId;
    const chatId = "thread-batch-general-chat" as ThreadId;
    const familyId = "thread-batch-family" as ThreadId;
    const queueManys: Array<NormalizedWsRpcRequestBody> = [];
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-move-batch" as MessageId,
      targetText: "move batch",
    });
    const snapshot = withGeneralChats(
      [idleId, goalId, chatId, familyId].reduce(addThreadToSnapshot, base),
      [chatId],
    );
    const titles = new Map<string, string>([
      [idleId, "Idle docs pass"],
      [goalId, "Goal thread"],
      [chatId, "Best way to store passkeys"],
      [familyId, "Family thread"],
    ]);
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          title: titles.get(thread.id) ?? thread.title,
        })),
      },
      // This computer moves threads with what they had going, General Chats included.
      configureFixture: (fixture) =>
        withMoveCapabilities(fixture, {
          threadMove: true,
          threadMoveQueue: true,
          threadMoveBatch: true,
          threadMoveState: true,
        }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.movesPreviewMany) {
          const threadIds = (body as unknown as { threadIds: ThreadId[] }).threadIds;
          const working = [{ code: "turn" as const, words: "when this turn ends" }];
          return {
            threads: threadIds.map((threadId) =>
              threadId === THREAD_ID
                ? { threadId, waitsFor: working }
                : threadId === chatId
                  ? {
                      threadId,
                      waitsFor: working,
                      folder: { files: 14, bytes: 2_048 },
                      targetLines: [
                        {
                          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
                          projectName: "General chats",
                        },
                      ],
                    }
                  : threadId === goalId
                    ? {
                        threadId,
                        brings: [{ words: "Its goal carries on there." }],
                        targetLines: [
                          {
                            environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
                            notes: [
                              {
                                words:
                                  "Its goal arrives paused: Claude on Mac mini can't keep its token budget. Resume runs it without one.",
                              },
                            ],
                          },
                        ],
                      }
                    : threadId === familyId
                      ? { threadId, refusal: "It started threads that are still working." }
                      : { threadId },
            ),
            targets: [{ ...FLEET_MOVE_PREVIEW.targets[1]!, projectName: undefined }],
          };
        }
        if (body._tag === WS_METHODS.movesQueueMany) {
          queueManys.push(body);
          return { batchId: "batch-browser", queued: [], refused: [] };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await openCommandPaletteFromTrigger();
      await page
        .getByTestId("command-palette")
        .getByText("Move threads to another computer…", { exact: true })
        .click();
      const dialog = page.getByTestId("move-threads-dialog");
      const list = dialog.getByTestId("move-threads-list");
      await expect.element(list).toBeVisible();
      // The working threads lead, ticked, the General Chats one with them;
      // the idle ones wait for the user.
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="move-threads-row-"]'),
      ).map((row) => row.dataset.testid);
      expect(rows.slice(0, 2)).toEqual([
        `move-threads-row-${THREAD_ID}`,
        `move-threads-row-${chatId}`,
      ]);
      expect(rows).toHaveLength(5);
      await expect.element(dialog.getByTestId(`move-threads-tick-${chatId}`)).toBeChecked();
      await expect
        .element(dialog.getByTestId(`move-threads-words-${THREAD_ID}`))
        .toHaveTextContent("Moves when the agent finishes");
      await expect.element(dialog.getByTestId(`move-threads-tick-${THREAD_ID}`)).toBeChecked();
      await expect
        .element(dialog.getByTestId(`move-threads-words-${idleId}`))
        .toHaveTextContent("Moves now");
      await expect.element(dialog.getByTestId(`move-threads-tick-${idleId}`)).not.toBeChecked();
      // A thread with a goal moves, and says what comes along.
      await expect
        .element(dialog.getByTestId(`move-threads-words-${goalId}`))
        .toHaveTextContent("Moves now");
      await expect
        .element(dialog.getByTestId(`move-threads-brings-${goalId}`))
        .toHaveTextContent("Its goal carries on there.");
      // What won't work there as it did, for the agent it moves with.
      await expect
        .element(dialog.getByTestId(`move-threads-note-${goalId}`))
        .toHaveTextContent(
          "Its goal arrives paused: Claude on Mac mini can't keep its token budget. Resume runs it without one.",
        );
      await expect.element(dialog.getByTestId(`move-threads-tick-${goalId}`)).toBeEnabled();
      // A General Chats thread says where it lands, with its files.
      await expect
        .element(dialog.getByTestId(`move-threads-landing-${chatId}`))
        .toHaveTextContent("Lands in General chats on Mac mini · 14 files");
      // One that can't move is listed, greyed out, with why.
      await expect
        .element(dialog.getByTestId(`move-threads-words-${familyId}`))
        .toHaveTextContent("It started threads that are still working.");
      await expect.element(dialog.getByTestId(`move-threads-tick-${familyId}`)).toBeDisabled();
      await expect
        .element(dialog.getByTestId("move-threads-confirm"))
        .toHaveTextContent("Move 2 threads");

      await dialog.getByTestId(`move-threads-tick-${goalId}`).click();
      await expect
        .element(dialog.getByTestId("move-threads-confirm"))
        .toHaveTextContent("Move 3 threads");
      await dialog.getByTestId("move-threads-confirm").click();
      await expect.element(page.getByTestId("move-threads-dialog")).not.toBeInTheDocument();
      expect(queueManys).toEqual([
        expect.objectContaining({
          threadIds: [THREAD_ID, chatId, goalId],
          targetEnvironmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          mode: "when-done",
        }),
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Move threads here on another computer's Fleet page, and says how its batch goes", async () => {
    const batchStatusCalls: Array<NormalizedWsRpcRequestBody> = [];
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const movedId = "thread-batch-moved" as ThreadId;
    const waitingId = "thread-batch-waiting" as ThreadId;
    const batchId = ThreadMoveBatchId.make("batch-fleet");
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-move-shot" as MessageId,
      targetText: "move shot",
    });
    const snapshot = addThreadToSnapshot(addThreadToSnapshot(base, movedId), waitingId);
    const pending = (requestId: string): ThreadPendingMove => ({
      requestId: ThreadMoveRequestId.make(requestId),
      target: { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID, label: "Mac mini" },
      mode: "when-done",
      stage: "waiting",
      requestedAt: NOW_ISO,
      requestedBy: { kind: "user" },
      waitsFor: [{ code: "turn", words: "when this turn ends" }],
      batchId,
    });
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === movedId
            ? {
                ...thread,
                title: "Docs pass",
                lastMoveOutcome: {
                  result: "moved",
                  target: { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID, label: "Mac mini" },
                  batchId,
                  at: NOW_ISO,
                },
              }
            : thread.id === waitingId
              ? { ...thread, title: "Login fix", pendingMove: pending("shot-2") }
              : { ...thread, pendingMove: pending("shot-1") },
        ),
      },
      configureFixture: (fixture) =>
        withMoveCapabilities(fixture, {
          threadMove: true,
          threadMoveQueue: true,
          threadMoveBatch: true,
        }),
      // The batch's own record keeps a thread refused when it was queued,
      // which no thread here carries.
      resolveRpc: (body) => {
        if (body._tag !== WS_METHODS.movesBatchStatus) return undefined;
        batchStatusCalls.push(body);
        const final = batchStatusCalls.length > 1;
        const member = (threadId: string, title: string, state: string, extra = {}) => ({
          threadId,
          title,
          state,
          final: state === "moved" || state === "not_moved",
          ...extra,
        });
        const members = [
          member(THREAD_ID, THREAD_TITLE, final ? "moved" : "waiting"),
          member(movedId, "Docs pass", "moved"),
          final
            ? member(waitingId, "Login fix", "not_moved", {
                words: "Mac mini didn't allow the move.",
              })
            : member(waitingId, "Login fix", "waiting"),
          member("thread-batch-refused", "Goal thread", "not_moved", {
            words: "Has a goal set. Clear it first.",
          }),
        ];
        return {
          batchId,
          target: { environmentId: FLEET_OFFLINE_ENVIRONMENT_ID, label: "Mac mini" },
          createdAt: new Date().toISOString(),
          members,
          final: members.every((entry) => entry.final),
        };
      },
      initialPath: `/fleet/${FLEET_OFFLINE_ENVIRONMENT_ID}`,
    });
    try {
      await waitForServerConfigToApply();
      await saveMacMini("connected");
      await expect
        .element(page.getByTestId("fleet-move-threads"))
        .toHaveTextContent("Move threads here…");
      // The batch's progress, from its own record, on the page and its row:
      // the thread refused at queue time counts too.
      await expect
        .element(page.getByTestId("fleet-computer-move-batch"))
        .toHaveTextContent(
          "Moving 4 threads here: 1 moved, 2 waiting for their agents, 1 didn't move",
        );
      await expect
        .element(page.getByTestId(`fleet-list-computer-${FLEET_OFFLINE_ENVIRONMENT_ID}`))
        .toMatchTextContent(/Moving 4 threads here/u);
      // Final: every thread that didn't move is named, with why, and the
      // record is asked no more.
      await expect
        .element(page.getByTestId("fleet-computer-move-batch"), { timeout: 8_000 })
        .toHaveTextContent(
          "Moved 2 of 4 threads to Mac mini. Didn't move: Login fix (Mac mini didn't allow the move), Goal thread (Has a goal set. Clear it first).",
        );
      const asked = batchStatusCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(batchStatusCalls).toHaveLength(asked);
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups one computer's moves under Allow all, which answers them together", async () => {
    const windowsLinks = fakeComputerLinksClient();
    const respondMany = vi.fn(async (input: { requestIds: readonly string[] }) => ({
      answered: [...input.requestIds],
      failed: [],
    }));
    const moveRequest = (requestId: string, title: string): ComputerLinkPendingRequest => ({
      ...fleetPendingRequest(LOCAL_ENVIRONMENT_ID, requestId, title),
      kind: "move",
      fromLabel: "Local environment",
      prompt: "",
      projectName: "threadlines",
      move: {
        messageCount: 12,
        branch: "main",
        trackedFiles: 0,
        untrackedFiles: 0,
        unpushedCommits: 0,
        bytesReceived: 1_048_576,
        totalBytes: 4_194_304,
      },
    });
    const first = moveRequest("transfer-group-1", "Login fix");
    const second = moveRequest("transfer-group-2", "Docs pass");
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-move-group" as MessageId,
        targetText: "move group",
      }),
      configureFixture: (fixture) =>
        withMoveCapabilities(fixture, {
          threadMove: true,
          threadMoveQueue: true,
          threadMoveStagedApproval: true,
        }),
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
      __setThreadMovesClientForTests(FLEET_REMOTE_ENVIRONMENT_ID, {
        preview: async () => FLEET_MOVE_PREVIEW,
        start: async () => ({ transferId: ThreadMoveId.make("unused") }),
        cancel: async () => undefined,
        ...QUEUE_CALLS_UNUSED,
        respondMany: respondMany as unknown as ThreadMovesClient["respondMany"],
      });
      useComputerLinksStore
        .getState()
        .put(FLEET_REMOTE_ENVIRONMENT_ID, fleetLinksSnapshot({ pending: [first, second] }));

      // One inbox row for both, naming each and how much of it is here.
      const group = page.getByTestId(`link-request-group-${first.deviceId}`);
      await expect
        .element(group)
        .toMatchTextContent(/Local environment wants to move 2 threads to Windows PC/u);
      await expect
        .element(group.getByTestId(`link-request-group-${first.deviceId}-threads`))
        .toMatchTextContent(/Login fix · 1\.0 of 4\.0 MB here.*Docs pass/u);
      expect(document.querySelector(`[data-testid="link-request-${first.requestId}"]`)).toBeNull();

      await group.getByTestId(`link-request-group-${first.deviceId}-allow`).click();
      await vi.waitFor(() => {
        expect(respondMany).toHaveBeenCalledWith({
          deviceId: first.deviceId,
          requestIds: [first.requestId, second.requestId],
          allow: true,
        });
      });
      expect(windowsLinks.respondRequest).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});
