import { useCallback } from "react";
import type { ScopedThreadRef } from "@threadlines/contracts";

import {
  PREVIEW_WEBVIEW_WAIT_MS,
  getPreviewWebview,
  selectActiveTab,
  selectThreadAgentState,
  selectThreadBrowserState,
  subscribePreviewWebviews,
  useBrowserPanelStore,
  waitForPreviewWebview,
  type PreviewWebviewHandle,
} from "../../browserPanelStore";
import { normalizePreviewUrl } from "./previewUrl";
import {
  usePreviewAutomationHost,
  type PreviewAutomationHostTarget,
} from "./previewAutomationHost";

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
export function PreviewAutomationMount({ threadRef }: { threadRef: ScopedThreadRef }) {
  const setBrowserOpen = useBrowserPanelStore((store) => store.setBrowserOpen);
  const setAgentTab = useBrowserPanelStore((store) => store.setAgentTab);
  const setAgentPoint = useBrowserPanelStore((store) => store.setAgentPoint);
  const setAgentActivity = useBrowserPanelStore((store) => store.setAgentActivity);
  const selectTab = useBrowserPanelStore((store) => store.selectTab);
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);

  /**
   * Reads the world at the moment the agent acts, not at the moment this
   * component rendered: an operation may arrive many renders after the host
   * subscribed, and it must see the tab that exists now.
   */
  const resolveTarget = useCallback((): PreviewAutomationHostTarget => {
    const store = useBrowserPanelStore.getState();
    const browserState = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
    const agentState = selectThreadAgentState(store.agentStateByThreadKey, threadRef);
    const activeTabId = selectActiveTab(browserState)?.id ?? "";
    // The agent keeps the tab it pinned, as long as that tab still exists.
    const pinned = agentState.tabId;
    const tabId =
      pinned !== null && browserState.tabs.some((tab) => tab.id === pinned) ? pinned : activeTabId;
    if (tabId !== pinned) {
      setAgentTab(threadRef, tabId === "" ? null : tabId);
    }
    const webview = tabId === "" ? null : getPreviewWebview(threadRef, tabId);

    return {
      webContentsId: webview === null ? null : webview.getWebContentsId(),
      onAgentPoint: (point) => setAgentPoint(threadRef, point),
      onAgentActivity: (activity) => setAgentActivity(threadRef, activity),
      selectTab: (index) => {
        const chosen = browserState.tabs[index];
        if (chosen === undefined) {
          return;
        }
        // Move the pin with the view, or the agent would keep acting on the tab
        // it was pinned to while showing you another.
        setAgentTab(threadRef, chosen.id);
        selectTab(threadRef, chosen.id);
      },
      tabs: () =>
        browserState.tabs.map((entry) => ({
          title: entry.title ?? "",
          url: entry.url ?? "",
          active: entry.id === activeTabId,
          agent: entry.id === tabId,
        })),
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
        setTabUrl(threadRef, tabId, normalized);
        await getPreviewWebview(threadRef, tabId)?.loadURL(normalized);
      },
    };
  }, [selectTab, setAgentActivity, setAgentPoint, setAgentTab, setTabUrl, threadRef]);

  /**
   * Opens the panel for an arriving operation and waits for it to have a page.
   *
   * Only the wait is conditional: with the panel already open this resolves on
   * the first look, which is the common case and stays exactly as fast as it
   * was.
   */
  const prepare = useCallback(async (): Promise<void> => {
    const store = useBrowserPanelStore.getState();
    const browserState = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
    if (!browserState.open) {
      setBrowserOpen(threadRef, true);
    }
    await waitForPreviewWebview<PreviewWebviewHandle>({
      resolve: () => {
        const current = useBrowserPanelStore.getState();
        const state = selectThreadBrowserState(current.browserStateByThreadKey, threadRef);
        const agent = selectThreadAgentState(current.agentStateByThreadKey, threadRef);
        const activeTabId = selectActiveTab(state)?.id ?? "";
        const pinned = agent.tabId;
        const tabId =
          pinned !== null && state.tabs.some((tab) => tab.id === pinned) ? pinned : activeTabId;
        return tabId === "" ? null : getPreviewWebview(threadRef, tabId);
      },
      subscribe: subscribePreviewWebviews,
      timeoutMs: PREVIEW_WEBVIEW_WAIT_MS,
    });
    // A timeout is not handled here: the host answers a missing page with the
    // error it has always used for one, so a panel that never came up reads the
    // same as a panel with nothing loaded.
  }, [setBrowserOpen, threadRef]);

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
