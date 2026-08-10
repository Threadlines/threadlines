import { type RefCallback, useCallback, useEffect, useRef } from "react";

import { type DiffRouteSearch, isSourceControlPanelOpen } from "./diffRouteSearch";
import { isElectron } from "./env";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useSettings } from "./hooks/useSettings";

export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";

export const RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_sidebar_width";
export const RIGHT_PANEL_INLINE_LEGACY_DEFAULT_WIDTH = 17 * 16;
export const RIGHT_PANEL_INLINE_SIDEBAR_MIN_CONTENT_WIDTH = 15 * 16;
// Keep in sync with --app-window-resize-edge-inset in index.css. The right
// panel reserves this space inside its border box in Electron, so the outer
// min width needs to include it for the visible content area to match the left.
const RIGHT_PANEL_INLINE_ELECTRON_RESIZE_EDGE_INSET_WIDTH = 6;
export const RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH =
  RIGHT_PANEL_INLINE_SIDEBAR_MIN_CONTENT_WIDTH +
  (isElectron ? RIGHT_PANEL_INLINE_ELECTRON_RESIZE_EDGE_INSET_WIDTH : 0);
export const RIGHT_PANEL_INLINE_DEFAULT_WIDTH = `${RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH}px`;
export const RIGHT_PANEL_INLINE_SIDEBAR_MAX_WIDTH = 256 * 16;

// Both right-panel sheets start below the chat header (measured into
// --chat-header-bottom, which already accounts for any titlebar) so the
// header's toggles stay visible and interactive while a panel is open. The
// popups re-enable pointer events because their shared viewport disables
// them to let presses over the header reach the header.
const RIGHT_PANEL_SHEET_BELOW_HEADER_CLASS_NAME =
  "pointer-events-auto mt-[var(--chat-header-bottom)] h-[calc(100%-var(--chat-header-bottom))] max-h-[calc(100%-var(--chat-header-bottom))] p-0";
// Diff sheet width tiers: desktop keeps the fixed panel, the 640-760px band
// keeps the near-full 88vw sheet (disjoint `sm:max-[760px]:` so no cascade
// ordering is relied on), and phones go full width.
export const RIGHT_PANEL_SHEET_CLASS_NAME = `${RIGHT_PANEL_SHEET_BELOW_HEADER_CLASS_NAME} w-[min(42vw,28rem)] min-w-80 max-w-[28rem] sm:max-[760px]:w-[min(88vw,24rem)] sm:max-[760px]:min-w-0 max-sm:w-full max-sm:min-w-0 max-sm:max-w-none`;
// Phones keep source control at the same fixed width as everywhere else so it
// overlays as a partial sheet (matching the app sidebar's rendered mobile
// width) with a slice of the conversation visible and tappable to dismiss.
export const RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME = `${RIGHT_PANEL_SHEET_BELOW_HEADER_CLASS_NAME} w-[var(--right-panel-inline-min-width)] min-w-[var(--right-panel-inline-min-width)] max-w-[var(--right-panel-inline-min-width)]`;
export const RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME = "pointer-events-none";
export const RIGHT_PANEL_SHEET_BACKDROP_CLASS_NAME = "mt-[var(--chat-header-bottom)]";

export const CHAT_HEADER_BOTTOM_CSS_VAR = "--chat-header-bottom";

/**
 * Publishes the chat header's bottom edge (in viewport px) as a root-level CSS
 * variable so body-portaled overlays can align to it. Attach the returned ref
 * to the chat header element.
 *
 * The value is a viewport-relative position, so it must be re-measured when
 * the header moves, not just when it resizes: mobile browsers scroll the
 * layout viewport to reveal a focused input under the on-screen keyboard, and
 * a publish captured in that state would otherwise stick until the next
 * header resize. Clamping keeps a mid-scroll measurement from pulling the
 * overlays above the viewport, and the last value survives header unmounts
 * (loading states, thread switches) so an open sheet doesn't snap to the top
 * before the header remounts and republishes.
 */
export function useChatHeaderBottomVarRef(): RefCallback<HTMLElement> {
  return useCallback((node: HTMLElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const rootStyle = document.documentElement.style;
    const publish = () => {
      rootStyle.setProperty(
        CHAT_HEADER_BOTTOM_CSS_VAR,
        `${Math.max(0, node.getBoundingClientRect().bottom)}px`,
      );
    };
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    const viewport = window.visualViewport;
    window.addEventListener("scroll", publish, { passive: true });
    viewport?.addEventListener("resize", publish);
    viewport?.addEventListener("scroll", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", publish);
      viewport?.removeEventListener("resize", publish);
      viewport?.removeEventListener("scroll", publish);
    };
  }, []);
}

/**
 * Last explicit panel state per thread. The URL only carries explicit state
 * until the next thread navigation drops it, so without this memory an open
 * panel silently closes on the A -> B -> A round trip. Session-scoped on
 * purpose: a fresh launch starts from the settings default again.
 */
const sourceControlPanelStateByThreadKey = new Map<string, "1" | "0">();

/**
 * Memory key for a draft route's panel state, distinct from the
 * `environmentId:threadId` keys server threads use. The draft route and the
 * chat header resolve the same draft through this so they agree.
 */
export function draftSourceControlPanelStateKey(draftId: string): string {
  return `draft:${draftId}`;
}

export function resetSourceControlPanelStateMemoryForTests(): void {
  sourceControlPanelStateByThreadKey.clear();
}

/**
 * Whether the source control panel is showing for the given route search
 * params. The routes and the header toggle must always agree on this, so the
 * settings default and its wide-layout gate live here instead of at call
 * sites (a per-surface `defaultOpen` is how the 0.3.0 default-closed change
 * missed the draft route and the header button).
 *
 * Explicit URL state still wins; when the URL carries none, the thread's
 * remembered last explicit state applies before the default-open setting, so
 * leaving a thread and returning keeps the panel the way it was left.
 *
 * The default-open setting and the per-thread memory only apply on wide
 * layouts: in sheet mode the panel covers the conversation, so threads there
 * always start closed.
 */
export function useSourceControlPanelOpen(
  search: DiffRouteSearch,
  threadPanelStateKey: string | null,
): boolean {
  const sheetLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const defaultOpenSetting = useSettings((settings) => settings.sourceControlPanelDefaultOpen);
  const explicitState = search.sourceControl;
  useEffect(() => {
    if (threadPanelStateKey && explicitState) {
      sourceControlPanelStateByThreadKey.set(threadPanelStateKey, explicitState);
    }
  }, [explicitState, threadPanelStateKey]);
  const rememberedState = threadPanelStateKey
    ? sourceControlPanelStateByThreadKey.get(threadPanelStateKey)
    : undefined;
  const defaultOpen = rememberedState !== undefined ? rememberedState === "1" : defaultOpenSetting;
  return isSourceControlPanelOpen(search, { defaultOpen: defaultOpen && !sheetLayout });
}

export function normalizeRightPanelStoredWidth(width: number) {
  return width <= RIGHT_PANEL_INLINE_LEGACY_DEFAULT_WIDTH ? null : width;
}

export function useAutoHideSourceControlSheet(input: {
  enabled: boolean;
  resetKey: string | null;
  sourceControl: "1" | "0" | undefined;
  blocked?: boolean;
  onAutoHide: () => void;
}): boolean {
  const { blocked, enabled, onAutoHide, resetKey, sourceControl } = input;
  const previousRef = useRef({
    enabled: false,
    resetKey: null as string | null,
  });
  const shouldAutoHide =
    enabled &&
    !blocked &&
    sourceControl === "1" &&
    (!previousRef.current.enabled || resetKey !== previousRef.current.resetKey);

  useEffect(() => {
    previousRef.current = {
      enabled,
      resetKey,
    };

    if (!shouldAutoHide) {
      return;
    }

    onAutoHide();
  }, [enabled, onAutoHide, resetKey, shouldAutoHide]);

  return shouldAutoHide;
}
