import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  type OutsideAgentsSnapshot,
  type ThreadId,
  WS_METHODS,
} from "@threadlines/contracts";
import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { getOfferedCommands } from "../commands/commandHandlers";
import { useCommandUsageStore } from "../commands/commandUsageStore";
import { setCommandPaletteCommitListenerForTests } from "./CommandPalette";
import { useComposerDraftStore } from "../composerDraftStore";

import {
  THREAD_ID,
  NOW_ISO,
  fixture,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  UUID_ROUTE_RE,
  wsRequests,
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  threadRefFor,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  promoteDraftThreadViaDomainEvent,
  createSnapshotWithSecondaryProject,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  waitForServerConfigToApply,
  CHAT_FIND_KEYBINDING,
  triggerChatNewShortcutUntilPath,
  openCommandPaletteFromTrigger,
  openCommandPaletteCommands,
  showAllPaletteCommands,
  waitForCommandPaletteShortcutLabel,
  mountChatView,
  registerChatViewSuiteHooks,
  rpcHarness,
  setPrimaryOutsideAgentsSnapshot,
  setPrimarySessionRole,
  withOutsideAgentsFixture,
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

describe("ChatView (full app): command palette and search", () => {
  registerChatViewSuiteHooks();

  it("opens find in chat from the command palette", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-find-from-palette-test" as MessageId,
        targetText: "find from the palette",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [CHAT_FIND_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteCommands();
      const palette = page.getByTestId("command-palette");
      await expect.element(palette.getByText("Find in chat", { exact: true })).toBeInTheDocument();
      await palette.getByText("Find in chat", { exact: true }).click();
      await vi.waitFor(() => {
        const field = document.querySelector('[data-testid="chat-find-input"]');
        expect(field).not.toBeNull();
        expect(document.activeElement).toBe(field);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows an agent's sign-in over the thread to this computer's owner, and opens the Agents and Assistants groups from the palette", async () => {
    const requestId = OutsideAgentRequestId.make("request-claude");
    setPrimarySessionRole("owner");
    const outsideAgents: OutsideAgentsSnapshot = {
      address: "http://127.0.0.1:3773/mcp/connect",
      connections: [],
      pending: [
        {
          requestId,
          name: "Claude Code",
          code: "K4D-82P",
          callbackPort: 51_234,
          requestedAccess: "start",
          replaces: null,
          createdAt: new Date(Date.now() - 5_000).toISOString(),
          expiresAt: new Date(Date.now() + 295_000).toISOString(),
        },
      ],
      linkedAsks: [],
      quietUntil: null,
      assistants: {
        status: "ready",
        address: "https://connect.threadlines.dev/mcp",
        code: null,
        signIns: [],
        alertTargets: [],
        reviewComputer: false,
      },
    };
    setPrimaryOutsideAgentsSnapshot(outsideAgents);
    // As the server does: the code it makes is in everything it streams from
    // then on. Settings can close and reopen the stream while the code is on
    // its way, and a fresh stream that still said "no code" would wipe it.
    const makeAssistantCode = () => {
      const code = { code: "K4D82PQX", expiresAt: new Date(Date.now() + 600_000).toISOString() };
      const withCode: OutsideAgentsSnapshot = {
        ...outsideAgents,
        pending: [],
        assistants: { ...outsideAgents.assistants, code },
      };
      setPrimaryOutsideAgentsSnapshot(withCode);
      rpcHarness.emitStreamValue(WS_METHODS.outsideAgentsSubscribe, withCode);
      return code;
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-outside-agent-sign-in" as MessageId,
        targetText: "outside agent sign-in",
      }),
      configureFixture: withOutsideAgentsFixture,
      resolveRpc: (body) =>
        body._tag === WS_METHODS.outsideAgentsApprove
          ? {
              connectionId: OutsideAgentConnectionId.make("connection-claude"),
              name: "Claude Code",
              kind: "local",
              signIn: "oauth",
              identity: null,
              access: "see",
              maxRuntimeMode: "approval-required",
              projectIds: null,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            }
          : body._tag === WS_METHODS.outsideAgentsAssistantCode
            ? makeAssistantCode()
            : undefined,
    });

    try {
      const dialog = page.getByTestId("outside-agent-dialog");
      await expect
        .element(dialog.getByRole("heading", { name: "Claude Code wants to use Threadlines" }))
        .toBeVisible();
      await dialog.getByTestId("outside-agent-allow").click();
      await vi.waitFor(() => {
        expect(
          wsRequests.find((request) => request._tag === WS_METHODS.outsideAgentsApprove),
        ).toMatchObject({
          requestId,
          access: "see",
          maxRuntimeMode: "approval-required",
          projectIds: null,
        });
      });
      await expect.element(page.getByTestId("outside-agent-dialog")).not.toBeInTheDocument();
      // What the server says from now on, should the stream open again.
      setPrimaryOutsideAgentsSnapshot({ ...outsideAgents, pending: [] });

      await openCommandPaletteCommands();
      await page
        .getByTestId("command-palette")
        .getByText("Connect an agent", { exact: true })
        .click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/settings/connections",
        "Connect an agent should open Settings › Connections.",
      );
      expect(mounted.router.state.location.search).toEqual({ section: "agents" });
      await expect.element(page.getByTestId("outside-agents-section")).toBeInTheDocument();

      // "Connect an assistant" opens the Assistants group and shows a code.
      // Settings has no palette button of its own: open it as its shortcut does.
      useCommandPaletteStore.getState().setOpen(true);
      await showAllPaletteCommands();
      await page
        .getByTestId("command-palette")
        .getByText("Connect an assistant", { exact: true })
        .click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.search).toEqual({ section: "assistants" });
      });
      const assistants = page.getByTestId("assistants-section");
      await expect.element(assistants.getByTestId("assistant-code")).toHaveTextContent("K4D8-2PQX");
      expect(
        wsRequests.filter((request) => request._tag === WS_METHODS.outsideAgentsAssistantCode),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers exactly the commands their owners register, on a thread and on the home screen", async () => {
    // The guard for the availability rules: each moved next to the code it
    // protects, so a rule lost in a move shows up here as a change.
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-offered-commands" as MessageId,
        targetText: "offered commands",
      }),
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      await vi.waitFor(() => expect(getOfferedCommands().has("thread.rename")).toBe(true));
      expect([...getOfferedCommands().keys()].toSorted()).toEqual([
        "app.reportProblem",
        "app.whatsNew",
        "chat.find",
        "chat.new",
        "chat.newGeneral",
        "chat.newIn",
        "chat.newLocal",
        "composer.planMode",
        "composer.stash",
        "computer.connect",
        "diff.toggle",
        "files.browse",
        "modelPicker.toggle",
        "navigate.communityAgents",
        "navigate.fleet",
        "navigate.generalChats",
        "navigate.home",
        "navigate.settings",
        "navigate.setup",
        "navigate.skills",
        "navigate.terminals",
        "navigate.usage",
        "panel.agents",
        "panel.diff",
        "panel.sourceControl",
        "panel.threads",
        "project.add",
        "room.addAgent",
        "sidebar.toggle",
        "terminal.clear",
        "terminal.close",
        "terminal.find",
        "terminal.new",
        "terminal.restart",
        "terminal.split",
        "terminal.toggle",
        "theme.change",
        "theme.editColors",
        "theme.useDefault",
        "thread.archive",
        "thread.copyId",
        "thread.copyPath",
        "thread.delete",
        "thread.pin",
        "thread.rename",
        "thread.wrapUp",
      ]);

      await showAllPaletteCommands();
      await page.getByTestId("command-palette").getByText("Go to Home", { exact: true }).click();
      await waitForURL(mounted.router, (path) => path === "/", "Go to Home should open Home.");
      await openCommandPaletteFromTrigger();
      // Nothing of the thread's is offered once it is off screen.
      await vi.waitFor(() => expect(getOfferedCommands().has("terminal.toggle")).toBe(false));
      expect([...getOfferedCommands().keys()].toSorted()).toEqual([
        "app.reportProblem",
        "app.whatsNew",
        "chat.newGeneral",
        "chat.newIn",
        "chat.newLocal",
        "computer.connect",
        "navigate.back",
        "navigate.communityAgents",
        "navigate.fleet",
        "navigate.generalChats",
        "navigate.settings",
        "navigate.setup",
        "navigate.skills",
        "navigate.terminals",
        "navigate.usage",
        "project.add",
        "sidebar.toggle",
        "theme.change",
        "theme.editColors",
        "theme.useDefault",
        "thread.next",
        "thread.previous",
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens on recent threads, then suggested commands, and learns which ones are used", async () => {
    useCommandUsageStore.setState({ byKey: {} });
    const olderThreadId = "thread-opening-older" as ThreadId;
    const newerThreadId = "thread-opening-newer" as ThreadId;
    const base = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-opening-list" as MessageId,
          targetText: "opening list",
        }),
        olderThreadId,
      ),
      newerThreadId,
    );
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === olderThreadId
          ? { ...thread, title: "Older plan", updatedAt: "2026-03-01T10:00:00.000Z" }
          : thread.id === newerThreadId
            ? { ...thread, title: "Newer plan", updatedAt: "2026-03-02T10:00:00.000Z" }
            : thread,
      ),
    };
    const openTitle = snapshot.threads.find((thread) => thread.id === THREAD_ID)!.title;
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    const groupsAndRows = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="command-palette"] [data-slot="command-group-label"], [data-testid="command-palette"] [data-slot="command-item"]',
        ),
      ).map((element) =>
        element.dataset.slot === "command-group-label"
          ? `# ${element.textContent?.trim()}`
          : (element.querySelector("span span")?.textContent?.trim() ??
            element.textContent?.trim() ??
            ""),
      );

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      await vi.waitFor(() => {
        const shown = groupsAndRows();
        expect(shown.filter((entry) => entry.startsWith("# "))).toEqual([
          "# Recent",
          "# Suggested",
        ]);
        // Latest activity first, and not the thread on screen.
        expect(shown.indexOf("Newer plan")).toBeLessThan(shown.indexOf("Older plan"));
        expect(shown).not.toContain(openTitle);
      });
      const palette = page.getByTestId("command-palette");
      // Before this device has used anything: the first suggestions, as far as each is offered.
      for (const title of ["Toggle terminal", "Toggle panel", "Add project"]) {
        await expect.element(palette.getByText(title, { exact: true })).toBeInTheDocument();
      }

      await showAllPaletteCommands();
      await palette.getByText("Open usage", { exact: true }).click();
      await waitForURL(mounted.router, (path) => path === "/usage", "Open usage should open it.");

      // Usage has no Search field of its own: open it as its shortcut does.
      useCommandPaletteStore.getState().setOpen(true);
      await vi.waitFor(() => {
        const shown = groupsAndRows();
        const suggested = shown.slice(shown.indexOf("# Suggested") + 1);
        expect(suggested[0]).toBe("Open usage");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("commits nothing in the palette's rows and command sources while a reply streams (Wrap up and Reopen sit outside)", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-streaming" as MessageId,
        targetText: "palette while streaming",
      }),
    });
    let commits = 0;

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      // Let the palette and its command sources settle before counting.
      for (let frame = 0; frame < 10; frame += 1) await waitForLayout();
      setCommandPaletteCommitListenerForTests(() => {
        commits += 1;
      });

      const messageId = MessageId.make("msg-assistant-streaming-behind-palette");
      let text = "";
      for (let token = 0; token < 20; token += 1) {
        text += `word${token} `;
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "event",
          event: {
            sequence: fixture.snapshot.snapshotSequence + 1 + token,
            eventId: EventId.make(`evt-streaming-behind-palette-${token}`),
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            // Each token arrives later than the last, as a real stream's do.
            occurredAt: new Date(Date.parse(NOW_ISO) + (token + 1) * 1000).toISOString(),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: THREAD_ID,
              messageId,
              role: "assistant",
              text,
              turnId: null,
              streaming: true,
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
            },
          } satisfies OrchestrationEvent,
        });
        await waitForLayout();
      }
      // The reply did reach the chat behind the palette.
      await vi.waitFor(() => expect(document.body.textContent).toContain("word19"));
      for (let frame = 0; frame < 5; frame += 1) await waitForLayout();

      expect(commits).toBe(0);
    } finally {
      setCommandPaletteCommitListenerForTests(null);
      await mounted.cleanup();
    }
  });

  it("opens a setting from the palette on its row, and Back returns to the chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-setting-result" as MessageId,
        targetText: "palette setting result",
      }),
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      const palette = page.getByTestId("command-palette");
      await page.getByPlaceholder("Search threads, commands and settings").fill("text size");
      await palette.getByText("Text size", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => path === "/settings/general",
        "A setting result should open its Settings page.",
      );
      await waitForElement(
        () =>
          document.querySelector(
            '[data-place="general.terminalTextSize"] > .place-arrival-overlay',
          ),
        "The setting's row should be lit on arrival.",
      );

      // The palette pushed Settings rather than replacing the chat's entry.
      mounted.router.history.back();
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "Back should return to the chat the palette was opened over.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it('says "Searching messages" until the search answers, and only then No matches', async () => {
    let answerSearch!: (value: { matches: []; truncated: false }) => void;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-searching" as MessageId,
        targetText: "palette searching",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.searchThreads) {
          return new Promise((resolve) => {
            answerSearch = resolve;
          });
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      const palette = page.getByTestId("command-palette");
      await page.getByPlaceholder("Search threads, commands and settings").fill("zebracorn");

      await expect.element(palette.getByText("Searching messages…")).toBeInTheDocument();
      await vi.waitFor(() => expect(answerSearch).toBeTypeOf("function"), {
        timeout: 8_000,
        interval: 16,
      });
      // Still waiting on the server: nothing says there are no matches yet.
      expect(document.body.textContent).not.toContain("No matches");

      answerSearch({ matches: [], truncated: false });
      await expect.element(palette.getByText("No matches", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Look in archived threads", { exact: true }))
        .toBeInTheDocument();
      await expect.element(palette.getByText("Searching messages…")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("names a computer whose message search failed", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-search-failed" as MessageId,
        targetText: "palette search failed",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.searchThreads) {
          return Promise.reject(new Error("The search index is busy."));
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      await page.getByPlaceholder("Search threads, commands and settings").fill("zebracorn");
      await vi.waitFor(
        () => {
          const status = document.querySelector('[data-testid="command-palette-status"]');
          expect(status?.textContent).toMatch(/Couldn't search \S/);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("says what a project's thread search is waiting on, and names a computer it couldn't search", async () => {
    let failSearch!: (error: Error) => void;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-search-status" as MessageId,
        targetText: "project search status",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.searchThreads) {
          return new Promise((_, reject) => {
            failSearch = reject;
          });
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      useCommandPaletteStore.getState().openThreadSearch({
        projectName: "Project",
        memberProjectKeys: [scopedProjectKey(scopeProjectRef(LOCAL_ENVIRONMENT_ID, PROJECT_ID))],
      });
      const palette = page.getByTestId("command-palette");
      await page.getByPlaceholder("Search threads in Project...").fill("zebracorn");

      await expect.element(palette.getByText("Searching messages…")).toBeInTheDocument();
      await vi.waitFor(() => expect(failSearch).toBeTypeOf("function"), {
        timeout: 8_000,
        interval: 16,
      });
      expect(document.body.textContent).not.toContain("No matches");

      failSearch(new Error("The search index is busy."));
      await vi.waitFor(
        () => {
          const status = document.querySelector('[data-testid="command-palette-status"]');
          expect(status?.textContent).toMatch(/Couldn't search \S/);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters by kind with counts, moves between filters with Tab, and takes > as the Commands filter", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-filters" as MessageId,
        targetText: "palette filters",
      }),
    });
    const chosenFilter = () =>
      document.querySelector<HTMLElement>(
        '[data-testid="command-palette"] [data-slot="command-filter"][aria-pressed="true"]',
      )?.firstChild?.textContent;

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      const field = page.getByPlaceholder("Search threads, commands and settings");
      await field.fill("settings");
      // Each filter counts what it holds while there is text.
      await vi.waitFor(() => {
        const counts = Object.fromEntries(
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="command-palette"] [data-slot="command-filter"]',
            ),
          ).map((button) => [button.firstChild?.textContent, button.lastChild?.textContent]),
        );
        const commands = Number(counts.Commands);
        expect(commands).toBeGreaterThan(0);
        expect(Number(counts.All)).toBe(
          Number(counts.Threads) + commands + Number(counts.Settings) + Number(counts.Projects),
        );
      });

      await userEvent.keyboard("{Tab}");
      expect(chosenFilter()).toBe("Threads");
      await userEvent.keyboard("{Tab}");
      expect(chosenFilter()).toBe("Commands");
      // Only commands now.
      await vi.waitFor(() => {
        const labels = Array.from(
          document.querySelectorAll(
            '[data-testid="command-palette"] [data-slot="command-group-label"]',
          ),
        ).map((label) => label.textContent);
        expect(labels).toEqual(["Commands"]);
      });
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(chosenFilter()).toBe("Threads");

      // ">" first switches to Commands and leaves the field empty: one state.
      await field.fill("");
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(chosenFilter()).toBe("All");
      await userEvent.keyboard(">");
      expect(chosenFilter()).toBe("Commands");
      await expect.element(field).toHaveValue("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows five rows of a kind in All, and Show all switches to its filter", async () => {
    const planIds = Array.from({ length: 7 }, (_, index) => `thread-plan-${index}` as ThreadId);
    const base = planIds.reduce(
      (snapshot, threadId) => addThreadToSnapshot(snapshot, threadId),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-caps" as MessageId,
        targetText: "palette caps",
      }),
    );
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) => {
        const index = planIds.indexOf(thread.id);
        return index < 0 ? thread : { ...thread, title: `Quokka plan ${index + 1}` };
      }),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const threadRows = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="command-palette"] [role="group"][aria-labelledby$="threads-search"] [data-slot="command-item"]',
        ),
      ).map((row) => row.textContent ?? "");

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      await page.getByPlaceholder("Search threads, commands and settings").fill("quokka");
      await vi.waitFor(() => {
        const rows = threadRows();
        expect(rows.filter((row) => row.includes("Quokka plan"))).toHaveLength(5);
        expect(rows.at(-1)).toBe("Show all 7 threads");
      });

      await page.getByTestId("command-palette").getByText("Show all 7 threads").click();
      await vi.waitFor(() => {
        expect(threadRows().filter((row) => row.includes("Quokka plan"))).toHaveLength(7);
        expect(threadRows().some((row) => row.startsWith("Show all"))).toBe(false);
      });
      const chosen = document.querySelector(
        '[data-testid="command-palette"] [data-slot="command-filter"][aria-pressed="true"]',
      );
      expect(chosen?.firstChild?.textContent).toBe("Threads");
    } finally {
      await mounted.cleanup();
    }
  });

  it("steps back with Escape: the text, then the filter, then closes", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-escape" as MessageId,
        targetText: "palette escape",
      }),
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      const field = page.getByPlaceholder("Search threads, commands and settings");
      await userEvent.keyboard(">open");
      await expect.element(field).toHaveValue("open");

      await userEvent.keyboard("{Escape}");
      await expect.element(field).toHaveValue("");
      const chosen = () =>
        document.querySelector(
          '[data-testid="command-palette"] [data-slot="command-filter"][aria-pressed="true"]',
        )?.firstChild?.textContent;
      expect(chosen()).toBe("Commands");

      await userEvent.keyboard("{Escape}");
      expect(chosen()).toBe("All");
      await expect.element(page.getByTestId("command-palette")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId("command-palette")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the highlight on a row the user chose when a message match arrives above it", async () => {
    const messageThreadId = "thread-late-message" as ThreadId;
    const base = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-late-match" as MessageId,
        targetText: "palette late match",
      }),
      messageThreadId,
    );
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? { ...thread, title: "Settings sync between tabs" }
          : thread.id === messageThreadId
            ? { ...thread, title: "Lunch order" }
            : thread,
      ),
    };
    const answers: Array<() => void> = [];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.searchThreads) return undefined;
        return new Promise((resolve) => {
          answers.push(() =>
            resolve({
              matches: [
                {
                  threadId: messageThreadId,
                  messageId: "msg-late-settings" as MessageId,
                  role: "user",
                  snippet: "…the settings page should remember the last tab…",
                  score: 0,
                },
              ],
              truncated: false,
            }),
          );
        });
      },
    });
    const highlighted = () =>
      document.querySelector<HTMLElement>(
        '[data-testid="command-palette"] [role="option"][aria-selected="true"]',
      )?.dataset.value;
    const firstRow = () =>
      document.querySelector<HTMLElement>('[data-testid="command-palette"] [role="option"]')
        ?.dataset.value;
    const snippetShown = () =>
      document.body.textContent?.includes("should remember the last tab") ?? false;

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      await page.getByPlaceholder("Search threads, commands and settings").fill("settings");
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0), {
        timeout: 8_000,
        interval: 16,
      });
      // The user moves off the first row (the thread) to the next one, a command.
      await vi.waitFor(() => expect(highlighted()).toBe(firstRow()));
      await userEvent.keyboard("{ArrowDown}");
      const chosen = highlighted();
      expect(chosen).toBeDefined();
      expect(chosen).not.toBe(firstRow());

      // The message match lands in Threads, above the chosen row.
      answers.at(-1)!();
      await vi.waitFor(() => expect(snippetShown()).toBe(true));
      expect(highlighted()).toBe(chosen);

      // Without a move, the highlight stays on the first row as matches arrive.
      const asked = answers.length;
      await page.getByPlaceholder("Search threads, commands and settings").fill("setting");
      await vi.waitFor(() => expect(snippetShown()).toBe(false));
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(asked), {
        timeout: 8_000,
        interval: 16,
      });
      await vi.waitFor(() => expect(highlighted()).toBe(firstRow()));
      const first = firstRow();
      answers.at(-1)!();
      await vi.waitFor(() => expect(snippetShown()).toBe(true));
      expect(highlighted()).toBe(first);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens on the threads last opened here, ahead of ones with newer activity", async () => {
    const olderThreadId = "thread-visits-older" as ThreadId;
    const newerThreadId = "thread-visits-newer" as ThreadId;
    const base = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-recent-visits" as MessageId,
          targetText: "recent visits",
        }),
        olderThreadId,
      ),
      newerThreadId,
    );
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === olderThreadId
          ? { ...thread, title: "Visited plan", updatedAt: "2026-03-01T10:00:00.000Z" }
          : thread.id === newerThreadId
            ? { ...thread, title: "Busy plan", updatedAt: "2026-03-02T10:00:00.000Z" }
            : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      await waitForServerConfigToApply();
      // Open the older thread, then come back.
      await mounted.router.navigate({ to: serverThreadPath(olderThreadId) });
      await waitForURL(mounted.router, (path) => path === serverThreadPath(olderThreadId), "");
      await mounted.router.navigate({ to: serverThreadPath(THREAD_ID) });
      await waitForURL(mounted.router, (path) => path === serverThreadPath(THREAD_ID), "");

      await openCommandPaletteFromTrigger();
      await vi.waitFor(
        () => {
          const titles = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="command-palette"] [data-slot="command-item"]',
            ),
          ).map((row) => row.textContent ?? "");
          const visited = titles.findIndex((title) => title.includes("Visited plan"));
          const busy = titles.findIndex((title) => title.includes("Busy plan"));
          expect(visited).toBeGreaterThanOrEqual(0);
          expect(visited).toBeLessThan(busy);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays open under StrictMode", async () => {
    // The app mounts under StrictMode, which runs every new effect's cleanup
    // once right after mount. An unmount reset on the open dialog turned that
    // into a palette that closed the instant it opened, in dev only.
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-strict-mode" as MessageId,
        targetText: "command palette strict mode",
      }),
      strictMode: true,
    });

    try {
      await openCommandPaletteFromTrigger();
      await waitForLayout();
      await waitForLayout();

      expect(useCommandPaletteStore.getState().open).toBe(true);
      await expect.element(page.getByTestId("command-palette")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the model picker ready to add an agent from Add agent, and it stays open", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-agent" as MessageId,
        targetText: "command palette add agent",
      }),
      strictMode: true,
    });

    try {
      await openCommandPaletteCommands();
      const palette = page.getByTestId("command-palette");
      await palette.getByText("Add agent", { exact: true }).click();

      // The closing palette hands focus back to the composer first; the list
      // must open after that, not lose focus to it and close.
      await waitForElement(
        () => document.querySelector(".model-picker-list"),
        "The model picker should open from the command palette.",
      );
      // Long enough for a closing popover's exit to finish.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
      expect(document.querySelector(".model-picker-list")).not.toBeNull();
      await expect
        .element(page.getByText("Pick a model for the new agent.", { exact: false }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters command palette results as the user types", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-search-test" as MessageId,
        targetText: "command palette search test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search threads, commands and settings").fill("settings");
      await expect.element(palette.getByText("Open settings", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("highlights quoted phrase matches in titles and messages and jumps to the message", async () => {
    const matchedThreadTitle = "Release codename deltafrogs thread";
    const searchQuery = `"release codename"`;
    const searchSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-command-palette-content-search" as MessageId,
      targetText: "Release codename deltafrogs is approved.",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...searchSnapshot,
        threads: searchSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? { ...thread, title: matchedThreadTitle } : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.searchThreads) {
          return {
            matches: [
              {
                threadId: THREAD_ID,
                messageId: "msg-user-command-palette-content-search" as MessageId,
                role: "user",
                snippet: "…release codename deltafrogs is approved…",
                score: 0,
              },
            ],
            truncated: false,
          };
        }
        return undefined;
      },
    });

    try {
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await page.getByPlaceholder("Search threads, commands and settings").fill(searchQuery);
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.searchThreads &&
                request.query === searchQuery,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(palette.getByText(matchedThreadTitle, { exact: true }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByText("…release codename deltafrogs is approved…"))
        .toBeInTheDocument();
      await vi.waitFor(
        () => {
          const highlightedQuery = [...document.querySelectorAll("mark")].find(
            (element) => element.textContent === "release codename",
          );
          expect(highlightedQuery).toBeTruthy();
          expect(document.querySelector(".thread-search-title-match")?.textContent).toBe(
            "Release codename",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await palette.getByText(matchedThreadTitle, { exact: true }).click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.search).toMatchObject({
            sourceControl: "0",
            focusMessageId: "msg-user-command-palette-content-search",
            focusQuery: searchQuery,
          });
          const targetRow = document.querySelector<HTMLElement>(
            '[data-message-id="msg-user-command-palette-content-search"]',
          );
          expect(targetRow?.dataset.threadSearchTarget).toBe("true");
          expect(targetRow?.querySelector(".thread-search-inline-match")?.textContent).toBe(
            "Release codename",
          );
          const messageList = document.querySelector<HTMLElement>(
            '[data-chat-messages-list="true"]',
          );
          const targetBounds = targetRow?.getBoundingClientRect();
          const listBounds = messageList?.getBoundingClientRect();
          expect(targetBounds && listBounds && targetBounds.bottom > listBounds.top).toBe(true);
          expect(targetBounds && listBounds && targetBounds.top < listBounds.bottom).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps focused-search highlights visible inside boxed markdown text", async () => {
    const targetMessageId = "msg-assistant-boxed-search-match" as MessageId;
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-before-boxed-search-match" as MessageId,
      targetText: "show the boxed search match",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === ("msg-assistant-3" as MessageId)
            ? {
                ...message,
                id: targetMessageId,
                text: [
                  "Use `deltafrogs` as the inline value.",
                  "",
                  "```ts",
                  "const deltafrogs = true;",
                  "```",
                ].join("\n"),
              }
            : message,
        ),
      })),
    };
    const focusSearch = {
      sourceControl: "0" as const,
      focusMessageId: targetMessageId,
      focusQuery: "deltafrogs",
      focusRequest: "boxed-search-browser-test",
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: THREAD_ID,
        },
        search: focusSearch,
      });
      const getTargetRow = () =>
        document.querySelector<HTMLElement>(`[data-message-id="${targetMessageId}"]`);
      await vi.waitFor(
        () => {
          const currentTargetRow = getTargetRow();
          const inlineMatch = currentTargetRow?.querySelector<HTMLElement>(
            "p > code .thread-search-inline-match",
          );
          expect(inlineMatch?.textContent).toBe("deltafrogs");
          expect(currentTargetRow?.querySelector(".chat-markdown-shiki")).toBeTruthy();
          const messageList = document.querySelector<HTMLElement>(
            '[data-chat-messages-list="true"]',
          );
          const matchBounds = inlineMatch?.getBoundingClientRect();
          const listBounds = messageList?.getBoundingClientRect();
          expect(matchBounds && listBounds && matchBounds.top >= listBounds.top + 16).toBe(true);
          expect(matchBounds && listBounds && matchBounds.bottom <= listBounds.bottom - 16).toBe(
            true,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      const targetRow = getTargetRow();
      expect(targetRow).toBeTruthy();

      const getConnectedCodeHighlightRanges = (): Range[] => {
        const css = Reflect.get(globalThis, "CSS") as
          | { highlights?: { get: (name: string) => unknown } }
          | undefined;
        const highlight = css?.highlights?.get("threadlines-thread-search-match");
        return highlight
          ? [...(highlight as Iterable<Range>)].filter(
              (range) =>
                range.startContainer.isConnected &&
                range.startContainer.parentElement?.closest(".chat-markdown-codeblock") !== null,
            )
          : [];
      };
      await vi.waitFor(
        () => {
          expect(
            getConnectedCodeHighlightRanges().some(
              (range) => range.toString().toLowerCase() === "deltafrogs",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      const shiki = targetRow?.querySelector(".chat-markdown-shiki");
      const walker = shiki ? document.createTreeWalker(shiki, NodeFilter.SHOW_TEXT) : null;
      let boxedMatchTextNode: Text | null = null;
      for (let node = walker?.nextNode() ?? null; node; node = walker?.nextNode() ?? null) {
        if ((node as Text).data.includes("deltafrogs")) {
          boxedMatchTextNode = node as Text;
          break;
        }
      }
      expect(boxedMatchTextNode).toBeTruthy();
      boxedMatchTextNode?.replaceWith(boxedMatchTextNode.cloneNode(true));

      await vi.waitFor(
        () => {
          expect(
            getConnectedCodeHighlightRanges().some(
              (range) => range.toString().toLowerCase() === "deltafrogs",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("reveals the exact match near the top of an oversized message", async () => {
    const targetMessageId = "msg-user-oversized-search-match" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: [
        "deltafrogs appears at the top of this message.",
        ...Array.from({ length: 100 }, (_, index) => `Long message filler line ${index}.`),
      ].join("\n"),
    });
    const focusSearch = {
      sourceControl: "0" as const,
      focusMessageId: targetMessageId,
      focusQuery: "deltafrogs",
      focusRequest: "oversized-search-browser-test",
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: THREAD_ID,
        },
        search: focusSearch,
      });
      await vi.waitFor(
        () => {
          const targetRow = document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"]`,
          );
          const exactMatch = targetRow?.querySelector<HTMLElement>(".thread-search-inline-match");
          const messageList = document.querySelector<HTMLElement>(
            '[data-chat-messages-list="true"]',
          );
          const matchBounds = exactMatch?.getBoundingClientRect();
          const listBounds = messageList?.getBoundingClientRect();
          expect(exactMatch?.textContent).toBe("deltafrogs");
          expect(matchBounds && listBounds && matchBounds.top >= listBounds.top + 16).toBe(true);
          expect(matchBounds && listBounds && matchBounds.bottom <= listBounds.bottom - 16).toBe(
            true,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("reliably reveals a search match while switching to another thread", async () => {
    const secondThreadId = "thread-search-cross-thread-target" as ThreadId;
    const targetMessageId = "msg-user-cross-thread-search-match" as MessageId;
    const firstThreadSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-cross-thread-start" as MessageId,
      targetText: "the initially open thread",
    });
    const targetThreadSource = createSnapshotForTargetUser({
      targetMessageId,
      targetText: [
        "deltafrogs is near the top of the other thread.",
        ...Array.from({ length: 100 }, (_, index) => `Other thread filler line ${index}.`),
      ].join("\n"),
    });
    const targetThreadMessages = (targetThreadSource.threads[0]?.messages ?? []).map(
      (message, index) =>
        message.id === targetMessageId
          ? message
          : { ...message, id: `msg-cross-thread-filler-${index}` as MessageId },
    );
    const snapshotWithSecondThread = addThreadToSnapshot(firstThreadSnapshot, secondThreadId);
    const snapshot: OrchestrationReadModel = {
      ...snapshotWithSecondThread,
      threads: snapshotWithSecondThread.threads.map((thread) =>
        thread.id === secondThreadId
          ? {
              ...thread,
              title: "Cross-thread search target",
              messages: targetThreadMessages,
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) {
          await mounted.router.navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: LOCAL_ENVIRONMENT_ID,
              threadId: THREAD_ID,
            },
            search: { sourceControl: "0" },
          });
          await vi.waitFor(
            () => {
              expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
              expect(document.querySelector(`[data-message-id="${targetMessageId}"]`)).toBeNull();
            },
            { timeout: 8_000, interval: 16 },
          );
        }

        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }

        await mounted.router.navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: LOCAL_ENVIRONMENT_ID,
            threadId: secondThreadId,
          },
          search: {
            sourceControl: "0",
            focusMessageId: targetMessageId,
            focusQuery: "deltafrogs",
            focusRequest: `cross-thread-search-browser-test-${attempt}`,
          },
        });

        await vi.waitFor(
          () => {
            expect(mounted.router.state.location.pathname).toBe(serverThreadPath(secondThreadId));
            const targetRow = document.querySelector<HTMLElement>(
              `[data-message-id="${targetMessageId}"]`,
            );
            const exactMatch = targetRow?.querySelector<HTMLElement>(".thread-search-inline-match");
            const messageList = document.querySelector<HTMLElement>(
              '[data-chat-messages-list="true"]',
            );
            const composerEditor = document.querySelector<HTMLElement>(
              '[data-testid="composer-editor"]',
            );
            const matchBounds = exactMatch?.getBoundingClientRect();
            const listBounds = messageList?.getBoundingClientRect();
            expect(targetRow?.dataset.threadSearchTarget).toBe("true");
            expect(exactMatch?.textContent).toBe("deltafrogs");
            expect(
              document.activeElement === composerEditor ||
                Boolean(composerEditor?.matches(":focus-within")),
            ).toBe(false);
            expect(matchBounds && listBounds && matchBounds.top >= listBounds.top + 16).toBe(true);
            expect(matchBounds && listBounds && matchBounds.bottom <= listBounds.bottom - 16).toBe(
              true,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches projects by path and opens the latest thread for that project", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search threads, commands and settings").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
        "Route should have changed to the latest thread for the selected project.",
      );
      expect(nextPath).toBe(serverThreadPath("thread-secondary-project" as ThreadId));
      expect(
        useComposerDraftStore
          .getState()
          .getDraftThread(threadRefFor("thread-secondary-project" as ThreadId)),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from project search when no active project thread exists", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject({ includeSecondaryThread: false }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search threads, commands and settings").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the project search result.",
      );
      const nextDraftId = draftIdFromPath(nextPath);
      const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);
      expect(draftThread?.projectId).toBe(SECOND_PROJECT_ID);
      expect(draftThread?.envMode).toBe("worktree");

      // The new thread's composer keeps the keyboard once the palette is gone.
      await expect.element(palette).not.toBeInTheDocument();
      await vi.waitFor(() => {
        const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
        expect(editor).not.toBeNull();
        expect(document.activeElement).toBe(editor);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers New lead chat for the draft's project, not the first project", async () => {
    const capabilities = { repositoryIdentity: true, projectLead: true };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject({ includeSecondaryThread: false }),
      configureFixture: (nextFixture) => {
        // The first project already has its lead.
        nextFixture.snapshot = {
          ...nextFixture.snapshot,
          projects: nextFixture.snapshot.projects.map((project) =>
            project.id === PROJECT_ID ? { ...project, leadThreadId: THREAD_ID } : project,
          ),
        };
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
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();
      await page.getByPlaceholder("Search threads, commands and settings").fill("clients/docs");
      await palette.getByText("Docs Portal", { exact: true }).click();
      const draftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a draft in the second project.",
      );
      expect(
        useComposerDraftStore.getState().getDraftSession(draftIdFromPath(draftPath))?.projectId,
      ).toBe(SECOND_PROJECT_ID);
      await expect.element(palette).not.toBeInTheDocument();

      await openCommandPaletteFromTrigger();
      await page.getByPlaceholder("Search threads, commands and settings").fill("new lead");
      // Named for the draft's project; the first project's lead hides nothing.
      await expect.element(palette.getByText("New lead chat", { exact: true })).toBeInTheDocument();
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters archived threads out of command palette search results", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search threads, commands and settings").fill("docs-archive");
      await expect
        .element(palette.getByText("Archived Docs Notes", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedDraftId = draftIdFromPath(promotedThreadPath);
      const promotedThreadId = draftThreadIdFor(promotedDraftId);

      await promoteDraftThreadViaDomainEvent(promotedThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(promotedThreadId),
        "Promoted drafts should canonicalize to the server thread route before a fresh draft is created.",
      );
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(promotedDraftId)).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });
});
