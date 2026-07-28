/**
 * Zustand store for the in-app browser panel, keyed by scoped thread identity.
 *
 * Tabs belong to a thread because what you are looking at belongs to the work
 * you are doing: opening a second thread should not inherit the first one's
 * pages. The split ratio is deliberately *not* per-thread -- it is a window
 * preference, and having the columns jump width when you switch threads would
 * be worse than having one ratio you set once.
 */

import { scopedThreadKey } from "@threadlines/client-runtime";
import { type ScopedThreadRef } from "@threadlines/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { rememberVisit, type VisitedUrl } from "./components/browser/urlCompletion";

import { resolveStorage } from "./lib/storage";

/**
 * Named sizes, as shortcuts for filling in a width and height rather than as
 * the only way to choose one. Any size is reachable by typing it.
 */
export const BROWSER_VIEWPORT_PRESETS = [
  { label: "Responsive", width: null, height: null },
  { label: "iPhone 15", width: 393, height: 852 },
  { label: "iPad", width: 834, height: 1112 },
  { label: "Laptop", width: 1280, height: 800 },
] as const;

/** null dimensions mean the page fills the panel and reflows with it. */
export interface BrowserViewport {
  width: number | null;
  height: number | null;
}

export const RESPONSIVE_VIEWPORT: BrowserViewport = Object.freeze({ width: null, height: null });

/** Follows the app unless deliberately overridden for the page under test. */
export type BrowserAppearance = "system" | "light" | "dark";

export interface BrowserTab {
  id: string;
  /** The address loaded, or null for a tab that has not been pointed anywhere. */
  url: string | null;
  /** The page's own title, used as the tab label once it has one. */
  title: string | null;
  /** Per-tab, because the viewport belongs to the thing you are looking at. */
  viewport: BrowserViewport;
  zoomFactor: number;
}

export interface ThreadBrowserState {
  open: boolean;
  tabs: BrowserTab[];
  activeTabId: string;
}

const BROWSER_PANEL_STORAGE_KEY = "threadlines:browser-panel:v2";

/**
 * Fraction of the split occupied by the chat column. Clamped rather than free:
 * either pane below roughly a third stops being usable, and a browser squeezed
 * to a sliver is worse than a closed one.
 */
export const BROWSER_SPLIT_MIN_CHAT_FRACTION = 0.3;
export const BROWSER_SPLIT_MAX_CHAT_FRACTION = 0.7;
export const DEFAULT_BROWSER_SPLIT_CHAT_FRACTION = 0.5;

let tabSequence = 0;
function nextTabId(): string {
  tabSequence += 1;
  return `tab-${Date.now().toString(36)}-${tabSequence}`;
}

export function makeBrowserTab(): BrowserTab {
  return { id: nextTabId(), url: null, title: null, viewport: RESPONSIVE_VIEWPORT, zoomFactor: 1 };
}

/**
 * The state a thread has before it has any of its own.
 *
 * A single frozen value rather than a freshly built one: selectors run on every
 * render, and returning a new object each time makes the store look like it
 * changed on every read -- React then re-renders forever. It also keeps the
 * first tab's id stable, so the tab does not remount the moment the thread
 * gains real state.
 */
const DEFAULT_TAB: BrowserTab = Object.freeze({
  id: "tab-initial",
  url: null,
  title: null,
  viewport: RESPONSIVE_VIEWPORT,
  zoomFactor: 1,
});

const DEFAULT_THREAD_STATE: ThreadBrowserState = Object.freeze({
  open: false,
  tabs: [DEFAULT_TAB],
  activeTabId: DEFAULT_TAB.id,
});

const EMPTY_THREAD_STATE: ThreadBrowserState = Object.freeze({
  open: false,
  tabs: [],
  activeTabId: "",
});

/** Chrome's range, so the familiar steps land on familiar numbers. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export function clampZoomFactor(factor: number): number {
  if (!Number.isFinite(factor)) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, factor));
}

/** The next step up or down, so zooming lands on round values rather than drifting. */
export function steppedZoom(current: number, direction: 1 | -1): number {
  const steps = direction === 1 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((step) =>
    direction === 1 ? step > current + 0.001 : step < current - 0.001,
  );
  return next ?? clampZoomFactor(current);
}

export function clampBrowserSplitFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) {
    return DEFAULT_BROWSER_SPLIT_CHAT_FRACTION;
  }
  return Math.min(
    BROWSER_SPLIT_MAX_CHAT_FRACTION,
    Math.max(BROWSER_SPLIT_MIN_CHAT_FRACTION, fraction),
  );
}

/**
 * Which tab to select when the active one closes.
 *
 * The neighbour to the right, falling back to the left at the end of the strip:
 * closing several in a row then walks along rather than jumping to an end.
 */
export function nextActiveTabId(
  tabs: readonly BrowserTab[],
  closedId: string,
  activeId: string,
): string | null {
  const remaining = tabs.filter((tab) => tab.id !== closedId);
  if (remaining.length === 0) {
    return null;
  }
  if (closedId !== activeId) {
    return activeId;
  }
  const closedIndex = tabs.findIndex((tab) => tab.id === closedId);
  return (remaining[closedIndex] ?? remaining[remaining.length - 1])!.id;
}

/**
 * The live `<webview>` elements, by thread and tab.
 *
 * Deliberately not in the store's state: these are DOM nodes, they change on
 * every tab mount, and nothing renders from them -- the automation host is the
 * only caller, and it wants the current element rather than a re-render. Kept
 * here rather than in the panel because the host now outlives the panel.
 */
export interface PreviewWebviewHandle {
  getWebContentsId: () => number;
  loadURL: (url: string) => Promise<void>;
  getBoundingClientRect: () => DOMRect;
}

/**
 * A <webview> rejects imperative calls until its guest has attached and fired
 * dom-ready. Navigation still happens: `src` is bound to the tab's url, so a
 * tab created and immediately pointed somewhere loads from the attribute once
 * it is ready. This helper keeps that race from surfacing as an error.
 */
export function callWhenReady<T>(action: () => T): T | null {
  try {
    return action();
  } catch {
    return null;
  }
}

const webviewRegistry = new Map<string, PreviewWebviewHandle>();
const webviewListeners = new Set<() => void>();

function webviewKey(threadRef: ScopedThreadRef, tabId: string): string {
  return `${scopedThreadKey(threadRef)}::${tabId}`;
}

export function registerPreviewWebview(
  threadRef: ScopedThreadRef,
  tabId: string,
  element: PreviewWebviewHandle | null,
): void {
  const key = webviewKey(threadRef, tabId);
  if (element === null) {
    webviewRegistry.delete(key);
  } else {
    webviewRegistry.set(key, element);
  }
  for (const listener of webviewListeners) {
    listener();
  }
}

export function getPreviewWebview(
  threadRef: ScopedThreadRef,
  tabId: string,
): PreviewWebviewHandle | null {
  return webviewRegistry.get(webviewKey(threadRef, tabId)) ?? null;
}

export function subscribePreviewWebviews(listener: () => void): () => void {
  webviewListeners.add(listener);
  return () => {
    webviewListeners.delete(listener);
  };
}

/** Test seam: the registry outlives any one component, so tests clear it. */
export function resetPreviewWebviewsForTests(): void {
  webviewRegistry.clear();
  webviewListeners.clear();
}

/**
 * Waits for a page to exist, for as long as it is worth waiting.
 *
 * Opening the panel is not instant: the element mounts, attaches, and only then
 * has a webContents to drive. The agent's call arrives before all of that, so
 * it waits here rather than being told there is no browser -- but it waits
 * against a cap well under the broker's own timeout, so a panel that never
 * comes up answers the agent instead of hanging it.
 */
export async function waitForPreviewWebview<T>(input: {
  readonly resolve: () => T | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly timeoutMs: number;
  readonly setTimeoutFn?: typeof globalThis.setTimeout;
  readonly clearTimeoutFn?: typeof globalThis.clearTimeout;
}): Promise<T | null> {
  const immediate = input.resolve();
  if (immediate !== null) {
    return immediate;
  }
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;

  return await new Promise<T | null>((resolvePromise) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      unsubscribe();
      resolvePromise(value);
    };
    const unsubscribe = input.subscribe(() => {
      const candidate = input.resolve();
      if (candidate !== null) {
        finish(candidate);
      }
    });
    const timer = setTimeoutFn(() => finish(null), input.timeoutMs);
    // Racing the subscription: registration may have landed between the first
    // check and the listener going on.
    const late = input.resolve();
    if (late !== null) {
      finish(late);
    }
  });
}

/** How long an agent's call waits for the panel it just opened to have a page. */
export const PREVIEW_WEBVIEW_WAIT_MS = 5_000;

/**
 * What the agent is doing in a thread's browser.
 *
 * In the store rather than in the panel because the host that produces it now
 * outlives the panel that draws it: an agent can act on a page while the panel
 * is closed, and when it opens the panel has to already know where the pointer
 * went and which tab is the agent's.
 */
export interface ThreadBrowserAgentState {
  /** The tab the agent pinned itself to; null until it acts. */
  tabId: string | null;
  point: { x: number; y: number; from?: { x: number; y: number }; sequence: number } | null;
  activity: {
    phase: "running" | "done";
    verb: string;
    detail: string | null;
    sequence: number;
  } | null;
}

export const EMPTY_AGENT_STATE: ThreadBrowserAgentState = Object.freeze({
  tabId: null,
  point: null,
  activity: null,
});

/**
 * A site something tried to reach that this project has not approved.
 *
 * One at a time per thread, and deliberately not persisted: it is a question
 * being asked right now, and a question that survived a restart would be asked
 * about a page nobody is looking at any more.
 */
export interface PendingBrowserApproval {
  readonly host: string;
  /** The address to load once allowed, so the answer is the page, not a retry. */
  readonly url: string;
}

interface BrowserPanelStoreState {
  browserStateByThreadKey: Record<string, ThreadBrowserState>;
  agentStateByThreadKey: Record<string, ThreadBrowserAgentState>;
  pendingApprovalByThreadKey: Record<string, PendingBrowserApproval | null>;
  splitChatFraction: number;
  /** Hides the chat so the page gets the whole centre; the split is remembered. */
  expanded: boolean;
  /**
   * The device row is off by default. Sizing is an occasional task, and a
   * permanent control for it costs toolbar width on every page you ever look
   * at, which is the wrong trade for something used a few times a session.
   */
  deviceToolbarOpen: boolean;
  appearance: BrowserAppearance;
  setBrowserOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  toggleBrowserOpen: (threadRef: ScopedThreadRef) => void;
  openTab: (threadRef: ScopedThreadRef) => void;
  /**
   * A new tab that already knows where it is going.
   *
   * Separate from `openTab` + `setTabUrl` because the tab's `<webview>` fixes
   * its source at mount: created blank and pointed afterwards, the page would
   * need an imperative load that cannot happen until the element attaches.
   */
  openTabWithUrl: (threadRef: ScopedThreadRef, url: string) => void;
  closeTab: (threadRef: ScopedThreadRef, tabId: string) => void;
  selectTab: (threadRef: ScopedThreadRef, tabId: string) => void;
  setTabUrl: (threadRef: ScopedThreadRef, tabId: string, url: string) => void;
  /**
   * Every address this browser has been to, for finishing what you type.
   *
   * Deliberately not per thread. You visit the same handful of sites whatever
   * you happen to be working on, and history that resets with the conversation
   * would never learn anything.
   */
  visitedUrls: ReadonlyArray<VisitedUrl>;
  setTabTitle: (threadRef: ScopedThreadRef, tabId: string, title: string) => void;
  setTabViewport: (threadRef: ScopedThreadRef, tabId: string, viewport: BrowserViewport) => void;
  setTabZoom: (threadRef: ScopedThreadRef, tabId: string, zoomFactor: number) => void;
  toggleDeviceToolbar: () => void;
  setAppearance: (appearance: BrowserAppearance) => void;
  setAgentTab: (threadRef: ScopedThreadRef, tabId: string | null) => void;
  setAgentPoint: (
    threadRef: ScopedThreadRef,
    point: { x: number; y: number; from?: { x: number; y: number } } | null,
  ) => void;
  setAgentActivity: (
    threadRef: ScopedThreadRef,
    activity: ThreadBrowserAgentState["activity"],
  ) => void;
  setPendingBrowserApproval: (
    threadRef: ScopedThreadRef,
    approval: PendingBrowserApproval | null,
  ) => void;
  setSplitChatFraction: (fraction: number) => void;
  toggleExpanded: () => void;
}

function updateThread(
  state: BrowserPanelStoreState,
  threadRef: ScopedThreadRef,
  update: (current: ThreadBrowserState) => ThreadBrowserState,
): Pick<BrowserPanelStoreState, "browserStateByThreadKey"> {
  const key = scopedThreadKey(threadRef);
  const current = state.browserStateByThreadKey[key] ?? DEFAULT_THREAD_STATE;
  return {
    browserStateByThreadKey: { ...state.browserStateByThreadKey, [key]: update(current) },
  };
}

function updateAgentState(
  state: BrowserPanelStoreState,
  threadRef: ScopedThreadRef,
  update: (current: ThreadBrowserAgentState) => ThreadBrowserAgentState,
): Pick<BrowserPanelStoreState, "agentStateByThreadKey"> {
  const key = scopedThreadKey(threadRef);
  const current = state.agentStateByThreadKey[key] ?? EMPTY_AGENT_STATE;
  return { agentStateByThreadKey: { ...state.agentStateByThreadKey, [key]: update(current) } };
}

function updateTab(
  current: ThreadBrowserState,
  tabId: string,
  patch: Partial<BrowserTab>,
): ThreadBrowserState {
  return {
    ...current,
    tabs: current.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
  };
}

export const useBrowserPanelStore = create<BrowserPanelStoreState>()(
  persist(
    (set) => ({
      browserStateByThreadKey: {},
      agentStateByThreadKey: {},
      pendingApprovalByThreadKey: {},
      splitChatFraction: DEFAULT_BROWSER_SPLIT_CHAT_FRACTION,
      expanded: false,
      deviceToolbarOpen: false,
      appearance: "system",
      setBrowserOpen: (threadRef, open) =>
        set((state) => updateThread(state, threadRef, (current) => ({ ...current, open }))),
      toggleBrowserOpen: (threadRef) =>
        set((state) =>
          updateThread(state, threadRef, (current) => ({ ...current, open: !current.open })),
        ),
      openTab: (threadRef) =>
        set((state) =>
          updateThread(state, threadRef, (current) => {
            const tab = makeBrowserTab();
            return { ...current, tabs: [...current.tabs, tab], activeTabId: tab.id };
          }),
        ),
      openTabWithUrl: (threadRef, url) =>
        set((state) => ({
          ...updateThread(state, threadRef, (current) => {
            const tab = { ...makeBrowserTab(), url };
            return { ...current, tabs: [...current.tabs, tab], activeTabId: tab.id };
          }),
          visitedUrls: rememberVisit(state.visitedUrls, url, Date.now()),
        })),
      closeTab: (threadRef, tabId) =>
        set((state) =>
          updateThread(state, threadRef, (current) => {
            const nextActive = nextActiveTabId(current.tabs, tabId, current.activeTabId);
            if (nextActive === null) {
              // Never leave the panel with no tab at all: closing the last one
              // resets to a blank tab rather than an empty frame.
              const replacement = makeBrowserTab();
              return { ...current, tabs: [replacement], activeTabId: replacement.id };
            }
            return {
              ...current,
              tabs: current.tabs.filter((tab) => tab.id !== tabId),
              activeTabId: nextActive,
            };
          }),
        ),
      selectTab: (threadRef, tabId) =>
        set((state) =>
          updateThread(state, threadRef, (current) => ({ ...current, activeTabId: tabId })),
        ),
      visitedUrls: [],
      setTabUrl: (threadRef, tabId, url) =>
        set((state) => ({
          ...updateThread(state, threadRef, (current) => updateTab(current, tabId, { url })),
          // Recorded here rather than on submit, so a redirect lands the address
          // you end up at instead of the one you typed on the way.
          visitedUrls: rememberVisit(state.visitedUrls, url, Date.now()),
        })),
      setTabTitle: (threadRef, tabId, title) =>
        set((state) =>
          updateThread(state, threadRef, (current) => updateTab(current, tabId, { title })),
        ),
      setTabViewport: (threadRef, tabId, viewport) =>
        set((state) =>
          updateThread(state, threadRef, (current) => updateTab(current, tabId, { viewport })),
        ),
      setTabZoom: (threadRef, tabId, zoomFactor) =>
        set((state) =>
          updateThread(state, threadRef, (current) =>
            updateTab(current, tabId, { zoomFactor: clampZoomFactor(zoomFactor) }),
          ),
        ),
      toggleDeviceToolbar: () => set((state) => ({ deviceToolbarOpen: !state.deviceToolbarOpen })),
      setAppearance: (appearance) => set(() => ({ appearance })),
      setAgentTab: (threadRef, tabId) =>
        set((state) => updateAgentState(state, threadRef, (current) => ({ ...current, tabId }))),
      setAgentPoint: (threadRef, point) =>
        set((state) =>
          updateAgentState(state, threadRef, (current) => ({
            ...current,
            point:
              point === null ? null : { ...point, sequence: (current.point?.sequence ?? 0) + 1 },
          })),
        ),
      setAgentActivity: (threadRef, activity) =>
        set((state) => updateAgentState(state, threadRef, (current) => ({ ...current, activity }))),
      setPendingBrowserApproval: (threadRef, approval) =>
        set((state) => ({
          pendingApprovalByThreadKey: {
            ...state.pendingApprovalByThreadKey,
            [scopedThreadKey(threadRef)]: approval,
          },
        })),
      setSplitChatFraction: (fraction) =>
        set(() => ({ splitChatFraction: clampBrowserSplitFraction(fraction) })),
      toggleExpanded: () => set((state) => ({ expanded: !state.expanded })),
    }),
    {
      name: BROWSER_PANEL_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        browserStateByThreadKey: state.browserStateByThreadKey,
        splitChatFraction: state.splitChatFraction,
        deviceToolbarOpen: state.deviceToolbarOpen,
        appearance: state.appearance,
        visitedUrls: state.visitedUrls,
        // Expansion is deliberately not persisted: reopening the app to a
        // hidden chat would look like the thread had vanished.
      }),
    },
  ),
);

export function selectThreadBrowserState(
  browserStateByThreadKey: Record<string, ThreadBrowserState>,
  threadRef: ScopedThreadRef | null,
): ThreadBrowserState {
  if (threadRef === null) {
    return EMPTY_THREAD_STATE;
  }
  const stored = browserStateByThreadKey[scopedThreadKey(threadRef)];
  // A thread with no stored entry has one blank tab, so callers never have to
  // reason about a panel with nothing in it.
  return stored === undefined || stored.tabs.length === 0 ? DEFAULT_THREAD_STATE : stored;
}

export function selectThreadAgentState(
  agentStateByThreadKey: Record<string, ThreadBrowserAgentState>,
  threadRef: ScopedThreadRef | null,
): ThreadBrowserAgentState {
  if (threadRef === null) {
    return EMPTY_AGENT_STATE;
  }
  return agentStateByThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_AGENT_STATE;
}

export function selectPendingBrowserApproval(
  pendingApprovalByThreadKey: Record<string, PendingBrowserApproval | null>,
  threadRef: ScopedThreadRef | null,
): PendingBrowserApproval | null {
  if (threadRef === null) {
    return null;
  }
  return pendingApprovalByThreadKey[scopedThreadKey(threadRef)] ?? null;
}

export function selectActiveTab(state: ThreadBrowserState): BrowserTab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
}
