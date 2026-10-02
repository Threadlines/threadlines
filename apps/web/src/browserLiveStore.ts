import { scopedThreadKey } from "@threadlines/client-runtime";
import type { ProjectId, ScopedThreadRef } from "@threadlines/contracts";
import { create } from "zustand";

/**
 * Which threads have a running browser, and which one is on screen.
 *
 * A thread's pages live in the app-wide browser layer, not in its panel, so
 * they keep running when you look at another thread and an agent can use them
 * meanwhile. This is the layer's state: the panel says when it is showing a
 * thread, agent requests start browsers for threads nobody is showing, and the
 * lifecycle loop steps idle pages down and closes the oldest.
 *
 * Not persisted: a running page cannot outlive the app, and tab addresses are
 * already kept by the panel store.
 */

export interface LiveThreadBrowser {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}

/** A page's state in the layer, beyond what the panel store keeps per tab. */
export interface LivePageState {
  /** Painted though hidden, so an agent can take a screenshot. */
  readonly drawn: boolean;
  /** Closed to save memory; its tab reloads its address when next used. */
  readonly evicted: boolean;
}

const DEFAULT_PAGE_STATE: LivePageState = Object.freeze({ drawn: false, evicted: false });

export interface BrowserNavState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
}

export const IDLE_NAV_STATE: BrowserNavState = Object.freeze({
  canGoBack: false,
  canGoForward: false,
  loading: false,
});

interface BrowserLiveStoreState {
  liveByThreadKey: Record<string, LiveThreadBrowser>;
  /** The thread whose browser panel is on screen, if any. */
  shownThreadKey: string | null;
  /** The panel's page area, last measured: the size hidden pages keep. */
  slotSize: { width: number; height: number } | null;
  /** Per thread, so a change to one page re-renders only its own thread's view. */
  pageStateByThreadKey: Record<string, Record<string, LivePageState>>;
  /** The visible tab's back/forward/loading, for the panel's toolbar. */
  navStateByThreadKey: Record<string, BrowserNavState>;
  /** Where the panel draws things over the page; see `BrowserHostLayer`. */
  overlayElement: HTMLElement | null;

  ensureLive: (threadRef: ScopedThreadRef, projectId: ProjectId) => void;
  closeLive: (threadRef: ScopedThreadRef) => void;
  setShown: (threadRef: ScopedThreadRef | null) => void;
  setSlotSize: (size: { width: number; height: number }) => void;
  setPageState: (threadRef: ScopedThreadRef, tabId: string, patch: Partial<LivePageState>) => void;
  setNavState: (threadRef: ScopedThreadRef, state: BrowserNavState) => void;
  setOverlayElement: (element: HTMLElement | null) => void;
}

/** One page: a thread's tab. */
export function livePageKey(threadRef: ScopedThreadRef, tabId: string): string {
  return `${scopedThreadKey(threadRef)}\n${tabId}`;
}

export const useBrowserLiveStore = create<BrowserLiveStoreState>()((set) => ({
  liveByThreadKey: {},
  shownThreadKey: null,
  slotSize: null,
  pageStateByThreadKey: {},
  navStateByThreadKey: {},
  overlayElement: null,

  ensureLive: (threadRef, projectId) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      const existing = state.liveByThreadKey[key];
      if (existing !== undefined && existing.projectId === projectId) {
        return state;
      }
      return { liveByThreadKey: { ...state.liveByThreadKey, [key]: { threadRef, projectId } } };
    }),
  closeLive: (threadRef) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if (state.liveByThreadKey[key] === undefined) {
        return state;
      }
      const { [key]: _closed, ...liveByThreadKey } = state.liveByThreadKey;
      const { [key]: _pages, ...pageStateByThreadKey } = state.pageStateByThreadKey;
      const { [key]: _nav, ...navStateByThreadKey } = state.navStateByThreadKey;
      return { liveByThreadKey, pageStateByThreadKey, navStateByThreadKey };
    }),
  setShown: (threadRef) =>
    set((state) => {
      const key = threadRef === null ? null : scopedThreadKey(threadRef);
      return state.shownThreadKey === key ? state : { shownThreadKey: key };
    }),
  setSlotSize: (size) =>
    set((state) =>
      state.slotSize?.width === size.width && state.slotSize.height === size.height
        ? state
        : { slotSize: size },
    ),
  setPageState: (threadRef, tabId, patch) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      const pages = state.pageStateByThreadKey[key] ?? NO_PAGE_STATES;
      const current = pages[tabId] ?? DEFAULT_PAGE_STATE;
      const next = { ...current, ...patch };
      if (next.drawn === current.drawn && next.evicted === current.evicted) {
        return state;
      }
      return {
        pageStateByThreadKey: {
          ...state.pageStateByThreadKey,
          [key]: { ...pages, [tabId]: next },
        },
      };
    }),
  setNavState: (threadRef, navState) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      const current = state.navStateByThreadKey[key];
      if (
        current?.canGoBack === navState.canGoBack &&
        current.canGoForward === navState.canGoForward &&
        current.loading === navState.loading
      ) {
        return state;
      }
      return { navStateByThreadKey: { ...state.navStateByThreadKey, [key]: navState } };
    }),
  setOverlayElement: (element) =>
    set((state) => (state.overlayElement === element ? state : { overlayElement: element })),
}));

const NO_PAGE_STATES: Record<string, LivePageState> = Object.freeze({});

/** One thread's page states, stable while none of them changes. */
export function selectThreadPageStates(
  pageStateByThreadKey: Record<string, Record<string, LivePageState>>,
  threadRef: ScopedThreadRef,
): Record<string, LivePageState> {
  return pageStateByThreadKey[scopedThreadKey(threadRef)] ?? NO_PAGE_STATES;
}

export function selectLivePageState(
  pageStateByThreadKey: Record<string, Record<string, LivePageState>>,
  threadRef: ScopedThreadRef,
  tabId: string,
): LivePageState {
  return selectThreadPageStates(pageStateByThreadKey, threadRef)[tabId] ?? DEFAULT_PAGE_STATE;
}

export function resetBrowserLiveStoreForTests(): void {
  useBrowserLiveStore.setState({
    liveByThreadKey: {},
    shownThreadKey: null,
    slotSize: null,
    pageStateByThreadKey: {},
    navStateByThreadKey: {},
    overlayElement: null,
  });
}
