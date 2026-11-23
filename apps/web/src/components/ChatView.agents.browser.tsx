import {
  ChildRequestBatchId,
  ChildRequestId,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  EventId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  EnvironmentId,
  type EnvironmentApi,
  MessageId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
  type OrchestrationSecretRequest,
  type OrchestrationSettingsChangeRequest,
  type RoomAgentRequestId,
  SecretRequestId,
  SettingsChangeRequestId,
  type SideTurnId,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { secretAnswerMessageId } from "@threadlines/shared/secretRequests";
import * as Effect from "effect/Effect";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { cdp, page, userEvent } from "vite-plus/test/browser";
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
  waitForURL,
  fixture,
  rpcHarness,
  createUserMessage,
  withLinkedThreadReadFixture,
} from "./ChatView.browser-harness";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { readThemePreference } from "../hooks/useTheme";
import { nextFrames, readAfterEachPaint } from "../lib/frameProbe.browser-harness";

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

  it("picks who a room message goes to from the agent pills, by click or arrow keys", async () => {
    const astraId = "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-room-pills" as MessageId,
      targetText: "room pills target",
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
              }
            : thread,
        ),
      },
    });

    try {
      const pill = (id: string) =>
        document.querySelector<HTMLElement>(`[data-room-agent-row="${id}"]`);
      const picker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      picker.click();
      await waitForElement(() => pill(astraId), "Unable to find astra's pill.");

      // Pointing at a pill swaps its icon for ⋯ without resizing it: a pill
      // that grew could wrap onto the next line, out from under the pointer,
      // and flicker between the two. (offsetWidth: the picker's opening
      // animation scales bounding boxes.)
      const options = () =>
        pill(astraId)!.querySelector<HTMLButtonElement>('button[aria-label$=" options"]')!;
      const widthBefore = pill(astraId)!.offsetWidth;
      // At rest no pill shows its ⋯, the picked one included.
      for (const button of document.querySelectorAll(
        '[data-room-agents-bar] button[aria-label$=" options"]',
      )) {
        expect(getComputedStyle(button).visibility).toBe("hidden");
      }
      await userEvent.hover(pill(astraId)!);
      await vi.waitFor(() => expect(getComputedStyle(options()).visibility).toBe("visible"));
      expect(pill(astraId)!.offsetWidth).toBe(widthBefore);

      // Its menu renames without closing the picker or changing who is picked.
      options().click();
      const menuItem = (text: string) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (item) => item.textContent === text,
        ) ?? null;
      (await waitForElement(() => menuItem("Rename…"), "The pill's menu should open.")).click();
      const nameBox = await waitForElement(
        () => pill(astraId)!.querySelector<HTMLInputElement>("input"),
        "Rename should open the pill's name box.",
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(nameBox));
      expect(document.querySelector("[data-model-picker-variant]")).not.toBeNull();
      expect(pill("primary")?.getAttribute("aria-checked")).toBe("true");
      expect(pill(astraId)?.getAttribute("aria-checked")).toBe("false");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(pill(astraId)!.querySelector("input")).toBeNull());

      // "+" starts adding; picking an agent instead means not a new one after
      // all, and the list below is that agent's again.
      document
        .querySelector<HTMLButtonElement>('[data-room-agents-bar] [data-room-add-agent="true"]')!
        .click();
      await waitForElement(() => pill("new"), "Adding an agent should show a new pill.");
      pill(astraId)!.click();
      await vi.waitFor(() => {
        expect(pill("new")).toBeNull();
        expect(pill(astraId)?.getAttribute("aria-checked")).toBe("true");
        expect(document.querySelector('[data-model-row-action="switch"]')).not.toBeNull();
      });

      // One tab stop for the group; the arrow keys move along it and pick.
      expect(pill(astraId)?.tabIndex).toBe(0);
      expect(pill("primary")?.tabIndex).toBe(-1);
      // The picker focuses its search box once more a frame and a tick after it
      // (re)renders; on a busy machine that lands late. Let those pass first,
      // or they pull focus off the pill before the arrow key.
      await nextFrames(2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      pill(astraId)!.focus();
      await userEvent.keyboard("{ArrowLeft}");
      await vi.waitFor(() => {
        expect(pill("primary")?.getAttribute("aria-checked")).toBe("true");
        expect(document.activeElement).toBe(pill("primary"));
      });
      // Still open: picking an agent doesn't close the picker.
      expect(document.querySelector("[data-model-picker-variant]")).not.toBeNull();

      // A right-click opens the same menu, which removes the agent.
      pill(astraId)!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
      (
        await waitForElement(
          () => menuItem("Remove from thread"),
          "Right-click should open the menu.",
        )
      ).click();
      await vi.waitFor(() =>
        expect(
          wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request as { type?: string }).type === "thread.participant.remove",
          ),
        ).toMatchObject({ participantId: astraId }),
      );
      expect(document.querySelector("[data-model-picker-variant]")).not.toBeNull();
      expect(pill("primary")?.getAttribute("aria-checked")).toBe("true");
    } finally {
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
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
      // The server took the answer, but the thread has not caught up yet, so
      // the card is still there. It says what it is doing in place of the
      // buttons: a second answer in that gap would be refused as an invite
      // already answered.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(document.querySelector('[data-testid="agent-invite-panel"]')).toBe(panel);
      expect(panel.querySelector('[data-testid="agent-invite-answering"]')?.textContent).toBe(
        "Asking GPT-6 Astra for a review…",
      );
      expect(
        [...panel.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
          ["Not now", "Add to thread", "Review only"].includes(button.textContent ?? ""),
        ),
      ).toEqual([]);
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
                        requestId: ChildRequestId.make("request-start-review"),
                        batchId,
                        kind: "start" as const,
                        from: { participantId: null },
                        callerTurnId: "turn-start" as TurnId,
                        deliveryEpoch: 0,
                        status: "awaiting_user" as const,
                        childThreadId: "thread-child-review" as ThreadId,
                        childMessageId: "msg-child-review" as MessageId,
                        launch: {
                          title: "Review the changelog",
                          prompt: "Review the uncommitted changelog.",
                          modelSelection: {
                            instanceId: ProviderInstanceId.make("codex"),
                            model: "gpt-5",
                          },
                          runtimeMode: "approval-required" as const,
                          interactionMode: "default" as const,
                          reportBack: true,
                          runSetup: false,
                          workspace: { kind: "project_folder" as const },
                          checkout: {
                            threadId: childThreadId,
                            title: "Write the changelog",
                            worktreePath: "/repo/worktrees/changelog",
                            branch: "docs/changelog",
                          },
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
      expect(panel.textContent).toContain("wants to start 3 threads");
      expect(panel.textContent).toContain("Fix the flaky cleanup test");
      // No git to isolate it in: the card says it shares the folder.
      expect(panel.textContent).toContain("shares this folder");
      // One put in another thread's checkout names that thread, and its
      // access where the agent asked for less than its own.
      const review = [...panel.querySelectorAll('[data-testid="child-threads-panel-thread"]')].find(
        (row) => row.textContent?.includes("Review the changelog"),
      );
      expect(review?.querySelector("[data-child-thread-checkout]")?.textContent).toBe(
        "in\u00a0Write the changelog's checkout",
      );
      expect(review?.querySelector("[data-child-thread-access]")?.textContent).toBe("Supervised");
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

      // This server can't take a partial answer: no checkboxes, and Start
      // answers for the whole batch.
      expect(panel.querySelector('[data-slot="checkbox"]')).toBeNull();
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
      const respond = wsRequests.find(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          (request as { type?: string }).type === "thread.child-request.respond",
      ) as { requestIds?: unknown } | undefined;
      expect(respond?.requestIds).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts only the threads left checked, where the server takes a partial answer", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-child-select" as MessageId,
      targetText: "child select target",
    });
    const batchId = ChildRequestBatchId.make("batch-select");
    const capabilities = { repositoryIdentity: true, childStartSelection: true };
    const ask = (index: number, title: string) => ({
      requestId: ChildRequestId.make(`request-select-${index}`),
      batchId,
      kind: "start" as const,
      from: { participantId: null },
      callerTurnId: "turn-select" as TurnId,
      deliveryEpoch: 0,
      status: "awaiting_user" as const,
      childThreadId: `thread-child-select-${index}` as ThreadId,
      childMessageId: `msg-child-select-${index}` as MessageId,
      launch: {
        title,
        prompt: `${title}.`,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        reportBack: true,
        runSetup: true,
        workspace: { kind: "project_folder" as const },
      },
      createdAt: isoAt(301),
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: { ...nextFixture.serverConfig.environment, capabilities },
        };
        nextFixture.welcome = {
          ...nextFixture.welcome,
          environment: { ...nextFixture.welcome.environment, capabilities },
        };
      },
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                childRequests: {
                  ...EMPTY_CHILD_REQUEST_STATE,
                  startsSinceUser: 3,
                  open: [
                    ask(1, "Fix the flaky test"),
                    ask(2, "Update the docs"),
                    ask(3, "Bump the version"),
                  ],
                },
              }
            : thread,
        ),
      },
    });
    try {
      const panel = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="child-threads-panel"]'),
        "Unable to find the approval card.",
      );
      const startButton = () =>
        [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.startsWith("Start"),
        );
      expect(startButton()?.textContent).toBe("Start all");
      await page.getByRole("checkbox", { name: "Start Update the docs" }).click();
      await vi.waitFor(() => expect(startButton()?.textContent).toBe("Start 2"));
      startButton()?.click();
      await vi.waitFor(
        () =>
          expect(
            wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                (request as { type?: string }).type === "thread.child-request.respond",
            ),
          ).toMatchObject({
            batchId,
            choice: "start",
            requestIds: ["request-select-1", "request-select-3"],
          }),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a family as tabs on the parent and its threads, and keeps the row still across a switch", async () => {
    const firstChild = "thread-family-first" as ThreadId;
    const secondChild = "thread-family-second" as ThreadId;
    const loner = "thread-family-loner" as ThreadId;
    const withThreads = addThreadToSnapshot(
      addThreadToSnapshot(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-family-tabs" as MessageId,
            targetText: "family tabs target",
          }),
          firstChild,
        ),
        secondChild,
      ),
      loner,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...withThreads,
        threads: withThreads.threads.map((thread) =>
          thread.id === firstChild || thread.id === secondChild
            ? {
                ...thread,
                title: thread.id === firstChild ? "Write the changelog" : "Fix the flaky test",
                parentThreadId: THREAD_ID,
                attachedToParent: true,
                createdAt: thread.id === firstChild ? isoAt(10) : isoAt(20),
              }
            : thread,
        ),
      },
    });
    const keyOf = (threadId: ThreadId) =>
      scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId));
    const row = () => document.querySelector<HTMLElement>('[data-testid="family-tabs"]');
    try {
      await waitForElement(row, "The family row should show on the parent.");
      const keys = () =>
        [...row()!.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.dataset.testid);
      // A starved CI tab can take seconds to file every thread.
      await vi.waitFor(
        () =>
          expect(keys()).toEqual([
            `family-tab-${THREAD_KEY}`,
            `family-tab-${keyOf(firstChild)}`,
            `family-tab-${keyOf(secondChild)}`,
          ]),
        { timeout: 10_000 },
      );

      // Switching to a child: the row stays mounted where it is, every frame.
      const rowAtStart = row()!;
      const top = rowAtStart.getBoundingClientRect().top;
      const samples: { present: boolean; same: boolean; top: number | null }[] = [];
      const stop = readAfterEachPaint(() => {
        const current = row();
        samples.push({
          present: current !== null,
          same: current === rowAtStart,
          top: current?.getBoundingClientRect().top ?? null,
        });
      });
      await page.getByTestId(`family-tab-${keyOf(secondChild)}`).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${secondChild}`),
        "A tab click should open its thread.",
      );
      await vi.waitFor(
        () =>
          expect(
            row()
              ?.querySelector(`[data-testid="family-tab-${keyOf(secondChild)}"]`)
              ?.getAttribute("aria-selected"),
          ).toBe("true"),
        { timeout: 10_000 },
      );
      await nextFrames(3);
      stop();
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((sample) => sample.present && sample.same)).toBe(true);
      expect(samples.every((sample) => sample.top === top)).toBe(true);
      // The row says who started this thread: the header's chip gives way.
      expect(document.body.textContent).not.toContain("Started by");

      // A thread with no family has no row.
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: loner },
      });
      await vi.waitFor(() => expect(row()).toBeNull(), { timeout: 10_000 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a thread started on a computer this app can't see, read through the link", async () => {
    const windows = EnvironmentId.make("environment-windows");
    const childId = "thread-child-windows" as ThreadId;
    const childKey = scopedThreadKey(scopeThreadRef(windows, childId));
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-linked-child" as MessageId,
      targetText: "linked child target",
    });
    const reads: Array<Record<string, unknown>> = [];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                childRequests: {
                  ...EMPTY_CHILD_REQUEST_STATE,
                  remoteChildren: [
                    {
                      environmentId: windows,
                      label: "Windows PC",
                      threadId: childId,
                      handle: "Codex",
                      title: "Check the Windows build",
                      attachmentEpoch: 0,
                      cachedStatus: "working",
                      updatedAt: isoAt(300),
                    },
                  ],
                },
              }
            : thread,
        ),
      },
      configureFixture: withLinkedThreadReadFixture,
      resolveRpc: (body) => {
        if (body._tag !== WS_METHODS.linksReadThread) return undefined;
        reads.push(body);
        return {
          outcome: "ok",
          messages: [
            {
              messageId: "m-ask",
              sequence: 1,
              at: isoAt(301),
              role: "user",
              author: "Browser test thread (on Local environment)",
              origin: "thread_request",
              text: "Check the Windows build.",
            },
            {
              messageId: "m-answer",
              sequence: 2,
              at: isoAt(302),
              role: "assistant",
              author: "Codex",
              origin: "agent",
              text: "The Windows build passes.",
            },
          ],
          next: 2,
          more: false,
        };
      },
    });
    try {
      const tab = page.getByTestId(`family-tab-${childKey}`);
      await vi.waitFor(() => expect(tab.element()).not.toHaveAttribute("disabled"), {
        timeout: 10_000,
      });
      await tab.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/linked/${windows}/${childId}`),
        "The tab should open the thread read through the link.",
      );
      await expect.element(page.getByText("The Windows build passes.")).toBeVisible();
      await expect.element(page.getByText("Check the Windows build.")).toBeVisible();
      await vi.waitFor(() =>
        expect(
          document
            .querySelector('[data-testid="linked-thread-place"]')
            ?.textContent?.replace(/\s+/g, " "),
        ).toBe("Windows PC·working"),
      );
      expect(reads[0]).toMatchObject({
        parentThreadId: THREAD_ID,
        environmentId: windows,
        threadId: childId,
        limit: 50,
      });
      // The family row stays, with this thread's tab open.
      await vi.waitFor(() =>
        expect(page.getByTestId(`family-tab-${childKey}`).element()).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      );
      await page.getByTestId(`family-tab-${THREAD_KEY}`).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname.endsWith(`/${THREAD_ID}`),
        "The parent's tab should open the parent again.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the lead's tab whole on a crowded row, drops a shared topic, and cuts long tabs to one width", async () => {
    const titles = [
      "Panel Jam animation timing review",
      "Panel Jam: council round two",
      "Review: last three commits on main",
      "Pull Station restructure: start the split",
      "Pull Station: Android toolchain setup",
      "Pull Station: UI polish pass after review",
    ];
    const children = titles.map((_, index) => `thread-crowded-${index}` as ThreadId);
    const base = children.reduce(
      (snapshot, child) => addThreadToSnapshot(snapshot, child),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-crowded-family" as MessageId,
        targetText: "crowded family target",
      }),
    );
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_280 },
      snapshot: {
        ...base,
        projects: base.projects.map((project) => ({ ...project, leadThreadId: THREAD_ID })),
        threads: base.threads.map((thread) => {
          const index = children.indexOf(thread.id);
          return index === -1
            ? thread
            : {
                ...thread,
                title: titles[index]!,
                parentThreadId: THREAD_ID,
                attachedToParent: true,
                createdAt: isoAt(10 + index),
              };
        }),
      },
    });
    const tabs = () => [
      ...document.querySelectorAll<HTMLElement>('[data-testid="family-tabs"] [role="tab"]'),
    ];
    try {
      await vi.waitFor(() => expect(tabs()).toHaveLength(1 + children.length), {
        timeout: 10_000,
      });
      const [leadTab, ...childTabs] = tabs();
      const labelOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>("span.truncate")!;
      // A topic two threads share is dropped from their tabs, and kept in the tooltip.
      expect(childTabs.map((tab) => labelOf(tab).textContent)).toEqual([
        "Animation timing review",
        "Council round two",
        "Review: last three commits on main",
        "Restructure: start the split",
        "Android toolchain setup",
        "UI polish pass after review",
      ]);
      expect(childTabs.map((tab) => tab.title)).toEqual(titles);
      // "Lead" is never cut...
      expect(labelOf(leadTab!).textContent).toBe("Lead");
      expect(labelOf(leadTab!).scrollWidth).toBeLessThanOrEqual(labelOf(leadTab!).clientWidth);
      // ...and on a crowded row the cut tabs share one width, which no other tab passes.
      const width = (tab: HTMLElement) => tab.getBoundingClientRect().width;
      const cut = childTabs.filter((tab) => labelOf(tab).scrollWidth > labelOf(tab).clientWidth);
      expect(cut.length).toBeGreaterThan(1);
      const cutWidths = cut.map(width);
      // Within a pixel: layout splits the row in fractions of one.
      expect(Math.max(...cutWidths) - Math.min(...cutWidths)).toBeLessThan(1);
      expect(childTabs.every((tab) => width(tab) < Math.max(...cutWidths) + 1)).toBe(true);

      // The sidebar's rows under the lead say the same, with the full title for screen readers.
      await page.getByTestId(`thread-family-${THREAD_ID}`).click();
      const sidebarTitle = (child: ThreadId) =>
        document.querySelector<HTMLElement>(`[data-testid="child-title-${child}"]`);
      await vi.waitFor(() => expect(sidebarTitle(children[4]!)).not.toBeNull(), {
        timeout: 10_000,
      });
      expect(sidebarTitle(children[4]!)!.querySelector(`[aria-hidden="true"]`)?.textContent).toBe(
        "Android toolchain setup",
      );
      expect(sidebarTitle(children[4]!)!.querySelector(".sr-only")?.textContent).toBe(titles[4]);
      expect(sidebarTitle(children[2]!)!.textContent).toBe(titles[2]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps short-titled tabs on the row where they fit, instead of behind +N", async () => {
    const titles = ["UI", "DB", "QA", "CI", "Ops", "Docs", "Perf", "Auth"];
    const children = titles.map((_, index) => `thread-short-${index}` as ThreadId);
    const base = children.reduce(
      (snapshot, child) => addThreadToSnapshot(snapshot, child),
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-short-family" as MessageId,
        targetText: "short family target",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        projects: base.projects.map((project) => ({ ...project, leadThreadId: THREAD_ID })),
        threads: base.threads.map((thread) => {
          const index = children.indexOf(thread.id);
          return index === -1
            ? thread
            : {
                ...thread,
                title: titles[index]!,
                parentThreadId: THREAD_ID,
                attachedToParent: true,
                createdAt: isoAt(10 + index),
              };
        }),
      },
    });
    const row = () => document.querySelector<HTMLElement>('[data-testid="family-tabs"]');
    try {
      await vi.waitFor(
        () => expect(row()?.querySelectorAll('[role="tab"]')).toHaveLength(1 + titles.length),
        { timeout: 10_000 },
      );
      // Nine tabs at the 96px floor would not fit; at their own widths they do, none cut.
      const onRow = () => [
        ...row()!.querySelectorAll<HTMLElement>(
          '[role="tab"], [data-testid="family-tabs-overflow"]',
        ),
      ];
      const unclipped = () =>
        onRow().every((item) => {
          const label = item.querySelector<HTMLElement>("span.truncate") ?? item;
          return label.scrollWidth <= label.clientWidth;
        });
      const inside = () =>
        onRow().every(
          (item) =>
            item.getBoundingClientRect().right <= row()!.getBoundingClientRect().right + 0.5,
        );
      expect(row()!.clientWidth).toBeLessThan((1 + titles.length) * 96);
      expect(row()!.querySelector('[data-testid="family-tabs-overflow"]')).toBeNull();
      expect(unclipped()).toBe(true);
      expect(inside()).toBe(true);

      // A larger browser font: the row measures what it draws, so what shows still fits whole.
      document.documentElement.style.fontSize = "24px";
      try {
        await vi.waitFor(
          () => expect(row()!.querySelector('[data-testid="family-tabs-overflow"]')).not.toBeNull(),
          { timeout: 5_000 },
        );
        await nextFrames(3);
        expect(unclipped()).toBe(true);
        expect(inside()).toBe(true);
      } finally {
        document.documentElement.style.fontSize = "";
      }
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
          // Its parent is wrapped: no family row stands in for the chip, so the
          // header names it (docs/design/lead-chat.md, "Family tabs").
          {
            ...thisThread,
            id: parentThreadId,
            title: "Ship the 0.6 release",
            messages: [],
            doneOverride: { state: "done" as const, at: isoAt(400) },
          },
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
      // The name alone: the button also shows settings beside it.
      const pickedName = modelPicker.querySelector("span.truncate")?.textContent?.trim() ?? "";
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

  it("opens a pill's menu on a long press in the phone drawer, and keeps it open when the finger lifts", async () => {
    const astraId = "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" as ThreadParticipantId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-room-hold" as MessageId,
      targetText: "room hold target",
    });
    // Real touches, so the browser follows a lifted finger with the mouse
    // press and click a phone sends: those land on whatever is under the
    // finger by then, which is the menu's backdrop.
    const session = cdp() as unknown as {
      send: (method: string, params?: object) => Promise<unknown>;
    };
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const frame = window.frameElement?.getBoundingClientRect();
    const touch = async (element: Element, holdMs: number) => {
      const box = element.getBoundingClientRect();
      const point = {
        x: box.left + box.width / 2 + (frame?.left ?? 0),
        y: box.top + box.height / 2 + (frame?.top ?? 0),
      };
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      // The mouse press and click that follow a lifted finger.
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
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
              }
            : thread,
        ),
      },
    });

    try {
      const pill = (id: string) =>
        document.querySelector<HTMLElement>(`[data-room-agent-row="${id}"]`);
      const sheet = () => document.querySelector('[data-model-picker-sheet="true"]');
      const menuItem = (text: string) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (item) => item.textContent === text,
        ) ?? null;
      const picker = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]'),
        "Unable to find the composer's model picker.",
      );
      await touch(picker, 40);
      await waitForElement(sheet, "A tap should open the picker as a drawer.");
      const astra = await waitForElement(() => pill(astraId), "Unable to find astra's pill.");
      // The drawer slides in: a touch is aimed at where the pill comes to rest.
      await vi.waitFor(async () => {
        const top = astra.getBoundingClientRect().top;
        await nextFrames(2);
        expect(astra.getBoundingClientRect().top).toBe(top);
      });

      // The hold opens the menu, and lifting the finger leaves it open,
      // without picking the pill or closing the drawer.
      await touch(astra, 700);
      expect(menuItem("Rename…")).not.toBeNull();
      expect(pill(astraId)?.getAttribute("aria-checked")).toBe("false");
      expect(sheet()).not.toBeNull();

      // A tap outside the menu still closes it, and only it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await touch(document.querySelector('[data-slot="menu-backdrop"]')!, 40);
      await vi.waitFor(() => expect(menuItem("Rename…")).toBeNull());
      expect(sheet()).not.toBeNull();

      // A tap on Rename, even a slow one, opens the name box, focused, in the
      // open drawer: it is not taken for another hold on the pill.
      await touch(astra, 700);
      await touch(menuItem("Rename…")!, 600);
      const nameBox = await waitForElement(
        () => pill(astraId)!.querySelector<HTMLInputElement>("input"),
        "Rename should open the pill's name box.",
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(nameBox));
      expect(sheet()).not.toBeNull();
    } finally {
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      useRoomRecipientStore.getState().choose(THREAD_REF, null);
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
      await mounted.setViewport({ ...PHONE_VIEWPORT, width: 345 });
      await vi.waitFor(
        () => {
          expectRowFits();
          expect(shownIcons()).toEqual(["primary", workingId]);
          expect(nameWidth()).toBeGreaterThan(48);
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.setViewport({ ...PHONE_VIEWPORT, width: 335 });
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

  describe("an agent's settings change", () => {
    const settingsRequest = (
      id: string,
      changes: OrchestrationSettingsChangeRequest["changes"],
    ): OrchestrationSettingsChangeRequest => ({
      requestId: SettingsChangeRequestId.make(id),
      participantId: null,
      turnId: "turn-settings" as TurnId,
      changes,
      status: "waiting",
      createdAt: isoAt(301),
      noted: false,
    });
    const snapshotWith = (requests: ReadonlyArray<OrchestrationSettingsChangeRequest>) => {
      const base = createSnapshotForTargetUser({
        targetMessageId: "msg-user-settings-change" as MessageId,
        targetText: "switch me to light theme and stop streaming",
      });
      return {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID ? { ...thread, settingsRequests: requests } : thread,
        ),
      };
    };
    /** Sends the open thread a live event, as its computer would. */
    let liveSequence = 0;
    const sendLive = <T extends OrchestrationEvent["type"]>(
      type: T,
      payload: Extract<OrchestrationEvent, { type: T }>["payload"],
    ) => {
      liveSequence += 1;
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "event",
        event: {
          sequence: fixture.snapshot.snapshotSequence + liveSequence,
          eventId: EventId.make(`evt-settings-change-${liveSequence}`),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: NOW_ISO,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload,
        },
      });
    };
    const respondRequests = () =>
      wsRequests.filter((request) => request._tag === WS_METHODS.settingsChangeRespond);
    const reportRequests = () =>
      wsRequests.filter((request) => request._tag === WS_METHODS.settingsChangeReportDevice);
    const panel = () =>
      waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="settings-change-panel"]'),
        "Unable to find the settings change card.",
      );
    const button = (card: HTMLElement, name: string) =>
      [...card.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === name,
      )!;
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };

    it("shows each setting and where it lands, and makes this device's changes once its claim wins", async () => {
      localStorage.setItem("threadlines:theme", "dark");
      const request = settingsRequest("settings-request-change", [
        { place: "general.streamReplies", value: false, from: true },
        { place: "appearance.theme", value: "light" },
        { place: "general.timeFormat", value: "24-hour" },
      ]);
      const answer = deferred<unknown>();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([request]),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.settingsChangeRespond ? answer.promise : undefined,
      });

      try {
        const card = await panel();
        expect(
          card.querySelector('[data-testid="settings-change-panel-heading"]')?.textContent,
        ).toBe("The agent wants to change 3 settings");
        const lines = [
          ...card.querySelectorAll<HTMLElement>('[data-testid="settings-change-panel-line"]'),
        ].map((line) => ({
          name: line.querySelector("[data-place-link]")?.textContent,
          value: line.querySelector("[data-settings-change-value]")?.textContent,
          lands: line.querySelector("[data-settings-change-lands]")?.textContent,
        }));
        expect(lines).toEqual([
          {
            name: "Stream replies",
            value: "On → Off",
            lands: readPrimaryEnvironmentDescriptor()?.label,
          },
          { name: "Theme", value: "Dark → Light", lands: "this device" },
          { name: "Time format", value: "System default → 24-hour", lands: "this device" },
        ]);
        // The names open their rows.
        expect(card.querySelector('a[data-place-link="appearance.theme"]')).not.toBeNull();

        button(card, "Change").click();
        await vi.waitFor(() => expect(respondRequests()).toHaveLength(1), {
          timeout: 8_000,
          interval: 16,
        });
        const sent = respondRequests()[0]!;
        expect(sent).toMatchObject({
          threadId: THREAD_ID,
          requestId: request.requestId,
          allow: true,
          claim: { claimId: expect.any(String), deviceLabel: expect.any(String) },
        });
        // Nothing on this device changes before the claim has won.
        expect(getClientSettings().timestampFormat).toBe("locale");
        expect(readThemePreference()).toBe("dark");

        answer.resolve({ outcome: "changed", makeDeviceChanges: true });
        await vi.waitFor(
          () => {
            expect(getClientSettings().timestampFormat).toBe("24-hour");
            expect(readThemePreference()).toBe("light");
            expect(reportRequests()).toEqual([
              expect.objectContaining({
                threadId: THREAD_ID,
                requestId: request.requestId,
                claimId: (sent["claim"] as { claimId: string }).claimId,
                device: { applied: ["general.timeFormat", "appearance.theme"], failed: [] },
              }),
            ]);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("makes the device changes from the thread when the answer is lost, once", async () => {
      const request = settingsRequest("settings-request-lost", [
        { place: "general.timeFormat", value: "12-hour" },
      ]);
      const answer = deferred<unknown>();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([request]),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.settingsChangeRespond ? answer.promise : undefined,
      });

      try {
        button(await panel(), "Change").click();
        await vi.waitFor(() => expect(respondRequests()).toHaveLength(1), {
          timeout: 8_000,
          interval: 16,
        });
        const claim = respondRequests()[0]!["claim"] as { claimId: string; deviceLabel: string };

        // The answer never comes; the thread says this app's claim won.
        sendLive("thread.settings-change-claimed", {
          threadId: THREAD_ID,
          requestId: request.requestId,
          claim,
          claimedAt: isoAt(302),
        });
        await vi.waitFor(
          async () => expect(button(await panel(), "Changing…").disabled).toBe(true),
          { timeout: 8_000, interval: 16 },
        );
        expect(getClientSettings().timestampFormat).toBe("locale");
        sendLive("thread.settings-change-settled", {
          threadId: THREAD_ID,
          requestId: request.requestId,
          ending: "changed",
          settledAt: isoAt(303),
        });
        await vi.waitFor(
          () => {
            expect(getClientSettings().timestampFormat).toBe("12-hour");
            expect(reportRequests()).toHaveLength(1);
            expect(document.querySelector('[data-testid="settings-change-panel"]')).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        // The answer turns up late: the changes aren't made or reported again.
        answer.resolve({ outcome: "changed", makeDeviceChanges: true });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reportRequests()).toHaveLength(1);
      } finally {
        await mounted.cleanup();
      }
    });

    it("changes nothing when another device answered first, and asks for an update it can't make", async () => {
      localStorage.setItem("threadlines:theme", "dark");
      const first = settingsRequest("settings-request-answered", [
        { place: "appearance.theme", value: "light" },
      ]);
      const newer = settingsRequest("settings-request-newer", [
        { place: "general.streamReplies", value: false, from: true },
        { place: "general.settingFromANewerApp", value: true },
      ]);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([first, newer]),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.settingsChangeRespond
            ? body["allow"] === true
              ? { outcome: "already_answered", makeDeviceChanges: false }
              : { outcome: "declined", makeDeviceChanges: false }
            : undefined,
      });

      try {
        button(await panel(), "Change").click();
        await vi.waitFor(() => expect(document.body.textContent).toContain("Already answered"), {
          timeout: 8_000,
          interval: 16,
        });
        expect(readThemePreference()).toBe("dark");
        expect(reportRequests()).toHaveLength(0);

        // Its computer settles it: the next card comes up.
        sendLive("thread.settings-change-settled", {
          threadId: THREAD_ID,
          requestId: first.requestId,
          ending: "declined",
          settledAt: isoAt(302),
        });
        await vi.waitFor(
          async () =>
            expect(
              (await panel()).querySelector('[data-testid="settings-change-panel-update"]')
                ?.textContent,
            ).toBe("Update Threadlines on this device to make these changes."),
          { timeout: 8_000, interval: 16 },
        );
        const card = await panel();
        expect(button(card, "Change").disabled).toBe(true);

        // Not now still answers it, and claims nothing.
        button(card, "Not now").click();
        await vi.waitFor(() => expect(respondRequests()).toHaveLength(2), {
          timeout: 8_000,
          interval: 16,
        });
        expect(respondRequests()[1]).toMatchObject({
          threadId: THREAD_ID,
          requestId: newer.requestId,
          allow: false,
        });
        expect(respondRequests()[1]!["claim"]).toBeUndefined();
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("an agent's request for a key", () => {
    const CANARY = "sk_test_canary_4f9a";
    const secretRequest = (
      id: string,
      overrides: Partial<OrchestrationSecretRequest> = {},
    ): OrchestrationSecretRequest => ({
      requestId: SecretRequestId.make(id),
      participantId: null,
      turnId: "turn-secret" as TurnId,
      name: "STRIPE_SECRET_KEY",
      reason: "To run the checkout tests against Stripe test mode.",
      use: { kind: "env_file", path: ".env.local" },
      replaces: false,
      status: "waiting",
      createdAt: isoAt(301),
      noted: false,
      ...overrides,
    });
    const snapshotWith = (
      requests: ReadonlyArray<OrchestrationSecretRequest>,
      extraMessages: ReadonlyArray<ReturnType<typeof createUserMessage>> = [],
    ) => {
      const base = createSnapshotForTargetUser({
        targetMessageId: "msg-user-secret-request" as MessageId,
        targetText: "set up stripe",
      });
      return {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                secretRequests: requests,
                messages: [...thread.messages, ...extraMessages],
              }
            : thread,
        ),
      };
    };
    let liveSequence = 0;
    const sendLive = <T extends OrchestrationEvent["type"]>(
      type: T,
      payload: Extract<OrchestrationEvent, { type: T }>["payload"],
    ) => {
      liveSequence += 1;
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "event",
        event: {
          sequence: fixture.snapshot.snapshotSequence + liveSequence,
          eventId: EventId.make(`evt-secret-request-${liveSequence}`),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: NOW_ISO,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload,
        },
      });
    };
    const respondRequests = () =>
      wsRequests.filter((request) => request._tag === WS_METHODS.secretRequestRespond);
    const panel = () =>
      waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="secret-request-panel"]'),
        "Unable to find the key card.",
      );
    const field = (card: HTMLElement) =>
      card.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[data-testid="secret-request-panel-field"]',
      );
    const button = (card: HTMLElement, name: string) =>
      [...card.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === name,
      )!;
    const text = (card: HTMLElement, testId: string) =>
      card.querySelector(`[data-testid="secret-request-panel-${testId}"]`)?.textContent ?? null;
    /** The value as it went over the wire, where the client unwrapped it to encode the frame. */
    const sentValue = (request: Record<string, unknown>) =>
      (request["answer"] as { readonly value?: unknown }).value;
    const claimOf = (request: Record<string, unknown>) => ({
      claimId: request["claimId"] as string,
      deviceLabel: request["deviceLabel"] as string,
    });
    /** Whether the typed value is anywhere the app keeps state. */
    const valueKeptAnywhere = () => {
      const storage = [localStorage, sessionStorage].flatMap((store) =>
        Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ""}`),
      );
      return (
        storage.some((entry) => entry.includes(CANARY)) ||
        JSON.stringify(useStore.getState()).includes(CANARY)
      );
    };
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };
    const waitOptions = { timeout: 8_000, interval: 16 };

    it("shows Threadlines' own lines about where the key goes, and Save sends it once", async () => {
      const request = secretRequest("secret-request-save", { replaces: true });
      const answer = deferred<unknown>();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([request]),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.secretRequestRespond ? answer.promise : undefined,
      });

      try {
        const card = await panel();
        expect(text(card, "heading")).toMatch(/.+ is asking for a key$/);
        expect(text(card, "name")).toBe("STRIPE_SECRET_KEY");
        expect(text(card, "reason")).toMatch(
          / says: To run the checkout tests against Stripe test mode\.$/,
        );
        const computer = readPrimaryEnvironmentDescriptor()?.label;
        expect(text(card, "replaces")).toBe(
          "Replaces the STRIPE_SECRET_KEY already in .env.local.",
        );
        expect(text(card, "destination")).toBe(
          `Saved as STRIPE_SECRET_KEY in .env.local, in this thread's folder on ${computer}. It stays out of the chat. The agent can read that file.`,
        );
        // A password field no password manager fills or saves, and not part
        // of the message box's form.
        const input = field(card) as HTMLInputElement;
        expect(input.type).toBe("password");
        expect(input.autocomplete).toBe("new-password");
        expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
        expect(input.getAttribute("data-lpignore")).toBe("true");
        expect(input.form).toBeNull();
        expect(button(card, "Save").disabled).toBe(true);
        // The sidebar shows the thread waits on the user.
        const summary = selectSidebarThreadSummaryByRef(useStore.getState(), THREAD_REF);
        expect(summary && resolveThreadStatusPill({ thread: summary })?.label).toBe(
          "Pending Approval",
        );

        await userEvent.fill(input, CANARY);
        const save = button(card, "Save");
        expect(save.disabled).toBe(false);
        save.click();
        save.click();
        await vi.waitFor(() => expect(respondRequests()).toHaveLength(1), waitOptions);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(respondRequests()).toHaveLength(1);
        const sent = respondRequests()[0]!;
        expect(sent).toMatchObject({
          threadId: THREAD_ID,
          requestId: request.requestId,
          claimId: expect.any(String),
          deviceLabel: expect.any(String),
          answer: { type: "save" },
        });
        expect(sentValue(sent)).toBe(CANARY);
        expect(valueKeptAnywhere()).toBe(false);

        // The computer claims and saves it: the card goes.
        sendLive("thread.secret-request-claimed", {
          threadId: THREAD_ID,
          requestId: request.requestId,
          claim: claimOf(sent),
          claimedAt: isoAt(302),
        });
        answer.resolve({ outcome: "saved" });
        sendLive("thread.secret-request-settled", {
          threadId: THREAD_ID,
          requestId: request.requestId,
          ending: "saved",
          savedAt: isoAt(303),
          noted: true,
          settledAt: isoAt(303),
        });
        await vi.waitFor(
          () => expect(document.querySelector('[data-testid="secret-request-panel"]')).toBeNull(),
          waitOptions,
        );
        expect(valueKeptAnywhere()).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the card and the field on a rejected value, and retries under the same claim", async () => {
      const request = secretRequest("secret-request-rejected");
      let calls = 0;
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([request]),
        resolveRpc: (body) => {
          if (body._tag !== WS_METHODS.secretRequestRespond) return undefined;
          calls += 1;
          return calls === 1
            ? {
                outcome: "rejected",
                detail:
                  "An env file can't hold this value as typed. Ask the agent to request it for its commands instead.",
              }
            : Effect.die(new Error("the socket closed"));
        },
      });

      try {
        const card = await panel();
        await userEvent.fill(field(card)!, CANARY);
        button(card, "Save").click();
        await vi.waitFor(
          () =>
            expect(text(card, "problem")).toBe(
              "An env file can't hold this value as typed. Ask the agent to request it for its commands instead.",
            ),
          waitOptions,
        );
        expect(field(card)?.value).toBe(CANARY);

        // A send that never got its answer keeps the field too, and the
        // next Save is a retry under the same claim.
        button(card, "Save").click();
        await vi.waitFor(
          () =>
            expect(text(card, "problem")).toBe(
              `Couldn't reach ${readPrimaryEnvironmentDescriptor()?.label}. Try again.`,
            ),
          waitOptions,
        );
        expect(field(card)?.value).toBe(CANARY);
        const [first, second] = respondRequests();
        expect(claimOf(second!).claimId).toBe(claimOf(first!).claimId);
      } finally {
        await mounted.cleanup();
      }
    });

    it("clears typed text when the card is replaced or answered on another device, and says why", async () => {
      const first = secretRequest("secret-request-first");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([first]),
      });

      try {
        await userEvent.fill(field(await panel())!, CANARY);
        // The agent asks again for the same key: a fresh card, empty.
        const newer = secretRequest("secret-request-newer", { createdAt: isoAt(302) });
        sendLive("thread.secret-request-created", {
          threadId: THREAD_ID,
          request: newer,
          replaces: [first.requestId],
        });
        await vi.waitFor(async () => {
          const card = await panel();
          expect(card.parentElement?.innerHTML).not.toContain(CANARY);
          expect(field(card)?.value).toBe("");
          expect(document.body.textContent).toContain(
            "The agent asked for STRIPE_SECRET_KEY again",
          );
        }, waitOptions);

        // Typed again, then answered on a phone.
        await userEvent.fill(field(await panel())!, CANARY);
        sendLive("thread.secret-request-claimed", {
          threadId: THREAD_ID,
          requestId: newer.requestId,
          claim: { claimId: "claim-phone", deviceLabel: "iPhone" },
          claimedAt: isoAt(303),
        });
        await vi.waitFor(async () => {
          const card = await panel();
          expect(text(card, "status")).toBe("Answered on iPhone");
          expect(field(card)).toBeNull();
        }, waitOptions);
        expect(respondRequests()).toHaveLength(0);
      } finally {
        await mounted.cleanup();
      }
    });

    it("offers to remove edge spaces without trimming, and Not now declines under a claim", async () => {
      const request = secretRequest("secret-request-spaces", {
        use: { kind: "commands" },
      });
      const second = secretRequest("secret-request-second", {
        name: "OPENAI_API_KEY",
        createdAt: isoAt(302),
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([request, second]),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.secretRequestRespond ? { outcome: "declined" } : undefined,
      });

      try {
        const card = await panel();
        expect(text(card, "position")).toBe("1 of 2");
        expect(text(card, "destination")).toMatch(
          /^Kept in a private file on .+ until .+\. It stays out of the chat\. The agent can read it\.$/,
        );
        // A one-line field would drop the line break of a two-line paste and
        // save an altered key: the paste is refused with the reason instead.
        const pasted = new DataTransfer();
        pasted.setData("text/plain", `${CANARY}\nsecond-line`);
        field(card)!.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: pasted, bubbles: true, cancelable: true }),
        );
        await vi.waitFor(() => expect(text(card, "problem")).toContain("line break"), waitOptions);
        expect(field(card)?.value).toBe("");

        await userEvent.fill(field(card)!, ` ${CANARY} `);
        await vi.waitFor(
          () => expect(text(card, "spaces")).toContain("This starts or ends with a space."),
          waitOptions,
        );
        expect(field(card)?.value).toBe(` ${CANARY} `);
        button(card, "Remove spaces").click();
        await vi.waitFor(() => expect(field(card)?.value).toBe(CANARY), waitOptions);
        expect(text(card, "spaces")).toBeNull();

        button(card, "Not now").click();
        await vi.waitFor(() => expect(respondRequests()).toHaveLength(1), waitOptions);
        expect(respondRequests()[0]).toMatchObject({
          requestId: request.requestId,
          claimId: expect.any(String),
          answer: { type: "decline" },
        });
        expect(sentValue(respondRequests()[0]!)).toBeUndefined();
      } finally {
        await mounted.cleanup();
      }
    });

    it("turns Save off when the connection to the computer isn't encrypted", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([]),
      });

      try {
        await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
          "Unable to find the composer.",
        );
        // This app reaches its server by a plain address on the network.
        window.desktopBridge = {
          getLocalEnvironmentBootstrap: () => ({
            httpBaseUrl: "http://192.168.1.20:3773",
            wsBaseUrl: "ws://192.168.1.20:3773",
          }),
        } as unknown as NonNullable<typeof window.desktopBridge>;
        sendLive("thread.secret-request-created", {
          threadId: THREAD_ID,
          request: secretRequest("secret-request-unprotected"),
        });
        const card = await panel();
        expect(text(card, "unprotected")).toBe(
          `The connection to ${readPrimaryEnvironmentDescriptor()?.label} isn't encrypted, so a key can't be sent from here. Answer on that computer.`,
        );
        expect(button(card, "Save").disabled).toBe(true);
        expect(field(card)?.disabled).toBe(true);
      } finally {
        await mounted.cleanup();
      }
    });

    it("draws the saved message as a quiet row, with Remove now while the file is there", async () => {
      const saved = secretRequest("secret-request-saved", {
        use: { kind: "commands" },
        status: "saved",
        claim: { claimId: "claim-1", deviceLabel: "This Mac" },
        savedAt: isoAt(303),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        settledAt: isoAt(303),
        noted: true,
      });
      const message = createUserMessage({
        id: secretAnswerMessageId(saved.requestId),
        text: "I saved STRIPE_SECRET_KEY for your commands in a private file.",
        offsetSeconds: 400,
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWith([saved], [message]),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.secretRequestRemove ? Effect.void : undefined,
      });

      try {
        const row = await waitForElement(
          () =>
            document.querySelector<HTMLElement>(`[data-secret-answer-row="${saved.requestId}"]`),
          "Unable to find the saved row.",
        );
        expect(row.querySelector("[data-secret-answer-text]")?.textContent).toMatch(
          /^You saved STRIPE_SECRET_KEY for the agent's commands\. Removed at .+ tomorrow\.$/,
        );
        // A quiet row, not the bubble the agent's message text would be.
        expect(document.body.textContent).not.toContain("in a private file.");
        row.querySelector<HTMLButtonElement>("[data-secret-answer-remove]")!.click();
        await vi.waitFor(
          () =>
            expect(
              wsRequests.filter((request) => request._tag === WS_METHODS.secretRequestRemove),
            ).toEqual([
              expect.objectContaining({ threadId: THREAD_ID, requestId: saved.requestId }),
            ]),
          waitOptions,
        );
        sendLive("thread.secret-request-removed", {
          threadId: THREAD_ID,
          requestId: saved.requestId,
          removedAt: isoAt(404),
        });
        await vi.waitFor(() => {
          expect(row.querySelector("[data-secret-answer-text]")?.textContent).toBe(
            "You saved STRIPE_SECRET_KEY for the agent's commands. Removed.",
          );
          expect(row.querySelector("[data-secret-answer-remove]")).toBeNull();
        }, waitOptions);
      } finally {
        await mounted.cleanup();
      }
    });
  });
});
