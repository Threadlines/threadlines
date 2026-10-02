import { scopedThreadKey } from "@threadlines/client-runtime";
import type { ProjectId, PreviewAutomationRequest, ScopedThreadRef } from "@threadlines/contracts";
import { isBrowserHostAllowed } from "@threadlines/shared/preview";

import {
  PREVIEW_WEBVIEW_WAIT_MS,
  getPreviewWebview,
  selectActiveTab,
  selectThreadBrowserState,
  subscribePreviewWebviews,
  useBrowserPanelStore,
  waitForPreviewWebview,
  type PendingBrowserApproval,
  type PreviewWebviewHandle,
} from "../../browserPanelStore";
import { useBrowserLiveStore } from "../../browserLiveStore";
import { ensureEnvironmentApi } from "../../environmentApi";
import { readEnvironmentDescriptor } from "../../environments/runtime/catalog";
import { selectEnvironmentState, useStore } from "../../store";
import { toastManager } from "../ui/toast";
import {
  approveBrowserHostForProject,
  pushNavigationPolicy,
  readBrowserSiteAccess,
  setBrowserSitePolicyForProject,
} from "./browserApprovals";
import {
  answerBrowserApproval,
  nextBrowserApprovalId,
  waitForBrowserApproval,
} from "./browserApprovalRequests";
import { beginAgentWork, reviveEvictedPage } from "./browserLifecycle";
import type { PreviewAutomationHostTarget } from "./previewAutomationHost";
import { normalizePreviewUrl } from "./previewUrl";

/**
 * An agent's browser requests, for any thread.
 *
 * The thread need not be on screen: its pages live in the app-wide browser
 * layer, and a request for a thread nobody has looked at starts its browser
 * there. Everything is read from the stores at the moment the request
 * arrives, never from a render, so it sees the tabs that exist now.
 */

/**
 * A registered webview is not yet a usable one: the element registers at
 * mount, and Electron throws on `getWebContentsId` until the guest attaches a
 * moment later. Null is "not attached yet", which every caller already treats
 * as "no page".
 */
export function attachedWebContentsId(webview: PreviewWebviewHandle): number | null {
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
}

/** Every attached guest a thread owns, which is what a site policy applies to. */
export function attachedThreadGuests(
  threadRef: ScopedThreadRef,
): ReadonlyArray<{ tabId: string; webContentsId: number }> {
  const browserState = selectThreadBrowserState(
    useBrowserPanelStore.getState().browserStateByThreadKey,
    threadRef,
  );
  return browserState.tabs.flatMap((tab) => {
    const webview = getPreviewWebview(threadRef, tab.id);
    const id = webview === null ? null : attachedWebContentsId(webview);
    return id === null ? [] : [{ tabId: tab.id, webContentsId: id }];
  });
}

/**
 * The thread's project: from its running browser if it has one (a local
 * draft's panel says which), else from the thread itself.
 */
export function projectIdForThread(threadRef: ScopedThreadRef): ProjectId | null {
  const live = useBrowserLiveStore.getState().liveByThreadKey[scopedThreadKey(threadRef)];
  if (live !== undefined) {
    return live.projectId;
  }
  return (
    selectEnvironmentState(useStore.getState(), threadRef.environmentId).threadShellById[
      threadRef.threadId
    ]?.projectId ?? null
  );
}

/** Provider-runtime-specific pins. The persisted store keeps only the most
 * recently active agent for presentation; routing must keep every runtime's
 * tab independent. */
const agentTabPins = new Map<string, string>();

function agentPinKey(threadRef: ScopedThreadRef, agentId: string): string {
  return `${scopedThreadKey(threadRef)}:${agentId}`;
}

/**
 * Operations that pick their own tab, or none, and so are unaffected by the
 * agent's pinned tab having gone: listing tabs, opening one, choosing one.
 */
const OPERATIONS_WITHOUT_A_PINNED_TAB: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set(
  ["tabs", "openTab", "selectTab"],
);

/** How long `navigate` waits for the page to finish loading before answering. */
const NAVIGATE_LOAD_WAIT_MS = 12_000;

/** Opens a thread in the app, for the "Show" on a question about it. */
let showThread: ((threadRef: ScopedThreadRef) => void) | null = null;
export function setBrowserThreadOpener(open: ((threadRef: ScopedThreadRef) => void) | null) {
  showThread = open;
}

function threadTitle(threadRef: ScopedThreadRef): string | null {
  return (
    selectEnvironmentState(useStore.getState(), threadRef.environmentId).threadShellById[
      threadRef.threadId
    ]?.title ?? null
  );
}

/**
 * A question about a thread nobody is looking at: a toast, since the approval
 * bar is in a panel that is not on screen. It goes once the question is
 * answered anywhere, or withdrawn.
 */
function offerAnswerOffScreen(threadRef: ScopedThreadRef, asked: PendingBrowserApproval) {
  if (useBrowserLiveStore.getState().shownThreadKey === scopedThreadKey(threadRef)) {
    return () => {};
  }
  const title = threadTitle(threadRef);
  const toastId = toastManager.add({
    type: "info",
    title: `Agent wants to visit ${asked.host}`,
    description: title === null ? "In a thread you are not viewing." : `In "${title}".`,
    timeout: 0,
    actionProps: {
      children: "Allow site",
      onClick: () => {
        answerBrowserApproval(threadRef, asked, "allowSite");
      },
    },
    data: {
      secondaryActionProps: {
        children: "Show",
        onClick: () => showThread?.(threadRef),
      },
    },
  });
  return () => toastManager.close(toastId);
}

/** Which tab an operation acts on, before anything is decided about it. */
function targetTabId(threadRef: ScopedThreadRef, request: PreviewAutomationRequest): string {
  const state = selectThreadBrowserState(
    useBrowserPanelStore.getState().browserStateByThreadKey,
    threadRef,
  );
  const requested = (request.input as { tabId?: unknown } | undefined)?.tabId;
  const pinned =
    typeof requested === "string"
      ? requested
      : (agentTabPins.get(agentPinKey(threadRef, request.agentId)) ?? null);
  return pinned !== null && state.tabs.some((tab) => tab.id === pinned)
    ? pinned
    : (selectActiveTab(state)?.id ?? "");
}

/**
 * Makes the thread's browser exist for an arriving operation, and waits for
 * the page it will act on.
 *
 * A thread with no browser yet gets one, running unseen if the thread is not
 * on screen -- and remembered as open, so the user finds the agent's pages when
 * they come to the thread. A page closed to save memory comes back. With the
 * page already there this resolves on the first look, which is the common case.
 */
export async function prepareThreadBrowser(
  threadRef: ScopedThreadRef,
  request: PreviewAutomationRequest,
): Promise<void> {
  const projectId = projectIdForThread(threadRef);
  if (projectId === null) {
    return;
  }
  useBrowserLiveStore.getState().ensureLive(threadRef, projectId);
  const panel = useBrowserPanelStore.getState();
  if (!selectThreadBrowserState(panel.browserStateByThreadKey, threadRef).open) {
    panel.openBrowserForAgent(threadRef, request.agentId);
  }
  const tabId = targetTabId(threadRef, request);
  if (tabId !== "") {
    reviveEvictedPage(threadRef, tabId);
  }
  await waitForPreviewWebview<PreviewWebviewHandle>({
    resolve: () => {
      const current = targetTabId(threadRef, request);
      const webview = current === "" ? null : getPreviewWebview(threadRef, current);
      // Attached, not merely registered: the element registers at mount, and
      // an operation dispatched in the gap before the guest attaches finds a
      // webview that cannot answer anything yet.
      return webview !== null && attachedWebContentsId(webview) !== null ? webview : null;
    },
    subscribe: subscribePreviewWebviews,
    timeoutMs: PREVIEW_WEBVIEW_WAIT_MS,
  });
  // A timeout is not handled here: the host answers a missing page with the
  // error it has always used for one.
}

/**
 * Reads the world at the moment the agent acts, not at the moment anything
 * rendered: an operation may arrive long after the host subscribed, and it
 * must see the tab that exists now.
 */
export function resolveThreadBrowserTarget(
  threadRef: ScopedThreadRef,
  request: PreviewAutomationRequest,
): PreviewAutomationHostTarget {
  const store = useBrowserPanelStore.getState();
  const browserState = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
  const activeTabId = selectActiveTab(browserState)?.id ?? "";
  const projectId = projectIdForThread(threadRef);
  if (projectId === null) {
    throw new Error(
      "This thread has no project, so it has no browser. The browser works in project threads.",
    );
  }
  const key = agentPinKey(threadRef, request.agentId);
  const requestedTabId =
    typeof (request.input as { tabId?: unknown } | undefined)?.tabId === "string"
      ? (request.input as { tabId: string }).tabId
      : null;
  if (requestedTabId !== null && !browserState.tabs.some((tab) => tab.id === requestedTabId)) {
    throw new Error(`No browser tab exists with id ${requestedTabId}.`);
  }
  const previousPin = agentTabPins.get(key) ?? null;
  // The agent's tab was closed under it, most likely by the user. The pin is
  // kept pointing at the missing tab until the agent opens or chooses another,
  // so every action until then is refused rather than landing on whatever tab
  // is in front: a page the agent has never seen.
  const pinLost = previousPin !== null && !browserState.tabs.some((tab) => tab.id === previousPin);
  if (
    pinLost &&
    requestedTabId === null &&
    !OPERATIONS_WITHOUT_A_PINNED_TAB.has(request.operation)
  ) {
    store.setAgentTab(threadRef, null);
    throw new Error(
      "The tab you were working in was closed. Call browser_tabs to see what is open, then browser_select_tab or browser_open_tab to choose where to work.",
    );
  }
  const pinned = requestedTabId ?? (pinLost ? null : previousPin);
  const tabId =
    pinned !== null && browserState.tabs.some((tab) => tab.id === pinned) ? pinned : activeTabId;
  // Listing tabs after losing one must not quietly adopt the user's tab.
  if (tabId !== "" && (!pinLost || requestedTabId !== null)) {
    agentTabPins.set(key, tabId);
  }
  store.setAgentTab(threadRef, tabId === "" ? null : tabId);
  const webview = tabId === "" ? null : getPreviewWebview(threadRef, tabId);

  /**
   * Lets an agent's navigation through, asking the user first when the
   * project asks first and this site has not been allowed.
   *
   * The request waits for the answer -- the server is told so, and gives it
   * minutes rather than seconds -- and carries on by itself once allowed. A
   * server too old to wait gets the old behaviour: the question is left in
   * the panel and the agent is told to try again later.
   */
  const ensureSiteAllowed = async (
    host: string,
    url: string,
    forTabId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (isBrowserHostAllowed(host, readBrowserSiteAccess(projectId))) {
      return;
    }
    const question = { host, url, source: "agent" as const, fromHost: null, tabId: forTabId };
    const canWait =
      readEnvironmentDescriptor(threadRef.environmentId)?.capabilities.browserApprovalWait === true;
    if (!canWait) {
      useBrowserPanelStore.getState().enqueueBrowserApproval(threadRef, {
        ...question,
        id: nextBrowserApprovalId(),
        waiting: false,
      });
      throw new Error(
        `${host} is outside this project's approved sites. The user has been asked to allow it in the browser panel; once they do, navigate again.`,
      );
    }
    void ensureEnvironmentApi(threadRef.environmentId)
      .previewAutomation.progress({ requestId: request.requestId, awaitingUser: true })
      .catch(() => undefined);
    let closeToast = () => {};
    const decision = await waitForBrowserApproval(threadRef, question, signal, (asked) => {
      closeToast = offerAnswerOffScreen(threadRef, asked);
    }).finally(() => closeToast());
    if (decision === "decline") {
      throw new Error(
        `The user chose not to let you visit ${host}. Carry on without it, or ask them about it in the conversation.`,
      );
    }
    const granted =
      decision === "allowAllSites"
        ? setBrowserSitePolicyForProject(projectId, "any")
        : approveBrowserHostForProject(projectId, host);
    // Armed now rather than when the settings change reaches the layer, so a
    // redirect on the page about to load is held to the new answer.
    for (const guest of attachedThreadGuests(threadRef)) {
      pushNavigationPolicy(guest.webContentsId, granted);
    }
  };

  /**
   * Loads an address the agent may visit into one of the thread's tabs --
   * unless the request was cancelled while it waited to get here, since the
   * agent has already been told it timed out.
   */
  const loadInTab = async (
    forTabId: string,
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (signal?.aborted === true) {
      throw new Error("The browser request was cancelled before the page loaded.");
    }
    const current = useBrowserPanelStore.getState();
    if (
      !selectThreadBrowserState(current.browserStateByThreadKey, threadRef).tabs.some(
        (tab) => tab.id === forTabId,
      )
    ) {
      throw new Error(`The tab closed before ${url} could load.`);
    }
    current.setTabUrl(threadRef, forTabId, url);
    const loaded = getPreviewWebview(threadRef, forTabId)
      ?.loadURL(url)
      .catch((cause: unknown) => {
        // A page that immediately redirects aborts the load it interrupts,
        // which is a successful navigation wearing an error.
        if (!String(cause).includes("ERR_ABORTED")) {
          throw cause;
        }
      });
    // A load settles only when the whole page has, and one slow image can
    // hold that for minutes. Past the wait the agent is answered with the
    // page still loading, which it can wait on, instead of the tab's queue
    // being held and the call timing out.
    let gaveUp: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      loaded,
      new Promise<void>((resolve) => {
        gaveUp = setTimeout(resolve, NAVIGATE_LOAD_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(gaveUp));
  };

  const waitForTab = async (nextTabId: string): Promise<PreviewAutomationHostTarget> => {
    await waitForPreviewWebview<PreviewWebviewHandle>({
      resolve: () => {
        const candidate = getPreviewWebview(threadRef, nextTabId);
        return candidate !== null && attachedWebContentsId(candidate) !== null ? candidate : null;
      },
      subscribe: subscribePreviewWebviews,
      timeoutMs: PREVIEW_WEBVIEW_WAIT_MS,
    });
    return resolveThreadBrowserTarget(threadRef, {
      ...request,
      input: { ...(request.input as object), tabId: nextTabId },
    });
  };

  return {
    tabId: tabId === "" ? null : tabId,
    webContentsId: webview === null ? null : attachedWebContentsId(webview),
    beginWork: tabId === "" ? undefined : () => beginAgentWork(threadRef, tabId),
    onAgentPoint: (point) => useBrowserPanelStore.getState().setAgentPoint(threadRef, point),
    onAgentActivity: (activity) =>
      useBrowserPanelStore.getState().setAgentActivity(threadRef, activity),
    onUserTakeover: () => useBrowserPanelStore.getState().markBrowserUserControlled(threadRef),
    panelOpen: () =>
      selectThreadBrowserState(useBrowserPanelStore.getState().browserStateByThreadKey, threadRef)
        .open,
    openTab: async (input, signal) => {
      const normalized = input.url === undefined ? null : normalizePreviewUrl(input.url);
      if (input.url !== undefined && normalized === null) {
        throw new Error(`${JSON.stringify(input.url)} is not a URL this browser can open.`);
      }
      const panel = useBrowserPanelStore.getState();
      if (normalized !== null) {
        const host = new URL(normalized).hostname;
        if (!isBrowserHostAllowed(host, readBrowserSiteAccess(projectId))) {
          // The tab opens empty while the user is asked, so the question has a
          // tab to belong to and the agent has a tab to come back to.
          const openedId = panel.openAgentTab(threadRef, request.agentId, {
            background: input.background,
          });
          agentTabPins.set(key, openedId);
          panel.setAgentTab(threadRef, openedId);
          await ensureSiteAllowed(host, normalized, openedId, signal);
          await waitForTab(openedId);
          await loadInTab(openedId, normalized, signal);
          return waitForTab(openedId);
        }
      }
      const openedId = panel.openAgentTab(threadRef, request.agentId, {
        url: normalized,
        background: input.background,
      });
      agentTabPins.set(key, openedId);
      panel.setAgentTab(threadRef, openedId);
      return waitForTab(openedId);
    },
    closeTab: async (closingTabId) => {
      const closingTab = browserState.tabs.find((tab) => tab.id === closingTabId);
      if (closingTabId === null || closingTab === undefined) {
        throw new Error("The browser tab to close does not exist.");
      }
      const closeResult = useBrowserPanelStore
        .getState()
        .closeAgentTab(threadRef, request.agentId, closingTabId);
      if (!closeResult.closed) {
        throw new Error("You can only close a browser tab opened by this agent.");
      }
      if (agentTabPins.get(key) === closingTabId) agentTabPins.delete(key);
      if (tabId === closingTabId) useBrowserPanelStore.getState().setAgentTab(threadRef, null);
      return { id: closingTab.id, title: closingTab.title ?? "", url: closingTab.url ?? "" };
    },
    selectTab: async (input) => {
      const chosen =
        input.tabId !== undefined
          ? browserState.tabs.find((entry) => entry.id === input.tabId)
          : input.index !== undefined
            ? browserState.tabs[input.index]
            : undefined;
      if (chosen === undefined) {
        throw new Error("The browser tab to select does not exist.");
      }
      agentTabPins.set(key, chosen.id);
      const panel = useBrowserPanelStore.getState();
      panel.setAgentTab(threadRef, chosen.id);
      if (input.background !== true) panel.selectTab(threadRef, chosen.id);
      reviveEvictedPage(threadRef, chosen.id);
      return waitForTab(chosen.id);
    },
    tabs: () => {
      const current = selectThreadBrowserState(
        useBrowserPanelStore.getState().browserStateByThreadKey,
        threadRef,
      );
      const currentPin = agentTabPins.get(key) ?? null;
      return current.tabs.map((entry) => ({
        id: entry.id,
        title: entry.title ?? "",
        url: entry.url ?? "",
        active: entry.id === current.activeTabId,
        agent: entry.id === currentPin,
      }));
    },
    viewport: () => {
      // The size the page was given, when it was given one. The frame is
      // scaled to fit the panel, so its on-screen box is not the page's own
      // viewport; a responsive page is exactly as big as its element. Read now
      // rather than from the state above: a resize in this same request has
      // just written it.
      const current = selectThreadBrowserState(
        useBrowserPanelStore.getState().browserStateByThreadKey,
        threadRef,
      );
      const fixed = current.tabs.find((entry) => entry.id === tabId)?.viewport;
      if (fixed !== undefined && fixed.width !== null && fixed.height !== null) {
        return { width: fixed.width, height: fixed.height };
      }
      const rect = webview?.getBoundingClientRect();
      return { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) };
    },
    setViewport: (viewport) => {
      if (tabId !== "") useBrowserPanelStore.getState().setTabViewport(threadRef, tabId, viewport);
    },
    // The address belongs to the element, so this is the one operation the
    // main process cannot do on the agent's behalf.
    navigate: async (url, signal) => {
      const normalized = normalizePreviewUrl(url);
      if (normalized === null) {
        throw new Error(`${JSON.stringify(url)} is not a URL this browser can open.`);
      }
      if (tabId === "") {
        throw new Error("The browser panel has no tab to navigate.");
      }
      // Checked here rather than in the main process, because this is the one
      // navigation we can stop before it happens and answer in words the agent
      // can act on. The user's own navigations do not come through here.
      await ensureSiteAllowed(new URL(normalized).hostname, normalized, tabId, signal);
      await loadInTab(tabId, normalized, signal);
    },
  };
}

export function resetThreadBrowserAutomationForTests(): void {
  agentTabPins.clear();
}
