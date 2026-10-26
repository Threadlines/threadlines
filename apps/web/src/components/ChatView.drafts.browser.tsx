import { MessageId, ProviderInstanceId, WS_METHODS, type ThreadId } from "@threadlines/contracts";
import { createModelSelection } from "@threadlines/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  readPrimaryEnvironmentDescriptor,
  updatePrimaryEnvironmentDescriptor,
} from "../environments/primary";

import {
  THREAD_ID,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  UUID_ROUTE_RE,
  PROJECT_DRAFT_KEY,
  NOW_ISO,
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  waitForThreadDetailSubscription,
  composerDraftFor,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  materializePromotedDraftThreadViaDomainEvent,
  setPromotedServerThreadRunningViaDomainEvent,
  addPromotedServerUserMessageViaDomainEvent,
  emitPromotedServerUserMessageDetailEvent,
  startPromotedServerTurnViaDomainEvent,
  promoteDraftThreadViaDomainEvent,
  createProjectlessSnapshot,
  createSnapshotWithLongProposedPlan,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  waitForServerConfigToApply,
  CHAT_FIND_KEYBINDING,
  pressChatFindShortcut,
  dispatchChatNewShortcut,
  triggerChatNewShortcutUntilPath,
  openCommandPaletteFromTrigger,
  waitForNewThreadShortcutLabel,
  waitForCommandPaletteShortcutLabel,
  mountChatView,
  registerChatViewSuiteHooks,
  wsRequests,
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

describe("ChatView (full app): new threads and drafts", () => {
  registerChatViewSuiteHooks();

  it("canonicalizes promoted draft threads to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // `thread.created` should only mark the draft as promoting; it should
      // not navigate away until the server projection has real turn activity.
      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // Runtime/session state can arrive before the server message detail.
      // Keep the draft view mounted so the optimistic user message is not lost.
      await setPromotedServerThreadRunningViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // The server user message can arrive before the provider turn record.
      // Keep the draft view mounted so the optimistic working timer stays visible.
      await addPromotedServerUserMessageViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // Once the shell confirms real turn activity, the route should canonicalize.
      await startPromotedServerTurnViaDomainEvent(newThreadId);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftThreadsByThreadKey[newDraftId]).toBe(
            undefined,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // The route should switch to the canonical server thread path.
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Promoted drafts should canonicalize to the server thread route.",
      );

      // The composer should remain usable after canonicalization, regardless of
      // whether the promoted thread is still visibly empty or has already
      // entered the running state.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps promoted draft messages visible after switching away before turn activity arrives", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-switch-test" as MessageId,
        targetText: "draft switch test",
      }),
    });

    try {
      const newDraftId = DraftId.make("draft-promoted-switch");
      const newThreadId = "thread-promoted-switch" as ThreadId;
      const newThreadPath = `/draft/${newDraftId}`;
      useComposerDraftStore.setState({
        draftThreadsByThreadKey: {
          [newDraftId]: {
            threadId: newThreadId,
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
          [PROJECT_DRAFT_KEY]: newDraftId,
        },
      });
      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "Route should have changed to the promoted draft.",
      );

      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      await setPromotedServerThreadRunningViaDomainEvent(newThreadId);
      await waitForThreadDetailSubscription(newThreadId);

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: THREAD_ID,
        },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "Route should have changed to the existing thread.",
      );

      await addPromotedServerUserMessageViaDomainEvent(newThreadId);
      emitPromotedServerUserMessageDetailEvent(newThreadId);

      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByText("promoted draft user message")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes stale promoted draft routes to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-hydration-race-test" as MessageId,
        targetText: "draft hydration race test",
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
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      await promoteDraftThreadViaDomainEvent(newThreadId);

      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Stale promoted draft routes should canonicalize to the server thread path.",
      );

      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh worktree draft from an existing worktree thread when the default mode is worktree", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }),
        threads: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }).threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                branch: "feature/existing",
                worktreePath: "/repo/.threadlines/worktrees/existing",
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to a new draft thread.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(useComposerDraftStore.getState().getDraftSession(newDraftId)).toMatchObject({
        envMode: "worktree",
        worktreePath: null,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("fetches a new thread's upstream once a server that just started says it can", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-upstream-test" as MessageId,
        targetText: "new thread upstream test",
      }),
    });
    const asked = () =>
      wsRequests.filter((request) => request._tag === WS_METHODS.vcsRefreshRemoteStatus).length;

    try {
      await page.getByTestId("new-thread-button").click();
      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to a new draft thread.",
      );
      // The server has not said it takes the request yet, as right after it starts.
      expect(asked()).toBe(0);

      const descriptor = readPrimaryEnvironmentDescriptor();
      expect(descriptor).not.toBeNull();
      updatePrimaryEnvironmentDescriptor({
        ...descriptor!,
        capabilities: { ...descriptor!.capabilities, remoteStatusRefresh: true },
      });

      await vi.waitFor(() => expect(asked()).toBe(1), { timeout: 8_000, interval: 16 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new draft instead of reusing a promoting draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoting-draft-new-thread-test" as MessageId,
        targetText: "promoting draft new thread test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const firstDraftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should change to the first draft thread.",
      );
      const firstDraftId = draftIdFromPath(firstDraftPath);
      const firstThreadId = draftThreadIdFor(firstDraftId);

      await materializePromotedDraftThreadViaDomainEvent(firstThreadId);
      expect(mounted.router.state.location.pathname).toBe(firstDraftPath);

      await newThreadButton.click();

      const secondDraftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== firstDraftPath,
        "Route should change to a second draft thread instead of reusing the promoting draft.",
      );
      expect(draftIdFromPath(secondDraftPath)).not.toBe(firstDraftId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("claudeAgent")]: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("claudeAgent"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
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
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(useComposerDraftStore.getState().getDraftSession(newDraftId)?.runtimeMode).toBe(
        "auto",
      );
      expect(composerDraftFor(newDraftId)).toBe(undefined);
    } finally {
      await mounted.cleanup();
    }
  });

  it("resets a reused empty draft to the sticky last-used selection", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const draftId = draftIdFromPath(threadPath);

      // See the note on the sibling sticky-codex test: arrays match strictly
      // under `toMatchObject`, so use `arrayContaining` to keep the assertion
      // scoped to the sticky trait (`fastMode`) that must carry over.
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(
        draftId,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ]),
      );

      await newThreadButton.click();

      await waitForURL(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      // Reusing the empty draft is still a request for a NEW thread, so it
      // comes back on the sticky last-used selection rather than whatever
      // model the abandoned draft happened to be left on. (Any real model
      // pick writes sticky too, so nothing the user chose is lost.)
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  // The open thread is on the project's own checkout; Start in still decides.
  it("creates a new thread from the global chat.new shortcut, where Start in says", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
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
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
      expect(
        useComposerDraftStore.getState().getDraftSession(draftIdFromPath(newThreadPath)),
      ).toMatchObject({ envMode: "worktree", worktreePath: null });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not consume chat.new when there is no project context", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
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
      await waitForServerConfigToApply();
      dispatchChatNewShortcut();
      await waitForLayout();

      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the configurable shortcut and runs a command from the sidebar trigger", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-shortcut-test" as MessageId,
        targetText: "command palette shortcut test",
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
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("New thread in Project", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the command palette.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens find in chat from the composer with its shortcut, and gives focus back", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-find-in-chat-test" as MessageId,
        targetText: "the zeppelin question",
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
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const input = await vi.waitFor(() => {
        pressChatFindShortcut(composerEditor);
        const field = document.querySelector<HTMLInputElement>('[data-testid="chat-find-input"]');
        expect(field).not.toBeNull();
        return field!;
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(input));

      await userEvent.fill(page.getByTestId("chat-find-input"), "zeppelin");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="chat-find-tally"]')?.textContent).toBe(
          "1 of 1",
        );
        expect(
          document.querySelector('[data-message-id="msg-user-find-in-chat-test"]'),
        ).not.toBeNull();
      });

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="chat-find-bar"]')).toBeNull();
        expect(document.activeElement).toBe(composerEditor);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
