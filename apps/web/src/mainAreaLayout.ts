import { type CSSProperties, type RefObject, useEffect } from "react";
import { create } from "zustand";

/**
 * Where the main area sits in the window: the page beside the thread list on
 * the left and the right panel on the right. Layers portaled to the body are
 * fixed to the window, not to the page, so they read this instead: toasts stay
 * beside the right panel, and dialogs, the command palette and the theme trial
 * bar center over the page (the `center-on-main-area` utility in index.css).
 *
 * A store rather than CSS variables on the root: these edges move every frame
 * while the thread list slides or a panel is dragged, and a variable on the
 * root restyles the whole app each time (about 5ms on a near-empty page). Only
 * the layers on screen subscribe, and they carry the values inline.
 */
interface MainAreaBounds {
  /** The page's left edge, in px from the window's left edge. */
  readonly start: number;
  /** How much of the window's right edge the open right panel takes, in px. */
  readonly endInset: number;
}

const useMainAreaStore = create<MainAreaBounds>()(() => ({ start: 0, endInset: 0 }));

export function readMainAreaBounds(): MainAreaBounds {
  return useMainAreaStore.getState();
}

/** Publishes the page's left edge (0 resets it: no list, no rail). */
export function publishMainAreaStart(start: number): void {
  if (useMainAreaStore.getState().start !== start) useMainAreaStore.setState({ start });
}

/** Publishes the right panel's width (0 while it is closed or gone). */
export function publishMainAreaEndInset(endInset: number): void {
  if (useMainAreaStore.getState().endInset !== endInset) useMainAreaStore.setState({ endInset });
}

/**
 * Publishes where the page starts in the app panel: the right edge of the
 * thread list's slot, or the panel's own left edge while the list is hidden
 * (closed, or a drawer on a phone). The app shell calls it with the panel that
 * holds the list. The slot resizes as the list opens, closes or is dragged,
 * the panel as the window resizes, and the slot itself is swapped when the
 * list turns into a drawer and back.
 */
export function usePublishMainAreaStart(panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return undefined;
    let listSlot: Element | null = null;
    const publish = () => {
      const nextListSlot = panel.querySelector(":scope > [data-slot='sidebar']");
      if (nextListSlot !== listSlot) {
        if (listSlot) resizeObserver.unobserve(listSlot);
        if (nextListSlot) resizeObserver.observe(nextListSlot);
        listSlot = nextListSlot;
      }
      // A slot that is display:none (narrow windows) measures 0 everywhere.
      const listRight = listSlot?.getBoundingClientRect().right ?? 0;
      publishMainAreaStart(Math.round(Math.max(panel.getBoundingClientRect().left, listRight)));
    };
    const resizeObserver = new ResizeObserver(publish);
    const mutationObserver = new MutationObserver(publish);
    resizeObserver.observe(panel);
    mutationObserver.observe(panel, { childList: true });
    publish();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      publishMainAreaStart(0);
    };
  }, [panelRef]);
}

/**
 * Inline style for a layer that centers itself with `center-on-main-area`:
 * how far right of the window's center the page's center sits (negative when
 * it sits left of it).
 */
export function useMainAreaCenterStyle(): CSSProperties {
  const offset = useMainAreaStore((bounds) => Math.round((bounds.start - bounds.endInset) / 2));
  return { "--main-area-offset": `${offset}px` } as CSSProperties;
}

/** Inline style for a layer anchored to the window's right edge: `--right-panel-inset`. */
export function useRightPanelInsetStyle(): CSSProperties {
  const endInset = useMainAreaStore((bounds) => bounds.endInset);
  return { "--right-panel-inset": `${endInset}px` } as CSSProperties;
}
