import {
  ChildRequestBatchId,
  ChildRequestId,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  EventId,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
  type EnvironmentApi,
  MessageId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type ProjectId,
  ProviderInstanceId,
  type RoomAgentRequestId,
  type SideTurnId,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { updateSettings } from "../hooks/useSettings";
import { useRoomRecipientStore } from "../rooms";
import {
  makeBrowserTab,
  registerPreviewWebview,
  resetPreviewWebviewsForTests,
  useBrowserPanelStore,
} from "../browserPanelStore";
import { selectLivePageState, useBrowserLiveStore } from "../browserLiveStore";
import { answerBrowserApproval } from "./browser/browserApprovalRequests";
import {
  readPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { getClientSettings } from "../hooks/useSettings";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";

import {
  THREAD_ID,
  LOCAL_ENVIRONMENT_ID,
  BrowserHostHarness,
  THREAD_REF,
  THREAD_KEY,
  NOW_ISO,
  wsRequests,
  DEFAULT_VIEWPORT,
  PHONE_VIEWPORT,
  markThreadDoneInTest,
  isoAt,
  createMockEnvironmentApi,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  withCodexModels,
  waitForElement,
  findVisibleComposerFooter,
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

describe("ChatView (full app): agent browser tabs and rooms", () => {
  registerChatViewSuiteHooks();

  it("tells the agent its tab was closed instead of acting on the user's tab", async () => {
    const userTab = { ...makeBrowserTab(), url: "http://localhost:5173/mine" };
    const agentTab = { ...makeBrowserTab(), url: "http://localhost:5173/agent" };
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {
        [THREAD_KEY]: { open: true, tabs: [userTab, agentTab], activeTabId: userTab.id },
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
    const clickedOn: number[] = [];
    window.desktopBridge = {
      previewStatus: () =>
        Promise.resolve({ url: "http://localhost:5173/", title: "Preview", loading: false }),
      previewClick: (input: { webContentsId: number }) => {
        clickedOn.push(input.webContentsId);
        return Promise.resolve({ x: 1, y: 1 });
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;
    for (const [tab, webContentsId] of [
      [userTab, 42],
      [agentTab, 43],
    ] as const) {
      registerPreviewWebview(THREAD_REF, tab.id, {
        getWebContentsId: () => webContentsId,
        loadURL: () => Promise.resolve(),
        getBoundingClientRect: () => ({ width: 900, height: 600 }) as DOMRect,
      });
    }

    const screen = await render(<BrowserHostHarness threadRef={THREAD_REF} />);

    try {
      await vi.waitFor(
        () => {
          expect(deliver, "the host should register with the broker").not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
      deliver!({
        requestId: "req-pin",
        agentId: "agent-browser",
        operation: "selectTab",
        input: { tabId: agentTab.id, background: true },
      } as unknown as PreviewAutomationRequest);
      await vi.waitFor(() => expect(responses).toHaveLength(1), { timeout: 4_000, interval: 16 });

      // The user closes the agent's tab between two of its calls.
      useBrowserPanelStore.getState().closeTab(THREAD_REF, agentTab.id);
      deliver!({
        requestId: "req-click-after-close",
        agentId: "agent-browser",
        operation: "click",
        input: { target: { ref: "e1" } },
      } as unknown as PreviewAutomationRequest);

      await vi.waitFor(
        () => {
          expect(responses).toHaveLength(2);
          expect(responses[1]?.error).toContain("was closed");
        },
        { timeout: 4_000, interval: 16 },
      );
      // Looking at the tabs and trying again must not quietly adopt the
      // user's tab either: only choosing or opening one does.
      deliver!({
        requestId: "req-tabs-after-close",
        agentId: "agent-browser",
        operation: "tabs",
        input: {},
      } as unknown as PreviewAutomationRequest);
      await vi.waitFor(() => expect(responses).toHaveLength(3), { timeout: 4_000, interval: 16 });
      deliver!({
        requestId: "req-click-again",
        agentId: "agent-browser",
        operation: "click",
        input: { target: { ref: "e1" } },
      } as unknown as PreviewAutomationRequest);
      await vi.waitFor(
        () => {
          expect(responses).toHaveLength(4);
          expect(responses[3]?.error).toContain("was closed");
        },
        { timeout: 4_000, interval: 16 },
      );
      // Nothing reached the page the user still has open.
      expect(clickedOn).toEqual([]);
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

  it("holds an agent's visit to a new site until the user answers, then carries on", async () => {
    const tab = { ...makeBrowserTab(), url: "http://localhost:5173/" };
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {
        [THREAD_KEY]: { open: true, tabs: [tab], activeTabId: tab.id },
      },
      agentStateByThreadKey: {},
      browserOwnershipByThreadKey: {},
      pendingApprovalsByThreadKey: {},
    });
    const projectId = "project-browser-sites" as ProjectId;
    const previousDescriptor = readPrimaryEnvironmentDescriptor();
    // A server new enough to let a request wait on the user.
    writePrimaryEnvironmentDescriptor({
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: "This computer",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, browserApprovalWait: true },
    });

    let deliver: ((request: PreviewAutomationRequest) => void) | null = null;
    const responses: PreviewAutomationResponse[] = [];
    const progress: unknown[] = [];
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
          progress: (update: unknown) => {
            progress.push(update);
            return Promise.resolve();
          },
        } as unknown as EnvironmentApi["previewAutomation"],
      }),
    );
    const loaded: string[] = [];
    window.desktopBridge = {
      previewStatus: () =>
        Promise.resolve({ url: "https://example.com/", title: "Example", loading: false }),
      previewSetNavigationPolicy: () => Promise.resolve(),
    } as unknown as NonNullable<typeof window.desktopBridge>;
    registerPreviewWebview(THREAD_REF, tab.id, {
      getWebContentsId: () => 42,
      loadURL: (url: string) => {
        loaded.push(url);
        return Promise.resolve();
      },
      getBoundingClientRect: () => ({ width: 900, height: 600 }) as DOMRect,
    });
    const pendingFor = () =>
      useBrowserPanelStore.getState().pendingApprovalsByThreadKey[THREAD_KEY] ?? [];

    const screen = await render(
      <BrowserHostHarness threadRef={THREAD_REF} projectId={projectId} />,
    );

    try {
      await vi.waitFor(() => expect(deliver).not.toBeNull(), { timeout: 4_000, interval: 16 });

      // Turned down: the agent hears no, and nothing loads.
      deliver!({
        requestId: "req-declined",
        agentId: "agent-site-access",
        operation: "navigate",
        input: { url: "https://news.example.org/" },
      } as unknown as PreviewAutomationRequest);
      await vi.waitFor(() => expect(pendingFor()).toHaveLength(1), {
        timeout: 4_000,
        interval: 16,
      });
      expect(progress).toEqual([{ requestId: "req-declined", awaitingUser: true }]);
      answerBrowserApproval(THREAD_REF, pendingFor()[0]!, "decline");
      await vi.waitFor(() => expect(responses[0]?.error).toContain("chose not"), {
        timeout: 4_000,
        interval: 16,
      });

      // Allowed: the same request loads the page itself, once, and the site is
      // remembered for the project.
      deliver!({
        requestId: "req-allowed",
        agentId: "agent-site-access",
        operation: "navigate",
        input: { url: "https://example.com/" },
      } as unknown as PreviewAutomationRequest);
      await vi.waitFor(() => expect(pendingFor()).toHaveLength(1), {
        timeout: 4_000,
        interval: 16,
      });
      expect(loaded).toEqual([]);
      answerBrowserApproval(THREAD_REF, pendingFor()[0]!, "allowSite");
      await vi.waitFor(
        () => {
          expect(responses).toHaveLength(2);
          expect(responses[1]?.error).toBeUndefined();
        },
        { timeout: 4_000, interval: 16 },
      );
      expect(loaded).toEqual(["https://example.com/"]);
      expect(pendingFor()).toEqual([]);
      expect(getClientSettings().agentBrowserApprovedDomains[projectId]).toEqual(["example.com"]);
    } finally {
      screen.unmount();
      resetPreviewWebviewsForTests();
      writePrimaryEnvironmentDescriptor(previousDescriptor);
      updateSettings({ agentBrowserApprovedDomains: {} });
      useBrowserPanelStore.setState({
        browserStateByThreadKey: {},
        agentStateByThreadKey: {},
        browserOwnershipByThreadKey: {},
        pendingApprovalsByThreadKey: {},
      });
      Reflect.deleteProperty(window, "desktopBridge");
      __resetEnvironmentApiOverridesForTests();
    }
  });

  it("answers an agent in a thread nobody is looking at, painting the page it works on", async () => {
    const tab = { ...makeBrowserTab(), url: "http://localhost:5173/" };
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {
        [THREAD_KEY]: { open: true, tabs: [tab], activeTabId: tab.id },
      },
      agentStateByThreadKey: {},
      browserOwnershipByThreadKey: {},
      pendingApprovalsByThreadKey: {},
    });
    let deliver: ((message: unknown) => void) | null = null;
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
          connectClient: (_input: unknown, listener: (message: unknown) => void) => {
            deliver = listener;
            return () => {
              deliver = null;
            };
          },
          respond: (response: PreviewAutomationResponse) => {
            responses.push(response);
            return Promise.resolve();
          },
          progress: () => Promise.resolve(),
        } as unknown as EnvironmentApi["previewAutomation"],
      }),
    );
    const clickedOn: number[] = [];
    window.desktopBridge = {
      previewStatus: () =>
        Promise.resolve({ url: "http://localhost:5173/", title: "Preview", loading: false }),
      previewClick: (input: { webContentsId: number }) => {
        clickedOn.push(input.webContentsId);
        return Promise.resolve({ x: 1, y: 1 });
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;
    registerPreviewWebview(THREAD_REF, tab.id, {
      getWebContentsId: () => 42,
      loadURL: () => Promise.resolve(),
      getBoundingClientRect: () => ({ width: 900, height: 600 }) as DOMRect,
    });

    const screen = await render(
      <BrowserHostHarness threadRef={THREAD_REF} clientHosts shown={false} />,
    );

    try {
      await vi.waitFor(() => expect(deliver).not.toBeNull(), { timeout: 4_000, interval: 16 });
      deliver!({
        requestId: "req-background",
        threadId: THREAD_ID,
        agentId: "agent-background",
        operation: "click",
        input: { target: { ref: "e1" } },
      });
      await vi.waitFor(
        () => {
          expect(responses).toHaveLength(1);
          expect(responses[0]?.error).toBeUndefined();
        },
        { timeout: 4_000, interval: 16 },
      );
      expect(clickedOn).toEqual([42]);
      // Off screen, the page is painted while the agent uses it, so a
      // screenshot of it can return.
      expect(
        selectLivePageState(useBrowserLiveStore.getState().pageStateByThreadKey, THREAD_REF, tab.id)
          .drawn,
      ).toBe(true);

      // A visit waiting on the user's answer when the user opens this thread's
      // browser on another computer: the question goes and nothing loads here.
      const previousDescriptor = readPrimaryEnvironmentDescriptor();
      writePrimaryEnvironmentDescriptor({
        environmentId: LOCAL_ENVIRONMENT_ID,
        label: "This computer",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true, browserApprovalWait: true },
      });
      deliver!({
        requestId: "req-background-visit",
        threadId: THREAD_ID,
        agentId: "agent-background",
        operation: "navigate",
        input: { url: "https://example.com/" },
      });
      await vi.waitFor(
        () =>
          expect(
            useBrowserPanelStore.getState().pendingApprovalsByThreadKey[THREAD_KEY] ?? [],
          ).toHaveLength(1),
        { timeout: 4_000, interval: 16 },
      );

      // The user opened this thread's browser on another computer: its pages
      // here close, and its tabs stay.
      deliver!({ _tag: "release", threadId: THREAD_ID });
      await vi.waitFor(
        () =>
          expect(
            useBrowserPanelStore.getState().pendingApprovalsByThreadKey[THREAD_KEY] ?? [],
          ).toEqual([]),
        { timeout: 4_000, interval: 16 },
      );
      // The broker already answered the agent; nothing more is sent from here.
      expect(responses).toHaveLength(1);
      writePrimaryEnvironmentDescriptor(previousDescriptor);
      expect(useBrowserLiveStore.getState().liveByThreadKey[THREAD_KEY]).toBeUndefined();
      expect(
        useBrowserPanelStore.getState().browserStateByThreadKey[THREAD_KEY]?.tabs,
      ).toHaveLength(1);
    } finally {
      screen.unmount();
      resetPreviewWebviewsForTests();
      useBrowserPanelStore.setState({
        browserStateByThreadKey: {},
        agentStateByThreadKey: {},
        browserOwnershipByThreadKey: {},
        pendingApprovalsByThreadKey: {},
      });
      Reflect.deleteProperty(window, "desktopBridge");
      __resetEnvironmentApiOverridesForTests();
    }
  });

  it("pins the search chrome above the scrolling list", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-search" as MessageId,
        targetText: "sticky search target",
      }),
    });

    try {
      const trigger = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="command-palette-trigger"]'),
        "Unable to find the search trigger.",
      );
      const row = await waitForElement(
        () => document.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`),
        "Unable to find a thread row.",
      );
      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');

      expect(viewport, "the sidebar list should scroll in its own viewport").not.toBeNull();
      // The list scrolls inside the viewport; the search row is not in it, so
      // it cannot scroll away.
      expect(viewport!.contains(row)).toBe(true);
      expect(viewport!.contains(trigger)).toBe(false);
      expect(trigger.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        viewport!.getBoundingClientRect().top + 1,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the context window of the room agent a message is going to", async () => {
    const astraId = "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-room-context" as MessageId,
      targetText: "room context target",
    });
    const reading = (
      id: string,
      usedTokens: number,
      at: number,
      participantId?: ThreadParticipantId,
    ) => ({
      id: EventId.make(id),
      tone: "info" as const,
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 128_000 },
      turnId: `turn-${id}` as TurnId,
      ...(participantId !== undefined ? { participantId } : {}),
      createdAt: isoAt(at),
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
                participants: [
                  {
                    id: astraId,
                    handle: "agent-2",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-6-astra",
                    },
                    joinedAt: NOW_ISO,
                    leftAt: null,
                  },
                ],
                // The thread's own agent's reading, then astra's, the latest.
                activities: [reading("own", 32_000, 200), reading("astra", 64_000, 210, astraId)],
              }
            : thread,
        ),
      },
    });

    try {
      const meterLabel = () =>
        document
          .querySelector<HTMLElement>('button[aria-label^="Context window"]')
          ?.getAttribute("aria-label") ?? "";
      await vi.waitFor(() => expect(meterLabel()).toMatch(/^Context window 25(\.0)?% used/), {
        timeout: 8_000,
        interval: 16,
      });

      // Sending to astra: the meter shows astra's own context.
      const picker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      picker.click();
      const astraOption = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>("[data-room-agent-row]")].find((option) =>
            option.textContent?.includes("gpt-6-astra"),
          ) ?? null,
        "Unable to find astra among the model picker's agents.",
      );
      astraOption.click();
      await vi.waitFor(() => expect(meterLabel()).toMatch(/^Context window 50(\.0)?% used/), {
        timeout: 8_000,
        interval: 16,
      });
      // The model list now belongs to astra: a pick moves it, so it says so,
      // and no number shortcut can move it by accident.
      picker.click();
      await waitForElement(
        () => document.querySelector('[data-model-row-action="switch"]'),
        "The model list should offer to switch the added agent's model.",
      );
      expect(document.querySelector(".model-picker-list kbd")).toBeNull();
    } finally {
      // The choice outlives the view; later tests start from the thread's own agent.
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
      await mounted.cleanup();
    }
  });

  it("asks the user about an agent's invite above the message box, and sends the answer", async () => {
    const guestId = "5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f" as ThreadParticipantId;
    const requestId = "invite-request-1" as RoomAgentRequestId;
    const inviteMessageId = "msg-invite-1" as MessageId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-invite" as MessageId,
      targetText: "invite target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // The invited model offers reasoning levels, and the invite names one.
      configureFixture: (nextFixture) => {
        const [codexProvider] = nextFixture.serverConfig.providers;
        if (!codexProvider) return;
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              ...codexProvider,
              models: [
                ...codexProvider.models,
                {
                  slug: "gpt-6-astra",
                  name: "GPT-6 Astra",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select" as const,
                        options: [
                          { id: "medium", label: "Medium", isDefault: true },
                          { id: "xhigh", label: "Extra High" },
                        ],
                      },
                    ],
                  }),
                },
              ],
            },
            ...nextFixture.serverConfig.providers.slice(1),
          ],
        };
      },
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                participants: [
                  {
                    id: guestId,
                    handle: "GPT-6 Astra",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-6-astra",
                      options: [{ id: "reasoningEffort", value: "xhigh" }],
                    },
                    joinedAt: NOW_ISO,
                    leftAt: NOW_ISO,
                    guest: true,
                  },
                ],
                messages: [
                  ...thread.messages,
                  {
                    id: inviteMessageId,
                    role: "user" as const,
                    text: "Check the retry math.",
                    participantId: guestId,
                    fromAgent: { participantId: null },
                    requestId,
                    requestKind: "invite" as const,
                    invite: {
                      reason: "A second model should check the backoff.",
                      suggestion: "review" as const,
                      billing: {
                        instanceId: ProviderInstanceId.make("codex"),
                        label: "Codex · ChatGPT Pro",
                        perUse: false,
                      },
                    },
                    turnId: null,
                    streaming: false,
                    createdAt: isoAt(300),
                    updatedAt: isoAt(300),
                  },
                ],
                agentRequests: {
                  ...EMPTY_AGENT_REQUEST_STATE,
                  requestsSinceUser: 1,
                  open: [
                    {
                      requestId,
                      kind: "invite" as const,
                      from: { participantId: null },
                      to: { participantId: guestId },
                      callerTurnId: "turn-invite" as TurnId,
                      chainEpoch: 0,
                      status: "awaiting_user" as const,
                      requestMessageId: inviteMessageId,
                      sideTurnId: "0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f01" as SideTurnId,
                      createdAt: isoAt(300),
                    },
                  ],
                },
              }
            : thread,
        ),
      },
    });

    try {
      const panel = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="agent-invite-panel"]'),
        "Unable to find the invite card.",
      );
      expect(panel.textContent).toContain("A second model should check the backoff.");
      // What the user is agreeing to pay for: the level, then who bills it.
      await vi.waitFor(() =>
        expect(panel.textContent).toContain("Extra High reasoning · Codex · ChatGPT Pro"),
      );
      // Not a room yet: saying yes to a teammate is said to end revert.
      expect(panel.textContent).toContain("revert turns off for good");
      expect(
        document.querySelector('[data-room-agent-message="invite"] [data-room-invite-status]')
          ?.textContent,
      ).toBe("wants a review, waiting for you");

      const reviewOnly = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Review only",
      );
      reviewOnly?.click();
      await vi.waitFor(
        () =>
          expect(
            wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                (request as { type?: string }).type === "thread.agent-invite.respond",
            ),
          ).toMatchObject({ requestId, choice: "review" }),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks before an agent starts threads, and names the thread whose answer came back", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-child-threads" as MessageId,
      targetText: "child threads target",
    });
    const childThreadId = "thread-child-changelog" as ThreadId;
    const batchId = ChildRequestBatchId.make("batch-1");
    const parentThread = base.threads.find((thread) => thread.id === THREAD_ID)!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // The thread for the linked computer runs on a model with reasoning levels.
      configureFixture: (nextFixture) => {
        const [codexProvider] = nextFixture.serverConfig.providers;
        if (!codexProvider) return;
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            {
              ...codexProvider,
              models: [
                ...codexProvider.models,
                {
                  slug: "gpt-6.1-sol",
                  name: "GPT-6.1 Sol",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select" as const,
                        options: [
                          { id: "low", label: "Low", isDefault: true },
                          { id: "xhigh", label: "Extra High" },
                        ],
                      },
                    ],
                  }),
                },
              ],
            },
            ...nextFixture.serverConfig.providers.slice(1),
          ],
        };
      },
      snapshot: {
        ...base,
        threads: [
          ...base.threads.map((thread) =>
            thread.id === THREAD_ID
              ? {
                  ...thread,
                  messages: [
                    ...thread.messages,
                    {
                      id: "msg-child-report" as MessageId,
                      role: "user" as const,
                      text: "The changelog is written:\n\n```text\n0.7.1: replies read as markdown\n```",
                      fromThread: {
                        threadId: childThreadId,
                        requestId: ChildRequestId.make("request-earlier"),
                        kind: "report" as const,
                      },
                      turnId: null,
                      streaming: false,
                      createdAt: isoAt(300),
                      updatedAt: isoAt(300),
                    },
                    {
                      id: "msg-remote-child-report" as MessageId,
                      role: "user" as const,
                      text: "The Windows build passed.",
                      fromThread: {
                        threadId: "thread-child-windows-build" as ThreadId,
                        requestId: ChildRequestId.make("request-windows-build"),
                        kind: "report" as const,
                        environmentId: EnvironmentId.make("environment-windows"),
                      },
                      turnId: null,
                      streaming: false,
                      createdAt: isoAt(302),
                      updatedAt: isoAt(302),
                    },
                    {
                      id: "msg-never-made-report" as MessageId,
                      role: "user" as const,
                      text: "Couldn't start 'Tidy the docs': Couldn't set up its worktree: disk full",
                      fromThread: {
                        threadId: "thread-child-never-made" as ThreadId,
                        requestId: ChildRequestId.make("request-never-made"),
                        kind: "report" as const,
                        neverMade: true,
                      },
                      turnId: null,
                      streaming: false,
                      createdAt: isoAt(304),
                      updatedAt: isoAt(304),
                    },
                  ],
                  childRequests: {
                    ...EMPTY_CHILD_REQUEST_STATE,
                    startsSinceUser: 1,
                    // A child on a computer this app has no thread list for.
                    remoteChildren: [
                      {
                        environmentId: EnvironmentId.make("environment-windows"),
                        label: "Windows PC",
                        threadId: "thread-child-windows-build" as ThreadId,
                        handle: "Codex",
                        title: "Check the Windows build",
                        attachmentEpoch: 0,
                        cachedStatus: "idle",
                        updatedAt: isoAt(300),
                      },
                    ],
                    open: [
                      {
                        requestId: ChildRequestId.make("request-start-1"),
                        batchId,
                        kind: "start" as const,
                        from: { participantId: null },
                        callerTurnId: "turn-start" as TurnId,
                        deliveryEpoch: 0,
                        status: "awaiting_user" as const,
                        childThreadId: "thread-child-flake" as ThreadId,
                        childMessageId: "msg-child-flake" as MessageId,
                        launch: {
                          title: "Fix the flaky cleanup test",
                          prompt: "Find out why the cleanup test flakes.",
                          modelSelection: {
                            instanceId: ProviderInstanceId.make("codex"),
                            model: "gpt-5",
                          },
                          runtimeMode: "full-access" as const,
                          interactionMode: "default" as const,
                          reportBack: true,
                          runSetup: true,
                          workspace: { kind: "project_folder" as const },
                        },
                        createdAt: isoAt(301),
                      },
                      {
                        requestId: ChildRequestId.make("request-start-2"),
                        batchId,
                        kind: "start" as const,
                        from: { participantId: null },
                        callerTurnId: "turn-start" as TurnId,
                        deliveryEpoch: 0,
                        status: "awaiting_user" as const,
                        childThreadId: "thread-child-remote" as ThreadId,
                        childMessageId: "msg-child-remote" as MessageId,
                        launch: {
                          title: "Run the Windows installer tests",
                          prompt: "Run the installer tests on Windows.",
                          modelSelection: {
                            instanceId: ProviderInstanceId.make("codex"),
                            model: "gpt-6.1-sol",
                            options: [{ id: "reasoningEffort", value: "xhigh" }],
                          },
                          runtimeMode: "full-access" as const,
                          interactionMode: "default" as const,
                          reportBack: true,
                          runSetup: true,
                          workspace: {
                            kind: "remote" as const,
                            projectKey: "github.com/example/repo",
                            checkout: "worktree" as const,
                          },
                          target: {
                            environmentId: EnvironmentId.make("environment-windows"),
                            label: "Windows PC",
                          },
                        },
                        createdAt: isoAt(301),
                      },
                    ],
                  },
                }
              : thread,
          ),
          {
            ...parentThread,
            id: childThreadId,
            title: "Write the changelog",
            messages: [],
            parentThreadId: THREAD_ID,
            attachedToParent: true,
          },
        ],
      },
    });

    try {
      const panel = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="child-threads-panel"]'),
        "Unable to find the approval card.",
      );
      expect(panel.textContent).toContain("wants to start 2 threads");
      expect(panel.textContent).toContain("Fix the flaky cleanup test");
      // No git to isolate it in: the card says it shares the folder.
      expect(panel.textContent).toContain("shares this folder");
      // One for a linked computer says where it would run, and at the
      // reasoning the agent settled for it there.
      expect(panel.textContent).toContain("on Windows PC");
      const rows = [...panel.querySelectorAll('[data-testid="child-threads-panel-thread"]')];
      expect(rows.at(-1)?.querySelector("[data-child-thread-reasoning]")?.textContent).toBe(
        "Extra High",
      );
      // The answer that came back is the child's, never the user's.
      const reportOf = (text: string) =>
        [...document.querySelectorAll('[data-thread-message="report"]')].find((report) =>
          report.textContent?.includes(text),
        );
      expect(
        reportOf("The changelog is written")?.querySelector("[data-thread-message-author]")
          ?.textContent,
      ).toBe("Write the changelog");
      // An agent wrote it: it shows folded to its first line, and opens to
      // markdown, a code block and no fences.
      const report = reportOf("The changelog is written")!;
      const fold = report.querySelector<HTMLButtonElement>("[data-agent-message-fold]");
      expect(fold?.textContent).toBe("The changelog is written:");
      expect(report.querySelector(".chat-markdown pre")).toBeNull();
      fold?.click();
      await vi.waitFor(() =>
        expect(report.querySelector(".chat-markdown pre")?.textContent).toContain(
          "0.7.1: replies read as markdown",
        ),
      );
      expect(report.textContent).not.toContain("```");
      // One from a linked computer is named from the parent's own record, with
      // the computer it ran on; the app has no thread there to open.
      const remoteReport = reportOf("The Windows build passed.");
      expect(remoteReport?.querySelector("[data-thread-message-author]")?.textContent).toBe(
        "Check the Windows build",
      );
      expect(remoteReport?.querySelector("[data-thread-message-kind]")?.textContent).toBe(
        "reply from Windows PC",
      );
      expect(remoteReport?.querySelector("button[data-thread-message-author]")).toBeNull();
      // One about a thread whose setup failed before it was made opens nothing.
      const neverMadeReport = reportOf("Couldn't start 'Tidy the docs'");
      expect(neverMadeReport?.querySelector("[data-thread-message-author]")?.textContent).toBe(
        "A thread it asked for",
      );
      expect(neverMadeReport?.querySelector("button[data-thread-message-author]")).toBeNull();

      [...panel.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Start")
        ?.click();
      await vi.waitFor(
        () =>
          expect(
            wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                (request as { type?: string }).type === "thread.child-request.respond",
            ),
          ).toMatchObject({ batchId, choice: "start" }),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("names the thread that started this one, in the header and on its request", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-started-by" as MessageId,
      targetText: "started by target",
    });
    const parentThreadId = "thread-parent-release" as ThreadId;
    const thisThread = base.threads.find((thread) => thread.id === THREAD_ID)!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: [
          ...base.threads.map((thread) =>
            thread.id === THREAD_ID
              ? {
                  ...thread,
                  parentThreadId,
                  attachedToParent: true,
                  // A later request from the parent, at the end of the chat
                  // where the list rests.
                  messages: [
                    ...thread.messages,
                    {
                      id: "msg-parent-request" as MessageId,
                      role: "user" as const,
                      text: "Now write the 0.6 changelog.",
                      fromThread: {
                        threadId: parentThreadId,
                        requestId: ChildRequestId.make("request-send-1"),
                        kind: "request" as const,
                      },
                      turnId: null,
                      streaming: false,
                      createdAt: isoAt(300),
                      updatedAt: isoAt(300),
                    },
                  ],
                }
              : thread,
          ),
          { ...thisThread, id: parentThreadId, title: "Ship the 0.6 release", messages: [] },
        ],
      },
    });

    try {
      const chip = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="chat-header-started-by"]'),
        "Unable to find the Started by chip.",
      );
      expect(chip.textContent).toContain("Ship the 0.6 release");
      await vi.waitFor(
        () =>
          expect(
            document.querySelector('[data-thread-message="request"] [data-thread-message-author]')
              ?.textContent,
          ).toBe("Ship the 0.6 release"),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("names a room's own agent by the model picked for its next message", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-room-model" as MessageId,
      targetText: "room model target",
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
                    id: "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId,
                    handle: "agent-2",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-6-astra",
                    },
                    joinedAt: NOW_ISO,
                    leftAt: null,
                  },
                ],
              }
            : thread,
        ),
      },
    });

    try {
      // The thread still carries its first model ("gpt-5"), which this
      // provider does not offer: the composer's model picker shows the one
      // the next message will use, and the room names the agent the same.
      const modelPicker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      const pickedName = modelPicker.textContent?.trim() ?? "";
      expect(pickedName).not.toBe("");
      expect(pickedName).not.toContain("gpt-5 ");
      modelPicker.click();
      await vi.waitFor(
        () => {
          const main = document.querySelector<HTMLElement>('[data-room-agent-row="primary"]');
          expect(main?.textContent?.replace("main", "").trim()).toBe(pickedName);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("stacks a room's agents on a phone's model button, and drops idle ones first as it narrows", async () => {
    const agentIds = [
      "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
      "8b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e",
      "9c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    ] as ThreadParticipantId[];
    const workingId = agentIds[2]!;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-room-phone" as MessageId,
      targetText: "room phone target",
      sessionStatus: "running",
      sessionActiveTurnId: "turn-room-phone" as TurnId,
    });
    const mounted = await mountChatView({
      viewport: { ...PHONE_VIEWPORT, width: 440 },
      configureFixture: withCodexModels,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                participants: agentIds.map((id, index) => ({
                  id,
                  handle: `agent-${index + 2}`,
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: index === 1 ? "gpt-5.6-sol" : "gpt-6-astra",
                  },
                  joinedAt: NOW_ISO,
                  leftAt: null,
                })),
                // The last agent to join is the one at work.
                session: thread.session ? { ...thread.session, participantId: workingId } : null,
                latestTurn: {
                  turnId: "turn-room-phone" as TurnId,
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

    const chosenBefore = useRoomRecipientStore.getState().chosen;
    try {
      // Writing to the thread's own agent while another works.
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
      const footer = await waitForElement(
        findVisibleComposerFooter,
        "Unable to find composer footer.",
      );
      const leftActions = await waitForElement(
        () => footer.querySelector<HTMLElement>('[data-chat-composer-actions="left"]'),
        "Unable to find left composer actions.",
      );
      const modelButton = await waitForElement(
        () =>
          leftActions.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      const shownIcons = () =>
        [...modelButton.querySelectorAll<HTMLElement>("[data-room-trigger-agent]")]
          .filter((icon) => getComputedStyle(icon).display !== "none")
          .map((icon) => icon.dataset.roomTriggerAgent);
      const nameWidth = () =>
        modelButton.querySelector<HTMLElement>("span.truncate")?.getBoundingClientRect().width ?? 0;
      const expectRowFits = () => {
        expect(footer.dataset.chatComposerFooterCompact).toBe("true");
        expect(leftActions.scrollWidth).toBeLessThanOrEqual(leftActions.clientWidth + 1);
        expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth + 1);
      };

      // A big phone: the addressed agent in front, then the one at work with
      // its dot, ahead of the idle agents that joined before it.
      await vi.waitFor(
        () => {
          expectRowFits();
          expect(shownIcons()).toEqual(["primary", workingId, agentIds[0]]);
          const dot = modelButton.querySelector<HTMLElement>(
            `[data-room-trigger-agent="${workingId}"] [data-room-trigger-working]`,
          );
          expect(dot).not.toBeNull();
          // The dot is whole and bright though its icon is faded: nothing
          // between it and the button fades or masks it.
          for (let node: HTMLElement | null = dot; node && node !== modelButton;) {
            expect(getComputedStyle(node).opacity).toBe("1");
            expect(getComputedStyle(node).maskImage).toBe("none");
            node = node.parentElement;
          }
        },
        { timeout: 8_000, interval: 16 },
      );

      // Narrower: the idle agent drops before the name gets short; the one at
      // work stays.
      await mounted.setViewport({ ...PHONE_VIEWPORT, width: 390 });
      await vi.waitFor(
        () => {
          expectRowFits();
          expect(shownIcons()).toEqual(["primary", workingId]);
          expect(nameWidth()).toBeGreaterThan(48);
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.setViewport({ ...PHONE_VIEWPORT, width: 375 });
      await vi.waitFor(
        () => {
          expectRowFits();
          expect(shownIcons()).toEqual(["primary"]);
          expect(nameWidth()).toBeGreaterThan(48);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      useRoomRecipientStore.setState({ chosen: chosenBefore });
      await mounted.cleanup();
    }
  });

  it("reveals the folded tail in increments and folds it back", async () => {
    // Short enough that fewer than ten rows fit: the fold rests at ten.
    const extraThreadIds = Array.from(
      { length: 17 },
      (_, index) => `thread-quiet-${index}` as ThreadId,
    );
    const snapshot = extraThreadIds.reduce(
      (current, threadId) => addThreadToSnapshot(current, threadId),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-live-fold" as MessageId,
        targetText: "live fold target",
      }),
    );
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, name: "short", height: 560 },
      snapshot,
    });

    const expectRows = async (count: number, revealLabel: string | null) => {
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid^="thread-row-"]').length).toBe(count);
          const reveal = document.querySelector('[data-testid="inbox-live-show-more"]');
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
      // Eighteen quiet threads, ten unfolded, revealed five at a time.
      await expectRows(10, "Show 5 more");
      await page.getByTestId("inbox-live-show-more").click();
      await expectRows(15, "Show 3 more");
      await page.getByTestId("inbox-live-show-more").click();
      // Nothing left to reveal, so only the fold-back and search icons remain.
      await expectRows(18, null);
      await expect.element(page.getByTestId("inbox-live-search")).toBeInTheDocument();

      await page.getByTestId("inbox-live-show-fewer").click();
      await expectRows(10, "Show 5 more");
    } finally {
      await mounted.cleanup();
    }
  });

  it("fills a tall column with quiet rows before folding the rest", async () => {
    const extraThreadIds = Array.from(
      { length: 39 },
      (_, index) => `thread-quiet-${index}` as ThreadId,
    );
    const snapshot = extraThreadIds.reduce(
      (current, threadId) => addThreadToSnapshot(current, threadId),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-live-fill" as MessageId,
        targetText: "live fill target",
      }),
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      await expect.element(page.getByTestId(`thread-row-${THREAD_ID}`)).toBeInTheDocument();
      // Two wrapped threads park the Wrapped shelf under the list.
      const doneAt = new Date().toISOString();
      for (const threadId of extraThreadIds.slice(0, 2)) {
        markThreadDoneInTest(
          scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId)),
          doneAt,
        );
      }

      let tallCount = 0;
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-testid="inbox-wrapped-shelf"]')).not.toBeNull();
          const rows = [...document.querySelectorAll<HTMLElement>("[data-inbox-live-row]")];
          expect(rows.length).toBeGreaterThan(10);
          const fold = document.querySelector<HTMLElement>('[data-testid="inbox-live-show-more"]');
          expect(fold).not.toBeNull();
          // Everything shown fits above the shelf, with less than another
          // row's room to spare: the fold line sits at the column's foot.
          const viewport = fold!.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
          const content = viewport.querySelector<HTMLElement>('[data-slot="sidebar-content"]')!;
          const spare = viewport.clientHeight - content.offsetHeight;
          expect(spare).toBeGreaterThanOrEqual(0);
          expect(spare).toBeLessThan(rows[0]!.offsetHeight);
          tallCount = rows.length;
        },
        { timeout: 8_000, interval: 16 },
      );

      // Open a quiet thread past the first ten, then shrink the window: the
      // fold falls back to ten, but never takes the thread being read.
      const shownRows = document.querySelectorAll<HTMLElement>('[data-testid^="thread-row-"]');
      const deepTestId = shownRows[shownRows.length - 1]!.dataset.testid!;
      await page.getByTestId(deepTestId).click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(`[data-testid="${deepTestId}"]`)?.getAttribute("data-active"),
          ).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
      await mounted.setViewport({ ...DEFAULT_VIEWPORT, name: "short", height: 560 });
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-inbox-live-row]").length).toBeLessThan(tallCount);
          expect(document.querySelector(`[data-testid="${deepTestId}"]`)).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
