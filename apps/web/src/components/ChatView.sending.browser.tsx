import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  type ServerSettings,
  ThreadParticipantId,
  WS_METHODS,
} from "@threadlines/contracts";
import { createModelCapabilities, createModelSelection } from "@threadlines/shared/model";
import * as Effect from "effect/Effect";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  composerContentsKey,
  recordFailedSend,
  retryFailedSend,
  type FailedSend,
} from "./chat/sendRetry";
import { applySettingsUpdated } from "../rpc/serverState";
import { useRoomRecipientStore } from "../rooms";
import { useTerminalStateStore } from "../terminalStateStore";

import {
  THREAD_ID,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_REF,
  THREAD_KEY,
  PROJECT_DRAFT_KEY,
  NOW_ISO,
  fixture,
  rpcHarness,
  wsRequests,
  encodeServerConfig,
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  waitForThreadDetailSubscription,
  draftIdFromPath,
  serverThreadPath,
  createDraftOnlySnapshot,
  withProjectScripts,
  withCodexModels,
  setDraftThreadWithoutWorktree,
  createSnapshotWithPendingUserInput,
  waitForLayout,
  waitForElement,
  waitForURL,
  waitForComposerEditor,
  waitForComposerMenuItem,
  pressComposerKey,
  waitForComposerText,
  setComposerSelectionByTextOffsets,
  waitForSendButton,
  findButtonByText,
  waitForButtonByText,
  waitForDraftBranchPicker,
  clickSelectItemContainingText,
  clickComboboxItemContainingText,
  waitForInteractionModeButton,
  mountChatView,
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

describe("ChatView (full app): first sends and worktree setup", () => {
  registerChatViewSuiteHooks();

  it("sends bootstrap turn-starts and waits for server setup on first-send worktree drafts", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
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
          branch: "main",
          worktreePath: null,
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
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                  runSetupScript?: boolean;
                };
              }
            | undefined;
          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^threadlines\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.vcsCreateWorktree)).toBe(
        false,
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite &&
            request.threadId === THREAD_ID &&
            request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("makes a New worktree draft's thread with its goal only after the worktree is cut", async () => {
    // The agent starts on an active goal at once, so the goal can't go to a
    // thread made beforehand in the project folder.
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
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/goa");
      await (await waitForComposerMenuItem("slash:goal")).click();
      await page.getByPlaceholder(/Objective for the agent/).fill("Get the flaky test green");
      await page.getByRole("button", { name: "Set goal" }).click();

      await vi.waitFor(
        () => {
          const dispatched = wsRequests.filter(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          );
          expect(dispatched.map((request) => request.type)).toEqual(["thread.goal.set"]);
          expect(dispatched[0]).toMatchObject({
            threadId: THREAD_ID,
            objective: "Get the flaky test green",
            bootstrap: {
              createThread: { projectId: PROJECT_ID, branch: "main", worktreePath: null },
              prepareWorktree: { projectCwd: "/repo/project", baseBranch: "main" },
              runSetupScript: true,
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts a new thread as a room from the model picker when the computer has Rooms on", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      // This device never turned Rooms on (a phone through phone link); the
      // computer it talks to did.
      configureFixture: (nextFixture) => {
        withCodexModels(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: { ...nextFixture.serverConfig.settings, enableRooms: true },
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });

    try {
      const picker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      picker.click();
      const addAgent = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-room-add-agent="true"]'),
        "The model picker should offer Add agent before the first message.",
      );
      addAgent.click();
      const model = await waitForElement(
        () => document.querySelector<HTMLElement>('.model-picker-list [role="option"]'),
        "Unable to find a model to add.",
      );
      model.click();
      const agents = () =>
        useComposerDraftStore.getState().draftThreadsByThreadKey[THREAD_KEY]?.room?.agents ?? [];
      await vi.waitFor(() => expect(agents()).toHaveLength(1), { timeout: 8_000, interval: 16 });
      const agentId = agents()[0]!.id;

      // The first message creates the thread with its agent, and goes to it.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Review the plan");
      await waitForLayout();
      const sendButton = await waitForSendButton();
      sendButton.click();
      await vi.waitFor(
        () => {
          const turnStart = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          );
          expect(turnStart).toMatchObject({
            participantId: agentId,
            bootstrap: {
              createThread: { participants: [expect.objectContaining({ id: agentId })] },
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
      await mounted.cleanup();
    }
  });

  it("names a new agent past a guest that reviewed on the same model", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-guest-name" as MessageId,
      targetText: "guest name",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      configureFixture: withCodexModels,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                // Brought in once for a review: never a member, but the
                // server keeps its name taken.
                participants: [
                  {
                    id: "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId,
                    handle: "gpt-6-astra",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-6-astra",
                    },
                    joinedAt: NOW_ISO,
                    leftAt: NOW_ISO,
                    guest: true,
                  },
                ],
              }
            : thread,
        ),
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });

    try {
      const picker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      picker.click();
      const addAgent = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-room-add-agent="true"]'),
        "Unable to find Add agent.",
      );
      addAgent.click();
      const astra = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>('.model-picker-list [role="option"]')].find(
            (option) => option.textContent?.includes("gpt-6-astra"),
          ) ?? null,
        "Unable to find gpt-6-astra to add.",
      );
      astra.click();
      await vi.waitFor(
        () => {
          const added = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.participant.add",
          ) as { participant?: { handle?: string } } | undefined;
          expect(added?.participant?.handle).toBe("gpt-6-astra 2");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
      await mounted.cleanup();
    }
  });

  it("uses the live Codex default when bootstrapping an unpinned local draft", async () => {
    setDraftThreadWithoutWorktree();
    const snapshot = createDraftOnlySnapshot();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) => ({
          ...project,
          defaultModelSelection: null,
        })),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.5",
                  name: "GPT-5.5",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
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
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Use the provider default");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                modelSelection?: { instanceId?: string; model?: string };
                bootstrap?: {
                  createThread?: {
                    modelSelection?: { instanceId?: string; model?: string };
                  };
                };
              }
            | undefined;

          expect(turnStartRequest?.modelSelection).toMatchObject({
            instanceId: "codex",
            model: "gpt-5.6-sol",
          });
          expect(turnStartRequest?.bootstrap?.createThread?.modelSelection).toMatchObject({
            instanceId: "codex",
            model: "gpt-5.6-sol",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  /**
   * Push one provider-auth event down the same subscription the composer
   * notice attaches to when it starts a sign-in.
   */
  function emitProviderAuthEvent(
    event:
      | { type: "command"; flow: string; command: string }
      | { type: "output"; data: string }
      | { type: "status"; status: string; exitCode: number | null; detail: string | null },
  ) {
    rpcHarness.emitStreamValue(WS_METHODS.providerAuthSubscribe, {
      instanceId: "codex",
      createdAt: new Date().toISOString(),
      ...event,
    });
  }

  async function mountSignedOutProviderSend(options: {
    /** Providers the recheck behind "I've signed in" resolves with. */
    refreshedProviders: (signedOut: ServerProvider) => ReadonlyArray<ServerProvider>;
  }) {
    setDraftThreadWithoutWorktree();
    let signedOutProvider: ServerProvider | null = null;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        signedOutProvider = {
          ...nextFixture.serverConfig.providers[0]!,
          status: "warning",
          auth: { status: "unauthenticated" },
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [signedOutProvider],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        // `providerAuth.start` succeeds with void; the harness's default `{}`
        // would fail the response decode and surface as a start error.
        if (body._tag === WS_METHODS.providerAuthStart) {
          return null;
        }
        if (body._tag === WS_METHODS.serverRefreshProviders) {
          return {
            providers: encodeServerConfig({
              ...fixture.serverConfig,
              providers: options.refreshedProviders(signedOutProvider!),
            }).providers,
          };
        }
        return undefined;
      },
    });

    const turnStartRequests = () =>
      wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.start",
      );

    useComposerDraftStore.getState().setPrompt(THREAD_REF, "Explain this repo");
    await waitForLayout();

    (await waitForSendButton()).click();

    const confirmSignedIn = await waitForButtonByText("I've signed in");
    // The turn never left the client, and the draft survived the interruption.
    expect(turnStartRequests()).toHaveLength(0);
    expect(document.body.textContent).toContain("Codex needs sign-in.");
    expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
      "Explain this repo",
    );

    const providerAuthStartRequests = () =>
      wsRequests.filter((request) => request._tag === WS_METHODS.providerAuthStart);

    return { confirmSignedIn, mounted, providerAuthStartRequests, turnStartRequests };
  }

  it("signs in from the held-send notice and releases the message without a second click", async () => {
    const { mounted, providerAuthStartRequests, turnStartRequests } =
      await mountSignedOutProviderSend({
        refreshedProviders: (signedOut) => [
          { ...signedOut, status: "ready", auth: { status: "authenticated" } },
        ],
      });

    try {
      (await waitForButtonByText("Sign in")).click();

      // The login runs in the server's own PTY, never in the thread's terminal.
      await vi.waitFor(
        () => {
          expect(providerAuthStartRequests()).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(providerAuthStartRequests()[0]).toMatchObject({ instanceId: "codex", flow: "login" });

      emitProviderAuthEvent({ type: "command", flow: "login", command: "codex login" });
      emitProviderAuthEvent({ type: "status", status: "running", exitCode: null, detail: null });
      emitProviderAuthEvent({ type: "output", data: "Opening browser to complete sign-in\r\n" });

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Signing in… Opening browser to complete sign-in",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      emitProviderAuthEvent({ type: "status", status: "succeeded", exitCode: 0, detail: null });

      await vi.waitFor(
        () => {
          expect(turnStartRequests()).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      // The success recheck is not a bypass, and it fires exactly once.
      await waitForLayout();
      expect(turnStartRequests()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the held message and shows the last line when the sign-in fails", async () => {
    const { mounted, providerAuthStartRequests, turnStartRequests } =
      await mountSignedOutProviderSend({
        refreshedProviders: (signedOut) => [signedOut],
      });

    try {
      (await waitForButtonByText("Sign in")).click();

      await vi.waitFor(
        () => {
          expect(providerAuthStartRequests()).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );

      emitProviderAuthEvent({ type: "command", flow: "login", command: "codex login" });
      emitProviderAuthEvent({ type: "status", status: "running", exitCode: null, detail: null });
      emitProviderAuthEvent({ type: "output", data: "error: could not reach auth.openai.com\r\n" });
      emitProviderAuthEvent({
        type: "status",
        status: "failed",
        exitCode: 1,
        detail: "codex login exited with code 1.",
      });

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Sign-in failed. codex login exited with code 1.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(turnStartRequests()).toHaveLength(0);
      // The action comes back so the user can try again, and the draft is intact.
      await expect.element(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "Explain this repo",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends the held message once the recheck behind I've signed in comes back clean", async () => {
    const { confirmSignedIn, mounted, turnStartRequests } = await mountSignedOutProviderSend({
      refreshedProviders: (signedOut) => [
        { ...signedOut, status: "ready", auth: { status: "authenticated" } },
      ],
    });

    try {
      confirmSignedIn.click();

      await vi.waitFor(
        () => {
          expect(turnStartRequests()).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      // The recheck is not a bypass: exactly one turn, through the normal gate.
      await waitForLayout();
      expect(turnStartRequests()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps holding the message when the recheck still reports a signed-out provider", async () => {
    const { confirmSignedIn, mounted, turnStartRequests } = await mountSignedOutProviderSend({
      refreshedProviders: (signedOut) => [signedOut],
    });

    try {
      confirmSignedIn.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Still signed out.");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(turnStartRequests()).toHaveLength(0);
      expect(document.body.textContent).toContain("The last sign-in did not complete.");
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "Explain this repo",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  /** A first send the server refuses, with the message back in the composer. */
  async function mountRefusedFirstSend(refusedTurnStarts = 1) {
    setDraftThreadWithoutWorktree();
    let turnStartsAnswered = 0;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (
          body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
          body.type !== "thread.turn.start"
        ) {
          return undefined;
        }
        turnStartsAnswered += 1;
        return turnStartsAnswered <= refusedTurnStarts
          ? Effect.fail(new OrchestrationDispatchCommandError({ message: "Not allowed." }))
          : { sequence: fixture.snapshot.snapshotSequence + 1 };
      },
    });
    const turnStarts = () =>
      wsRequests.flatMap((request) =>
        request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
        request.type === "thread.turn.start"
          ? [request as unknown as Record<string, unknown>]
          : [],
      );

    useComposerDraftStore.getState().setPrompt(THREAD_REF, "Explain this repo");
    await waitForLayout();
    (await waitForSendButton()).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't send the message"),
    );
    expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
      "Explain this repo",
    );
    return { mounted, turnStarts };
  }

  /**
   * The failed send a Retry would hold, as the failure path records it.
   * `chat` logs what the chat is asked to show while the retry goes.
   */
  function failedSendFor(first: Record<string, unknown>, chat: string[] = []): FailedSend {
    const { _tag: _ignored, ...command } = first;
    return {
      failureId: recordFailedSend(THREAD_KEY),
      threadKey: THREAD_KEY,
      environmentId: LOCAL_ENVIRONMENT_ID,
      command: command as unknown as FailedSend["command"],
      draftTarget: THREAD_REF,
      contents: composerContentsKey(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)),
      showSending: async () => {
        chat.push("going out");
        return () => chat.push("taken back");
      },
      onAccepted: vi.fn(),
    };
  }

  it("offers no Retry for a message the server refused", async () => {
    const { mounted } = await mountRefusedFirstSend();

    try {
      // A refusal is an answer: the message waits in the box, to change or send.
      await waitForLayout();
      expect(findButtonByText("Retry")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("retries the very command that failed, taking the message out of the box", async () => {
    const { mounted, turnStarts } = await mountRefusedFirstSend();
    const prompt = () =>
      useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "";

    try {
      const [first] = turnStarts();
      const chat: string[] = [];
      const failed = failedSendFor(first!, chat);
      const retrying = retryFailedSend(failed);
      // Out of the box while it goes, so Send can't send it a second time,
      // and the chat shows it going out, as a send does.
      expect(prompt()).toBe("");
      await expect(retrying).resolves.toEqual({ outcome: "sent" });
      expect(chat).toEqual(["going out"]);
      const [, second] = turnStarts();
      // Unchanged, id included: the server's receipt knows a repeat.
      expect(second).toEqual(first);
      expect(failed.onAccepted).toHaveBeenCalledOnce();
      // One retry per failure.
      await expect(retryFailedSend(failed)).resolves.toEqual({ outcome: "skipped" });
      expect(turnStarts()).toHaveLength(2);
      expect(chat).toEqual(["going out"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("puts the message back when the retry fails too", async () => {
    const { mounted, turnStarts } = await mountRefusedFirstSend(2);

    try {
      const [first] = turnStarts();
      const chat: string[] = [];
      const result = await retryFailedSend(failedSendFor(first!, chat));
      expect(result).toMatchObject({ outcome: "failed", latest: true });
      expect(chat).toEqual(["going out", "taken back"]);
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "Explain this repo",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("skips a retry once the message was edited, or a newer failure replaced it", async () => {
    const { mounted, turnStarts } = await mountRefusedFirstSend();

    try {
      const [first] = turnStarts();
      const chat: string[] = [];
      const older = failedSendFor(first!, chat);
      const latest = failedSendFor(first!, chat);
      await expect(retryFailedSend(older)).resolves.toEqual({ outcome: "skipped" });

      // An edit is the user's own next message: it stays, and nothing is sent.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Explain this repo, briefly");
      await expect(retryFailedSend(latest)).resolves.toEqual({ outcome: "skipped" });
      expect(turnStarts()).toHaveLength(1);
      // A retry that doesn't go shows nothing going out.
      expect(chat).toEqual([]);
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "Explain this repo, briefly",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps custom provider instance ids when bootstrapping a local draft thread", async () => {
    setDraftThreadWithoutWorktree();
    const openRouterInstanceId = ProviderInstanceId.make("claude_openrouter");
    const openRouterSelection = createModelSelection(openRouterInstanceId, "openai/gpt-5.5");
    useComposerDraftStore.getState().setModelSelection(THREAD_REF, openRouterSelection);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: ProviderInstanceId.make("claudeAgent"),
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: openRouterInstanceId,
              displayName: "Claude OpenRouter",
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
          settings: {
            ...nextFixture.serverConfig.settings,
            providerInstances: {
              ...nextFixture.serverConfig.settings.providerInstances,
              [openRouterInstanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude OpenRouter",
                config: { customModels: ["openai/gpt-5.5"] },
              },
            },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Hello there");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                modelSelection?: { instanceId?: string; model?: string };
                bootstrap?: {
                  createThread?: {
                    modelSelection?: { instanceId?: string; model?: string };
                  };
                };
              }
            | undefined;

          expect(turnStartRequest?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
          expect(turnStartRequest?.bootstrap?.createThread?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps new-worktree mode on empty server threads and bootstraps the first send", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
            ],
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
      (await waitForButtonByText("Current checkout")).click();
      await clickSelectItemContainingText("New worktree");

      await vi.waitFor(
        () => {
          expect(findButtonByText("New worktree")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                  runSetupScript?: boolean;
                };
              }
            | undefined;

          expect(turnStartRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^threadlines\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
          expect(turnStartRequest?.bootstrap?.createThread).toBeUndefined();
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.meta.update" &&
                "title" in request,
            ),
          ).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates the selected worktree base branch on empty server threads", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
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
      (await waitForButtonByText("Current checkout")).click();
      await clickSelectItemContainingText("New worktree");
      (await waitForButtonByText("From main")).click();
      await clickComboboxItemContainingText("release/next");

      await vi.waitFor(
        () => {
          expect(findButtonByText("From release/next")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  prepareWorktree?: { baseBranch?: string };
                };
              }
            | undefined;

          expect(turnStartRequest?.bootstrap?.prepareWorktree?.baseBranch).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a draft's base on the setting until the user picks one", async () => {
    // A local draft carrying its checkout's branch, as one opened from a
    // local thread does.
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
          branch: "main",
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });
    const settingsNaming = (base: ServerSettings["newWorktreeBase"]): ServerSettings => ({
      ...fixture.serverConfig.settings,
      newWorktreeBase: base,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            newWorktreeBase: { from: "named", branch: "develop" },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          const refs =
            body.query === "develop"
              ? [{ name: "develop", current: false, isDefault: false, worktreePath: null }]
              : [
                  { name: "main", current: true, isDefault: true, worktreePath: null },
                  { name: "release/next", current: false, isDefault: false, worktreePath: null },
                ];
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: refs.length,
            refs,
          };
        }
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });
    const draftBase = () => useComposerDraftStore.getState().draftThreadsByThreadKey[THREAD_KEY];

    try {
      const workspace = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="branch-toolbar-sentence"] [aria-label="Workspace"]',
          ),
        "Unable to find the workspace picker.",
      );
      workspace.click();
      await clickSelectItemContainingText("New worktree");
      await waitForDraftBranchPicker({ preposition: "from", branch: "develop" });

      // A changed setting moves a base nobody picked.
      applySettingsUpdated(settingsNaming({ from: "default", branch: "develop" }));
      const picker = await waitForDraftBranchPicker({ preposition: "from", branch: "main" });

      // A base the user picks stays when the setting changes again.
      picker.click();
      await clickComboboxItemContainingText("release/next");
      await waitForDraftBranchPicker({ preposition: "from", branch: "release/next" });
      applySettingsUpdated(settingsNaming({ from: "named", branch: "develop" }));
      await waitForLayout();
      await waitForDraftBranchPicker({ preposition: "from", branch: "release/next" });
      expect(draftBase()).toMatchObject({ branch: "release/next" });
      expect(draftBase()?.branchFromSetting).toBeUndefined();

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();
      (await waitForSendButton()).click();
      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as { bootstrap?: { prepareWorktree?: { baseBranch?: string } } } | undefined;
          expect(turnStartRequest?.bootstrap?.prepareWorktree?.baseBranch).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts a new worktree from the branch the computer's setting names", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            newWorktreeBase: { from: "named", branch: "develop" },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          // The unfiltered first page doesn't reach `develop`; only a search does.
          const refs =
            body.query === "develop"
              ? [{ name: "develop", current: false, isDefault: false, worktreePath: null }]
              : [{ name: "main", current: true, isDefault: true, worktreePath: null }];
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: refs.length,
            refs,
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
      (await waitForButtonByText("Current checkout")).click();
      await clickSelectItemContainingText("New worktree");

      await vi.waitFor(
        () => {
          expect(findButtonByText("From develop")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();
      (await waitForSendButton()).click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as { bootstrap?: { prepareWorktree?: { baseBranch?: string } } } | undefined;

          expect(turnStartRequest?.bootstrap?.prepareWorktree?.baseBranch).toBe("develop");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears pending worktree overrides when switching empty server threads", async () => {
    const secondThreadId = "thread-browser-test-second" as ThreadId;
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const snapshotWithSecondThread = addThreadToSnapshot(snapshot, secondThreadId);
    const snapshotWithTwoThreads = {
      ...snapshotWithSecondThread,
      threads: snapshotWithSecondThread.threads.map((thread) => {
        if (thread.id === THREAD_ID) {
          return Object.assign({}, thread, { session: null, title: "Thread alpha" });
        }
        if (thread.id === secondThreadId) {
          return Object.assign({}, thread, { session: null, title: "Thread beta" });
        }
        return thread;
      }),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithTwoThreads,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
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
      (await waitForButtonByText("Current checkout")).click();
      await clickSelectItemContainingText("New worktree");
      (await waitForButtonByText("From main")).click();
      await clickComboboxItemContainingText("release/next");

      await vi.waitFor(
        () => {
          expect(findButtonByText("From release/next")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: LOCAL_ENVIRONMENT_ID,
          threadId: secondThreadId,
        },
      });

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(secondThreadId),
        "Route should switch to the second empty server thread.",
      );

      await vi.waitFor(
        () => {
          expect(findButtonByText("Current checkout")).toBeTruthy();
          expect(findButtonByText("From release/next")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      (await waitForButtonByText("Current checkout")).click();
      await clickSelectItemContainingText("New worktree");

      await vi.waitFor(
        () => {
          expect(findButtonByText("From main")).toBeTruthy();
          expect(findButtonByText("From release/next")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  // The server cuts the worktree inside the bootstrap request, so that is the
  // window in which the user should read "Preparing worktree", not "Sending",
  // and the thread does not exist on the server yet: the chat still names the
  // agent the message went to, as it was sent.
  it.each([
    { to: "the thread's own agent", roomAgent: false, working: "Opus 4.7" },
    { to: "another agent in the room", roomAgent: true, working: "gpt-6-astra" },
  ])("shows the worktree preparation state for a first message to $to", async (testCase) => {
    const roomAgentId = ThreadParticipantId.make("5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f");
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
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
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
          ...(testCase.roomAgent
            ? {
                room: {
                  agents: [
                    {
                      id: roomAgentId,
                      handle: "GPT-6 Astra",
                      modelSelection: createModelSelection(
                        ProviderInstanceId.make("codex"),
                        "gpt-6-astra",
                      ),
                    },
                  ],
                },
              }
            : {}),
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });
    if (testCase.roomAgent) {
      useRoomRecipientStore.getState().choose(THREAD_REF, roomAgentId);
    }
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    useComposerDraftStore
      .getState()
      .setModelSelection(THREAD_REF, createModelSelection(claudeInstanceId, "claude-opus-4-7"));

    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // As main.tsx mounts it: React runs mount effects twice in development.
      strictMode: true,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: claudeInstanceId,
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({ optionDescriptors: [] }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
        };
      },
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
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return dispatchPromise;
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
          ).toBe(true);
          expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeTruthy();
          expect(document.querySelector('button[aria-label="Sending"]')).toBeNull();
          const workingLine = document.querySelector('[data-turn-working-anchor="true"]');
          expect(workingLine?.textContent).toContain(testCase.working);
          expect(workingLine?.textContent).not.toContain("gpt-5.6");
          // The pickers under the composer give way to what is being done.
          expect(document.querySelector('[data-testid="branch-toolbar-sentence"]')).toBeNull();
          expect(
            document.querySelector('[data-testid="branch-toolbar-preparing"]')?.textContent,
          ).toBe("Preparing a new worktree from main");
        },
        { timeout: 8_000, interval: 16 },
      );

      // A model picked while it waits is for the next message, not this one.
      useComposerDraftStore
        .getState()
        .setModelSelection(
          THREAD_REF,
          createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol"),
        );
      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[data-chat-provider-model-picker="true"]')?.textContent,
          ).not.toContain("Opus 4.7");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[data-turn-working-anchor="true"]')?.textContent).toContain(
        testCase.working,
      );

      // The chat view is rebuilt while it waits (another page and back, the
      // server taking the message meanwhile): the send still shows on its
      // thread, as it went out, until the thread's own state answers it.
      const threadPath = mounted.router.state.location.pathname;
      await mounted.router.navigate({ to: "/usage" });
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-turn-working-anchor="true"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
      await waitForLayout();
      await mounted.router.navigate({ to: threadPath });
      await vi.waitFor(
        () => {
          expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeTruthy();
          expect(
            document.querySelector('[data-testid="branch-toolbar-preparing"]')?.textContent,
          ).toBe("Preparing a new worktree from main");
          expect(
            document.querySelector('[data-turn-working-anchor="true"]')?.textContent,
          ).toContain(testCase.working);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
      resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "refreshes stale thread detail after an accepted send with async question %s",
    async (hasAsyncQuestion) => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: hasAsyncQuestion
          ? createSnapshotWithPendingUserInput({ isBlocking: false })
          : createSnapshotForTargetUser({
              targetMessageId: "msg-user-stale-send" as MessageId,
              targetText: "stale send",
            }),
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        await waitForThreadDetailSubscription(THREAD_ID);
        const initialSubscriptionCount = wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
            request.threadId === THREAD_ID,
        ).length;

        useComposerDraftStore.getState().setPrompt(THREAD_REF, "reconcile this send");
        const sendButton = await waitForSendButton();
        sendButton.click();

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) =>
                  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                  request.type === "thread.turn.start",
              ),
            ).toBe(true);
            expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        );

        await vi.waitFor(
          () => {
            expect(
              wsRequests.filter(
                (request) =>
                  request._tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
                  request.threadId === THREAD_ID,
              ).length,
            ).toBeGreaterThan(initialSubscriptionCount);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      await waitForInteractionModeButton("Build");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      await waitForInteractionModeButton("Build");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await waitForInteractionModeButton("Plan");

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await waitForInteractionModeButton("Build");
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active draft route session when changing the base branch", async () => {
    const staleDraftId = draftIdFromPath("/draft/draft-stale-branch-session");
    const activeDraftId = draftIdFromPath("/draft/draft-active-branch-session");

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [staleDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: `${PROJECT_DRAFT_KEY}:stale`,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
        [activeDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [`${PROJECT_DRAFT_KEY}:stale`]: staleDraftId,
        [PROJECT_DRAFT_KEY]: activeDraftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${activeDraftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForDraftBranchPicker({ preposition: "from", branch: "main" });
      branchButton.click();

      await clickComboboxItemContainingText("release/next");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
            "release/next",
          );
          expect(useComposerDraftStore.getState().getDraftSession(staleDraftId)?.branch).toBe(
            "main",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForDraftBranchPicker({ preposition: "from", branch: "release/next" });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new worktree branch picker anchored at the top when opening with a preselected branch", async () => {
    const draftId = DraftId.make("draft-branch-picker-scroll-regression");
    const branches = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        name: `feature/${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
      {
        name: "feature/selected",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

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
          branch: "feature/selected",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            refs: branches,
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForDraftBranchPicker({
        preposition: "from",
        branch: "feature/selected",
      });
      branchButton.click();

      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the branch picker popup.",
      );

      await vi.waitFor(
        () => {
          const popupSpans = Array.from(popup.querySelectorAll("span"));
          expect(
            popupSpans.some((element) => element.textContent?.trim() === "feature/current"),
          ).toBe(true);
          expect(popupSpans.some((element) => element.textContent?.trim() === "main")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds selected plain text and preserves the inner selection for repeated wrapping", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-basic" as MessageId,
        targetText: "surround basic",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({ start: 0, end: "selected".length });
      await pressComposerKey("(");
      await waitForComposerText("(selected)");

      await pressComposerKey("[");
      await waitForComposerText("([selected])");
    } finally {
      await mounted.cleanup();
    }
  });
});
