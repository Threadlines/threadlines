import type { Popover } from "@base-ui/react/popover";
import { useMemo } from "react";
import { create } from "zustand";

/**
 * The strips a screen holds back down its sides: the notch side of a phone
 * held sideways, and the status dock (clock, battery, signal) down the right
 * edge of an iPhone Duo, folded or open. `--safe-area-left` and
 * `--safe-area-right` in index.css carry their widths, 0 on every other
 * screen, where nothing here changes anything.
 *
 * A surface that touches a side of the window carries its fill into the strip
 * and keeps its controls out of it; a layer fixed to the window stays off the
 * strip. CSS does that with the variables (and the class names below). What is
 * placed by script (a menu or popover beside its button, a dialog centered
 * over the page) reads the widths in pixels from here.
 */
export interface SideStrips {
  readonly left: number;
  readonly right: number;
}

const useSideStripsStore = create<SideStrips>()(() => ({ left: 0, right: 0 }));

/**
 * Follows the strips' widths without ever asking for them: a hidden box as
 * wide as the right strip and as tall as the left one, whose size the browser
 * reports when it changes (the phone folds, unfolds or turns). No resize
 * listener and no forced layout, so a desktop window being dragged pays
 * nothing for it.
 */
function watchSideStrips(): void {
  if (typeof document === "undefined" || typeof ResizeObserver === "undefined") return;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;width:var(--safe-area-right,0px);height:var(--safe-area-left,0px)";
  new ResizeObserver(() => {
    const { width, height } = probe.getBoundingClientRect();
    const current = useSideStripsStore.getState();
    if (current.left !== height || current.right !== width) {
      useSideStripsStore.setState({ left: height, right: width });
    }
  }).observe(probe);
  // On the root, not the body: tests empty the body between runs.
  document.documentElement.appendChild(probe);
}

watchSideStrips();

/** The strips' widths in px, as last reported. */
export function readSideStrips(): SideStrips {
  return useSideStripsStore.getState();
}

/** The strips' widths in px; re-renders when the screen's strips change. */
export function useSideStrips(): SideStrips {
  return useSideStripsStore();
}

type CollisionPadding = Popover.Positioner.Props["collisionPadding"];

/** Base UI's own gap between a popup and the window's edge, when none is asked for. */
const DEFAULT_COLLISION_PADDING_PX = 5;

/**
 * The closest a popup placed beside its button (a menu, a popover, a select's
 * list) may come to the window's edges: what its caller asked for, kept that
 * far off the screen's side strips too. Pass the result to the positioner's
 * `collisionPadding`. Without strips it is the caller's own value, untouched.
 */
export function useCollisionPadding(padding?: CollisionPadding): CollisionPadding {
  const { left, right } = useSideStripsStore();
  return useMemo(() => {
    if (left === 0 && right === 0) return padding;
    if (padding === undefined || typeof padding === "number") {
      const gap = padding ?? DEFAULT_COLLISION_PADDING_PX;
      return { top: gap, bottom: gap, left: gap + left, right: gap + right };
    }
    return { ...padding, left: (padding.left ?? 0) + left, right: (padding.right ?? 0) + right };
  }, [left, padding, right]);
}

/**
 * A centered layer's viewport: the layer stays a rem off each strip and each
 * edge of the window (`window-gutters` in index.css). It is the viewport's
 * side padding, in place of a `px-4`.
 */
export const VIEWPORT_SIDE_STRIPS_CLASS_NAME = "window-gutters [--side-gutter:--spacing(4)]";

/**
 * A phone's bottom sheet (a dialog below `sm`): it is as wide as the window,
 * so its fill runs under the strips and its content is padded out of them. It
 * says how far in `--sheet-strip-left` and `--sheet-strip-right`, for the
 * parts that reach its edges themselves: a footer's fill
 * (SHEET_FOOTER_SIDE_STRIPS_CLASS_NAME) and the close button.
 */
export const BOTTOM_SHEET_SIDE_STRIPS_CLASS_NAME = "max-sm:sheet-strips";

/**
 * A filled footer inside such a sheet: the fill reaches the sheet's edges,
 * the buttons stay out of the strips. It is the footer's side padding, in
 * place of its `px-6`.
 */
export const SHEET_FOOTER_SIDE_STRIPS_CLASS_NAME = "sheet-footer-strips";
