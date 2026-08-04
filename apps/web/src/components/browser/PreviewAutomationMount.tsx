import { useCallback, useEffect } from "react";
import { scopedThreadKey } from "@threadlines/client-runtime";
import type { PreviewAutomationRequest, ProjectId, ScopedThreadRef } from "@threadlines/contracts";
import { isBrowserHostApproved } from "@threadlines/shared/preview";

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
import { pushNavigationPolicy, useBrowserApprovals } from "./browserApprovals";
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
  const openTab = useBrowserPanelStore((store) => store.openTab);
  const openTabWithUrl = useBrowserPanelStore((store) => store.openTabWithUrl);
  const closeTab = useBrowserPanelStore((store) => store.closeTab);
  const setAgentTab = useBrowserPanelStore((store) => store.setAgentTab);
  const setAgentPoint = useBrowserPanelStore((store) => store.setAgentPoint);
  const setAgentActivity = useBrowserPanelStore((store) => store.setAgentActivity);
  const selectTab = useBrowserPanelStore((store) => store.selectTab);
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setPendingBrowserApproval = useBrowserPanelStore(
    (store) => store.setPendingBrowserApproval,
  );
  const { approvedDomains } = useBrowserApprovals(threadRef, projectId);

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
        pushNavigationPolicy(guest.webContentsId, approvedDomains);
      }
    };
    pushPolicy();
    // A tab that mounts or attaches later is a guest with no policy yet.
    return subscribePreviewWebviews(pushPolicy);
  }, [approvedDomains, attachedGuests]);

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
      setPendingBrowserApproval(threadRef, {
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
  }, [attachedGuests, setBrowserOpen, setPendingBrowserApproval, threadRef]);

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
      const pinned = requestedTabId ?? agentTabPins.get(key) ?? null;
      const tabId =
        pinned !== null && browserState.tabs.some((tab) => tab.id === pinned)
          ? pinned
          : activeTabId;
      if (tabId !== "") agentTabPins.set(key, tabId);
      setAgentTab(threadRef, tabId === "" ? null : tabId);
      const webview = tabId === "" ? null : getPreviewWebview(threadRef, tabId);

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
        openTab: async (input) => {
          const normalized = input.url === undefined ? null : normalizePreviewUrl(input.url);
          if (input.url !== undefined && normalized === null) {
            throw new Error(`${JSON.stringify(input.url)} is not a URL this browser can open.`);
          }
          if (normalized !== null) {
            const host = new URL(normalized).hostname;
            if (!isBrowserHostApproved(host, approvedDomains)) {
              const openedId = openTab(threadRef, input.background !== true);
              agentTabPins.set(key, openedId);
              setAgentTab(threadRef, openedId);
              setPendingBrowserApproval(threadRef, {
                host,
                url: normalized,
                source: "agent",
                fromHost: null,
                tabId: openedId,
              });
              throw new Error(
                `${host} is outside this project's approved sites. The user has been asked to allow it in the browser panel.`,
              );
            }
          }
          const activate = input.background !== true;
          const openedId =
            normalized === null
              ? openTab(threadRef, activate)
              : openTabWithUrl(threadRef, normalized, activate);
          agentTabPins.set(key, openedId);
          setAgentTab(threadRef, openedId);
          return waitForTab(openedId);
        },
        closeTab: async (closingTabId) => {
          if (closingTabId === null || !browserState.tabs.some((tab) => tab.id === closingTabId)) {
            throw new Error("The browser tab to close does not exist.");
          }
          closeTab(threadRef, closingTabId);
          if (agentTabPins.get(key) === closingTabId) agentTabPins.delete(key);
          if (tabId === closingTabId) setAgentTab(threadRef, null);
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
          const rect = webview?.getBoundingClientRect();
          return { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) };
        },
        // The address belongs to the element, so this is the one operation the
        // main process cannot do on the agent's behalf.
        navigate: async (url) => {
          const normalized = normalizePreviewUrl(url);
          if (normalized === null) {
            throw new Error(`${JSON.stringify(url)} is not a URL this browser can open.`);
          }
          if (tabId === "") {
            throw new Error("The browser panel has no tab to navigate.");
          }
          // Refused here rather than in the main process, because this is the one
          // navigation we can stop before it happens and answer in words the
          // agent can act on. The user's own navigations do not come through here.
          const host = new URL(normalized).hostname;
          if (!isBrowserHostApproved(host, approvedDomains)) {
            setPendingBrowserApproval(threadRef, {
              host,
              url: normalized,
              source: "agent",
              fromHost: null,
              tabId,
            });
            throw new Error(
              `${host} is outside this project's approved sites. The user has been asked to allow it in the browser panel; once they do, navigate again.`,
            );
          }
          setTabUrl(threadRef, tabId, normalized);
          await getPreviewWebview(threadRef, tabId)
            ?.loadURL(normalized)
            .catch((cause: unknown) => {
              // A page that immediately redirects aborts the load it interrupts,
              // which is a successful navigation wearing an error.
              if (!String(cause).includes("ERR_ABORTED")) {
                throw cause;
              }
            });
        },
      };
    },
    [
      approvedDomains,
      closeTab,
      openTab,
      openTabWithUrl,
      selectTab,
      setAgentActivity,
      setAgentPoint,
      setAgentTab,
      setPendingBrowserApproval,
      setTabUrl,
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
        setBrowserOpen(threadRef, true);
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
    [setBrowserOpen, threadRef],
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
