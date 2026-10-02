import { useCallback, useEffect } from "react";
import { scopedThreadKey } from "@threadlines/client-runtime";
import type { PreviewAutomationRequest, ProjectId, ScopedThreadRef } from "@threadlines/contracts";
import { isBrowserHostAllowed } from "@threadlines/shared/preview";

import {
  PREVIEW_WEBVIEW_WAIT_MS,
  getPreviewWebview,
  selectActiveTab,
  selectThreadBrowserState,
  subscribePreviewWebviews,
  useBrowserPanelStore,
  waitForPreviewWebview,
  type PreviewWebviewHandle,
} from "../../browserPanelStore";
import { ensureEnvironmentApi } from "../../environmentApi";
import { readEnvironmentDescriptor } from "../../environments/runtime/catalog";
import {
  approveBrowserHostForProject,
  pushNavigationPolicy,
  readBrowserSiteAccess,
  setBrowserSitePolicyForProject,
  useBrowserApprovals,
} from "./browserApprovals";
import { nextBrowserApprovalId, waitForBrowserApproval } from "./browserApprovalRequests";
import { normalizePreviewUrl } from "./previewUrl";
import {
  usePreviewAutomationHost,
  type PreviewAutomationHostTarget,
} from "./previewAutomationHost";

/**
 * A registered webview is not yet a usable one: the element registers at
 * mount, and Electron throws on `getWebContentsId` until the guest attaches a
 * moment later. Null is "not attached yet", which every caller already treats
 * as "no page".
 */
function attachedWebContentsId(webview: PreviewWebviewHandle): number | null {
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
}

/** Provider-runtime-specific pins. The persisted store keeps only the most
 * recently active agent for presentation; routing must keep every runtime's
 * tab independent. */
const agentTabPins = new Map<string, string>();

function agentPinKey(threadRef: ScopedThreadRef, agentId: string): string {
  return `${scopedThreadKey(threadRef)}:${agentId}`;
}

/** How long `navigate` waits for the page to finish loading before answering. */
const NAVIGATE_LOAD_WAIT_MS = 12_000;

/**
 * Operations that pick their own tab, or none, and so are unaffected by the
 * agent's pinned tab having gone: listing tabs, opening one, choosing one.
 */
const OPERATIONS_WITHOUT_A_PINNED_TAB: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set(
  ["tabs", "openTab", "selectTab"],
);

/**
 * The agent's end of the browser, mounted with the thread rather than with the
 * panel.
 *
 * The host used to live inside the panel, which meant a closed panel was not a
 * closed browser but no browser at all: the agent asked for a page and was told
 * none existed, with no way to say "then open one". Since a request for the
 * browser is a request to use the browser, the mount now sits at the thread
 * level and opens the panel itself when something arrives for it.
 *
 * Renders nothing. It is a subscription with a React lifetime.
 */
export function PreviewAutomationMount({
  threadRef,
  projectId = null,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's project, for approvals while the thread is still a local draft. */
  projectId?: ProjectId | null;
}) {
  const setBrowserOpen = useBrowserPanelStore((store) => store.setBrowserOpen);
  const openBrowserForAgent = useBrowserPanelStore((store) => store.openBrowserForAgent);
  const openAgentTab = useBrowserPanelStore((store) => store.openAgentTab);
  const closeAgentTab = useBrowserPanelStore((store) => store.closeAgentTab);
  const markBrowserUserControlled = useBrowserPanelStore(
    (store) => store.markBrowserUserControlled,
  );
  const setAgentTab = useBrowserPanelStore((store) => store.setAgentTab);
  const setAgentPoint = useBrowserPanelStore((store) => store.setAgentPoint);
  const setAgentActivity = useBrowserPanelStore((store) => store.setAgentActivity);
  const selectTab = useBrowserPanelStore((store) => store.selectTab);
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabViewport = useBrowserPanelStore((store) => store.setTabViewport);
  const enqueueBrowserApproval = useBrowserPanelStore((store) => store.enqueueBrowserApproval);
  const { access, projectId: approvalsProjectId } = useBrowserApprovals(threadRef, projectId);

  /** Every attached guest this thread owns, which is what a policy applies to. */
  const attachedGuests = useCallback((): ReadonlyArray<{
    tabId: string;
    webContentsId: number;
  }> => {
    const store = useBrowserPanelStore.getState();
    const browserState = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
    return browserState.tabs.flatMap((tab) => {
      const webview = getPreviewWebview(threadRef, tab.id);
      const id = webview === null ? null : attachedWebContentsId(webview);
      return id === null ? [] : [{ tabId: tab.id, webContentsId: id }];
    });
  }, [threadRef]);

  /**
   * Hands the main process the same allowlist the agent is held to.
   *
   * Pushed on every attachment and every change rather than read from settings
   * over there: only this side knows which project a tab belongs to, and a guest
   * whose policy has not arrived is private-network-only until it does.
   */
  useEffect(() => {
    const pushPolicy = () => {
      for (const guest of attachedGuests()) {
        pushNavigationPolicy(guest.webContentsId, access);
      }
    };
    pushPolicy();
    // A tab that mounts or attaches later is a guest with no policy yet.
    return subscribePreviewWebviews(pushPolicy);
  }, [access, attachedGuests]);

  /**
   * A page that tried to take itself somewhere unapproved.
   *
   * The main process refused it and says so here, because the block is silent
   * on the page: a link that does nothing reads as a broken site rather than as
   * a question waiting to be answered.
   */
  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewNavigationBlocked;
    if (subscribe === undefined) {
      return;
    }
    return subscribe((blocked) => {
      // Every window hears about every guest, so a thread only answers for its own.
      const guest = attachedGuests().find((entry) => entry.webContentsId === blocked.webContentsId);
      if (guest === undefined) {
        return;
      }
      enqueueBrowserApproval(threadRef, {
        id: nextBrowserApprovalId(),
        // Nothing waits on a page's navigation: allowing it loads it again.
        waiting: false,
        host: blocked.host,
        url: blocked.url,
        // A page navigated itself; the agent's own requests never get this far.
        source: "page",
        fromHost: blocked.fromHost ?? null,
        tabId: guest.tabId,
      });
      const store = useBrowserPanelStore.getState();
      if (!selectThreadBrowserState(store.browserStateByThreadKey, threadRef).open) {
        // A question nobody can see is a stall, not a prompt.
        setBrowserOpen(threadRef, true);
      }
    });
  }, [attachedGuests, enqueueBrowserApproval, setBrowserOpen, threadRef]);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onPreviewUserControl;
    if (subscribe === undefined) return;
    return subscribe((control) => {
      if (attachedGuests().some((entry) => entry.webContentsId === control.webContentsId)) {
        markBrowserUserControlled(threadRef);
      }
    });
  }, [attachedGuests, markBrowserUserControlled, threadRef]);

  /**
   * Reads the world at the moment the agent acts, not at the moment this
   * component rendered: an operation may arrive many renders after the host
   * subscribed, and it must see the tab that exists now.
   */
  const resolveTarget = useCallback(
    (request: PreviewAutomationRequest): PreviewAutomationHostTarget => {
      const store = useBrowserPanelStore.getState();
      const browserState = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
      const activeTabId = selectActiveTab(browserState)?.id ?? "";
      const key = agentPinKey(threadRef, request.agentId);
      const requestedTabId =
        typeof (request.input as { tabId?: unknown } | undefined)?.tabId === "string"
          ? (request.input as { tabId: string }).tabId
          : null;
      if (requestedTabId !== null && !browserState.tabs.some((tab) => tab.id === requestedTabId)) {
        throw new Error(`No browser tab exists with id ${requestedTabId}.`);
      }
      const previousPin = agentTabPins.get(key) ?? null;
      // The agent's tab was closed under it, most likely by the user. The pin
      // is kept pointing at the missing tab until the agent opens or chooses
      // another, so every action until then is refused rather than landing on
      // whatever tab is in front: a page the agent has never seen.
      const pinLost =
        previousPin !== null && !browserState.tabs.some((tab) => tab.id === previousPin);
      if (
        pinLost &&
        requestedTabId === null &&
        !OPERATIONS_WITHOUT_A_PINNED_TAB.has(request.operation)
      ) {
        setAgentTab(threadRef, null);
        throw new Error(
          "The tab you were working in was closed. Call browser_tabs to see what is open, then browser_select_tab or browser_open_tab to choose where to work.",
        );
      }
      const pinned = requestedTabId ?? (pinLost ? null : previousPin);
      const tabId =
        pinned !== null && browserState.tabs.some((tab) => tab.id === pinned)
          ? pinned
          : activeTabId;
      // Listing tabs after losing one must not quietly adopt the user's tab.
      if (tabId !== "" && (!pinLost || requestedTabId !== null)) {
        agentTabPins.set(key, tabId);
      }
      setAgentTab(threadRef, tabId === "" ? null : tabId);
      const webview = tabId === "" ? null : getPreviewWebview(threadRef, tabId);

      /**
       * Lets an agent's navigation through, asking the user first when the
       * project asks first and this site has not been allowed.
       *
       * The request waits for the answer -- the server is told so, and gives
       * it minutes rather than seconds -- and carries on by itself once
       * allowed. A server too old to wait gets the old behaviour: the question
       * is left in the panel and the agent is told to try again later.
       */
      const ensureSiteAllowed = async (
        host: string,
        url: string,
        forTabId: string,
        signal: AbortSignal | undefined,
      ): Promise<void> => {
        if (isBrowserHostAllowed(host, readBrowserSiteAccess(approvalsProjectId))) {
          return;
        }
        const question = {
          host,
          url,
          source: "agent" as const,
          fromHost: null,
          tabId: forTabId,
        };
        const canWait =
          readEnvironmentDescriptor(threadRef.environmentId)?.capabilities.browserApprovalWait ===
          true;
        if (!canWait) {
          enqueueBrowserApproval(threadRef, {
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
        const decision = await waitForBrowserApproval(threadRef, question, signal);
        if (decision === "decline") {
          throw new Error(
            `The user chose not to let you visit ${host}. Carry on without it, or ask them about it in the conversation.`,
          );
        }
        if (approvalsProjectId !== null) {
          const granted =
            decision === "allowAllSites"
              ? setBrowserSitePolicyForProject(approvalsProjectId, "any")
              : approveBrowserHostForProject(approvalsProjectId, host);
          // Armed now rather than when the settings change reaches React, so a
          // redirect on the page about to load is held to the new answer.
          for (const guest of attachedGuests()) {
            pushNavigationPolicy(guest.webContentsId, granted);
          }
        }
      };

      /**
       * Loads an address the agent may visit into one of the thread's tabs --
       * unless the request was cancelled while it waited to get here, since
       * the agent has already been told it timed out.
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
        setTabUrl(threadRef, forTabId, url);
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
            return candidate !== null && attachedWebContentsId(candidate) !== null
              ? candidate
              : null;
          },
          subscribe: subscribePreviewWebviews,
          timeoutMs: PREVIEW_WEBVIEW_WAIT_MS,
        });
        return resolveTarget({
          ...request,
          input: { ...(request.input as object), tabId: nextTabId },
        });
      };

      return {
        tabId: tabId === "" ? null : tabId,
        webContentsId: webview === null ? null : attachedWebContentsId(webview),
        onAgentPoint: (point) => setAgentPoint(threadRef, point),
        onAgentActivity: (activity) => setAgentActivity(threadRef, activity),
        onUserTakeover: () => markBrowserUserControlled(threadRef),
        panelOpen: () => {
          const current = useBrowserPanelStore.getState();
          return selectThreadBrowserState(current.browserStateByThreadKey, threadRef).open;
        },
        openTab: async (input, signal) => {
          const normalized = input.url === undefined ? null : normalizePreviewUrl(input.url);
          if (input.url !== undefined && normalized === null) {
            throw new Error(`${JSON.stringify(input.url)} is not a URL this browser can open.`);
          }
          if (normalized !== null) {
            const host = new URL(normalized).hostname;
            if (!isBrowserHostAllowed(host, readBrowserSiteAccess(approvalsProjectId))) {
              // The tab opens empty while the user is asked, so the question
              // has a tab to belong to and the agent has a tab to come back to.
              const openedId = openAgentTab(threadRef, request.agentId, {
                background: input.background,
              });
              agentTabPins.set(key, openedId);
              setAgentTab(threadRef, openedId);
              await ensureSiteAllowed(host, normalized, openedId, signal);
              await waitForTab(openedId);
              await loadInTab(openedId, normalized, signal);
              return waitForTab(openedId);
            }
          }
          const openedId = openAgentTab(threadRef, request.agentId, {
            url: normalized,
            background: input.background,
          });
          agentTabPins.set(key, openedId);
          setAgentTab(threadRef, openedId);
          return waitForTab(openedId);
        },
        closeTab: async (closingTabId) => {
          const closingTab = browserState.tabs.find((tab) => tab.id === closingTabId);
          if (closingTabId === null || closingTab === undefined) {
            throw new Error("The browser tab to close does not exist.");
          }
          const closeResult = closeAgentTab(threadRef, request.agentId, closingTabId);
          if (!closeResult.closed) {
            throw new Error("You can only close a browser tab opened by this agent.");
          }
          if (agentTabPins.get(key) === closingTabId) agentTabPins.delete(key);
          if (tabId === closingTabId) setAgentTab(threadRef, null);
          return {
            id: closingTab.id,
            title: closingTab.title ?? "",
            url: closingTab.url ?? "",
          };
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
          setAgentTab(threadRef, chosen.id);
          if (input.background !== true) selectTab(threadRef, chosen.id);
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
          // viewport; a responsive page is exactly as big as its element. Read
          // now rather than from the state above: a resize in this same request
          // has just written it.
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
          if (tabId !== "") setTabViewport(threadRef, tabId, viewport);
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
          // Checked here rather than in the main process, because this is the
          // one navigation we can stop before it happens and answer in words the
          // agent can act on. The user's own navigations do not come through here.
          await ensureSiteAllowed(new URL(normalized).hostname, normalized, tabId, signal);
          await loadInTab(tabId, normalized, signal);
        },
      };
    },
    [
      approvalsProjectId,
      attachedGuests,
      closeAgentTab,
      enqueueBrowserApproval,
      markBrowserUserControlled,
      openAgentTab,
      selectTab,
      setAgentActivity,
      setAgentPoint,
      setAgentTab,
      setTabUrl,
      setTabViewport,
      threadRef,
    ],
  );

  /**
   * Opens the panel for an arriving operation and waits for it to have a page.
   *
   * Only the wait is conditional: with the panel already open this resolves on
   * the first look, which is the common case and stays exactly as fast as it
   * was.
   */
  const prepare = useCallback(
    async (request: PreviewAutomationRequest): Promise<void> => {
      const store = useBrowserPanelStore.getState();
      const browserState = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
      if (!browserState.open) {
        openBrowserForAgent(threadRef, request.agentId);
      }
      await waitForPreviewWebview<PreviewWebviewHandle>({
        resolve: () => {
          const current = useBrowserPanelStore.getState();
          const state = selectThreadBrowserState(current.browserStateByThreadKey, threadRef);
          const activeTabId = selectActiveTab(state)?.id ?? "";
          const requested = (request.input as { tabId?: unknown } | undefined)?.tabId;
          const pinned =
            typeof requested === "string"
              ? requested
              : (agentTabPins.get(agentPinKey(threadRef, request.agentId)) ?? null);
          const tabId =
            pinned !== null && state.tabs.some((tab) => tab.id === pinned) ? pinned : activeTabId;
          const webview = tabId === "" ? null : getPreviewWebview(threadRef, tabId);
          // Attached, not merely registered: the element registers at mount, and
          // an operation dispatched in the gap before the guest attaches finds a
          // webview that cannot answer anything yet.
          return webview !== null && attachedWebContentsId(webview) !== null ? webview : null;
        },
        subscribe: subscribePreviewWebviews,
        timeoutMs: PREVIEW_WEBVIEW_WAIT_MS,
      });
      // A timeout is not handled here: the host answers a missing page with the
      // error it has always used for one, so a panel that never came up reads the
      // same as a panel with nothing loaded.
    },
    [openBrowserForAgent, threadRef],
  );

  // Not the module-level `isElectron` snapshot: the bridge is what this needs,
  // the host already refuses to connect without one, and reading it at effect
  // time survives a preload that attaches after the bundle evaluates.
  usePreviewAutomationHost({
    threadRef,
    enabled: true,
    resolveTarget,
    prepare,
  });

  return null;
}
