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

interface BrowserPanelStoreState {
  browserStateByThreadKey: Record<string, ThreadBrowserState>;
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

export function selectActiveTab(state: ThreadBrowserState): BrowserTab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
}
