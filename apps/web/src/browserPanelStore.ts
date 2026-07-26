/**
 * Zustand store for the in-app browser panel, keyed by scoped thread identity.
 *
 * The panel is per-thread because what you are looking at belongs to the work
 * you are doing: opening a second thread should not inherit the first one's
 * page. The split ratio is deliberately *not* per-thread — it is a window
 * preference, and having the columns jump width when you switch threads would
 * be worse than having one ratio you set once.
 */

import { scopedThreadKey } from "@threadlines/client-runtime";
import { type ScopedThreadRef } from "@threadlines/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** Named viewports, so "does this work on a phone" is one click rather than arithmetic. */
export const BROWSER_VIEWPORT_PRESETS = [
  { id: "fill", label: "Fill", width: null, height: null },
  { id: "iphone-15", label: "iPhone 15", width: 393, height: 852 },
  { id: "ipad", label: "iPad", width: 834, height: 1112 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
] as const;

export type BrowserViewportPresetId = (typeof BROWSER_VIEWPORT_PRESETS)[number]["id"];

export interface ThreadBrowserState {
  open: boolean;
  /** The address currently loaded, or null before the panel has been pointed anywhere. */
  url: string | null;
  viewportPresetId: BrowserViewportPresetId;
}

const BROWSER_PANEL_STORAGE_KEY = "threadlines:browser-panel:v1";

/**
 * Fraction of the split occupied by the chat column. Clamped rather than free:
 * either pane below roughly a third stops being usable, and a browser squeezed
 * to a sliver is worse than a closed one.
 */
export const BROWSER_SPLIT_MIN_CHAT_FRACTION = 0.3;
export const BROWSER_SPLIT_MAX_CHAT_FRACTION = 0.7;
export const DEFAULT_BROWSER_SPLIT_CHAT_FRACTION = 0.5;

const DEFAULT_THREAD_BROWSER_STATE: ThreadBrowserState = {
  open: false,
  url: null,
  viewportPresetId: "fill",
};

export function clampBrowserSplitFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) {
    return DEFAULT_BROWSER_SPLIT_CHAT_FRACTION;
  }
  return Math.min(
    BROWSER_SPLIT_MAX_CHAT_FRACTION,
    Math.max(BROWSER_SPLIT_MIN_CHAT_FRACTION, fraction),
  );
}

interface BrowserPanelStoreState {
  browserStateByThreadKey: Record<string, ThreadBrowserState>;
  splitChatFraction: number;
  setBrowserOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  toggleBrowserOpen: (threadRef: ScopedThreadRef) => void;
  setBrowserUrl: (threadRef: ScopedThreadRef, url: string) => void;
  setViewportPreset: (threadRef: ScopedThreadRef, presetId: BrowserViewportPresetId) => void;
  setSplitChatFraction: (fraction: number) => void;
}

function updateThread(
  state: BrowserPanelStoreState,
  threadRef: ScopedThreadRef,
  patch: Partial<ThreadBrowserState>,
): Pick<BrowserPanelStoreState, "browserStateByThreadKey"> {
  const key = scopedThreadKey(threadRef);
  const current = state.browserStateByThreadKey[key] ?? DEFAULT_THREAD_BROWSER_STATE;
  return {
    browserStateByThreadKey: {
      ...state.browserStateByThreadKey,
      [key]: { ...current, ...patch },
    },
  };
}

export const useBrowserPanelStore = create<BrowserPanelStoreState>()(
  persist(
    (set) => ({
      browserStateByThreadKey: {},
      splitChatFraction: DEFAULT_BROWSER_SPLIT_CHAT_FRACTION,
      setBrowserOpen: (threadRef, open) => set((state) => updateThread(state, threadRef, { open })),
      toggleBrowserOpen: (threadRef) =>
        set((state) => {
          const current = selectThreadBrowserState(state.browserStateByThreadKey, threadRef);
          return updateThread(state, threadRef, { open: !current.open });
        }),
      setBrowserUrl: (threadRef, url) => set((state) => updateThread(state, threadRef, { url })),
      setViewportPreset: (threadRef, viewportPresetId) =>
        set((state) => updateThread(state, threadRef, { viewportPresetId })),
      setSplitChatFraction: (fraction) =>
        set(() => ({ splitChatFraction: clampBrowserSplitFraction(fraction) })),
    }),
    {
      name: BROWSER_PANEL_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        browserStateByThreadKey: state.browserStateByThreadKey,
        splitChatFraction: state.splitChatFraction,
      }),
    },
  ),
);

export function selectThreadBrowserState(
  browserStateByThreadKey: Record<string, ThreadBrowserState>,
  threadRef: ScopedThreadRef | null,
): ThreadBrowserState {
  if (threadRef === null) {
    return DEFAULT_THREAD_BROWSER_STATE;
  }
  return browserStateByThreadKey[scopedThreadKey(threadRef)] ?? DEFAULT_THREAD_BROWSER_STATE;
}
