import {
  ORCHESTRATION_WS_METHODS,
  MessageId,
  type OrchestrationReadModel,
  OutsideAgentConnectionId,
  OutsideAgentRequestId,
  ProviderInstanceId,
  type ThreadId,
  WS_METHODS,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";

import {
  THREAD_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  UUID_ROUTE_RE,
  ADD_PROJECT_SUBMENU_PLACEHOLDER,
  fixture,
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
  waitForCommandPaletteShortcutLabel,
  waitForCommandPaletteInput,
  selectLocalFolderAction,
  dispatchInputKey,
  mountChatView,
  registerChatViewSuiteHooks,
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
      await openCommandPaletteFromTrigger();
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

  it("shows an agent's sign-in over the thread to this computer's owner, and opens its group from the palette", async () => {
    const requestId = OutsideAgentRequestId.make("request-claude");
    setPrimarySessionRole("owner");
    setPrimaryOutsideAgentsSnapshot({
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
      quietUntil: null,
      assistants: { status: "off", address: null, code: null, signIns: [] },
    });
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
              access: "see",
              maxRuntimeMode: "approval-required",
              projectIds: null,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            }
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

      await openCommandPaletteFromTrigger();
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
      await openCommandPaletteFromTrigger();
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
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("settings");
      await expect.element(palette.getByText("Open settings", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a project-scoped Codex session browser and imports the selected conversation", async () => {
    const externalThreadsResult = {
      data: [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerThreadId: "native-codex-thread",
          sessionId: "native-codex-session",
          source: "cli" as const,
          name: "Finish parser migration",
          preview: "Finish the parser migration and verify its tests",
          cwd: "/repo/project",
          cliVersion: "0.145.0",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-03T12:00:00.000Z",
          status: "idle" as const,
          canImport: true,
        },
      ],
    };
    let resolveExternalThreads!: (value: typeof externalThreadsResult) => void;
    const externalThreadsPromise = new Promise<typeof externalThreadsResult>((resolve) => {
      resolveExternalThreads = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-external-codex-session" as MessageId,
        targetText: "external Codex session",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.6-sol",
                  name: "GPT-5.6 Sol",
                  isCustom: false,
                  isDefault: true,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.serverListExternalProviderThreads) {
          return externalThreadsPromise;
        }
        if (body._tag === WS_METHODS.serverImportExternalProviderThread) {
          return {
            threadId: (body as unknown as { readonly threadId: ThreadId }).threadId,
            importedMessageCount: 2,
          };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await openCommandPaletteFromTrigger();
      const palette = page.getByTestId("command-palette");
      await expect
        .element(palette.getByText("Bring in Codex conversation…", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Bring in Codex conversation…", { exact: true }).click();
      await waitForCommandPaletteInput("Search other Codex conversations in Project...");

      await expect
        .element(palette.getByTestId("command-palette-results-skeleton"))
        .toBeInTheDocument();
      resolveExternalThreads(externalThreadsResult);

      await expect
        .element(palette.getByText("Finish parser migration", { exact: true }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByTestId("command-palette-results-skeleton"))
        .not.toBeInTheDocument();
      await expect
        .element(palette.getByText("Codex CLI · Finish the parser migration and verify its tests"))
        .toBeInTheDocument();
      await palette.getByText("Finish parser migration", { exact: true }).click();

      await vi.waitFor(
        () => {
          const listRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.serverListExternalProviderThreads,
          );
          expect(listRequest).toMatchObject({
            providerInstanceId: "codex",
            cwd: "/repo/project",
            limit: 20,
          });
          const importRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.serverImportExternalProviderThread,
          );
          expect(importRequest).toMatchObject({
            providerInstanceId: "codex",
            providerThreadId: "native-codex-thread",
            projectId: PROJECT_ID,
            modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
            runtimeMode: "full-access",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
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

      await page.getByPlaceholder("Search commands, projects, and threads...").fill(searchQuery);
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

  it("adds a project from browse mode with Enter when no directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-enter" as MessageId,
        targetText: "command palette add project enter",
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
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await selectLocalFolderAction();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Enter.",
      );
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
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
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
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
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
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs-archive");
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
