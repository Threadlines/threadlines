import { type RefCallback, useCallback, useEffect, useRef } from "react";

import { isElectron } from "./env";

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

export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";
// The source control sheet starts below the chat header (measured into
// --chat-header-bottom) so the header's toggle stays visible and interactive
// while the panel is open. The popup re-enables pointer events because its
// viewport disables them to let presses over the header reach the header.
export const RIGHT_PANEL_SOURCE_CONTROL_SHEET_CLASS_NAME =
  "pointer-events-auto mt-[var(--chat-header-bottom)] h-[calc(100%-var(--chat-header-bottom))] max-h-[calc(100%-var(--chat-header-bottom))] w-[var(--right-panel-inline-min-width)] min-w-[var(--right-panel-inline-min-width)] max-w-[var(--right-panel-inline-min-width)] p-0 max-[288px]:w-[calc(100vw-(--spacing(12)))] max-[288px]:min-w-0";
export const RIGHT_PANEL_SOURCE_CONTROL_SHEET_VIEWPORT_CLASS_NAME = "pointer-events-none";
export const RIGHT_PANEL_SOURCE_CONTROL_SHEET_BACKDROP_CLASS_NAME =
  "mt-[var(--chat-header-bottom)]";

export const CHAT_HEADER_BOTTOM_CSS_VAR = "--chat-header-bottom";

/**
 * Publishes the chat header's bottom edge (in viewport px) as a root-level CSS
 * variable so body-portaled overlays can align to it. Attach the returned ref
 * to the chat header element; the variable falls back to the 0px default from
 * index.css while no header is mounted.
 */
export function useChatHeaderBottomVarRef(): RefCallback<HTMLElement> {
  return useCallback((node: HTMLElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const rootStyle = document.documentElement.style;
    const publish = () => {
      rootStyle.setProperty(CHAT_HEADER_BOTTOM_CSS_VAR, `${node.getBoundingClientRect().bottom}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    publish();
    return () => {
      observer.disconnect();
      rootStyle.removeProperty(CHAT_HEADER_BOTTOM_CSS_VAR);
    };
  }, []);
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
