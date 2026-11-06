export type VisualViewportEdge = "top" | "bottom";

/** Pinch zoom also shrinks the visual viewport; only a 1:1 scale reliably means
 * the height lost is the on-screen keyboard's. */
function unzoomedVisualViewport(): VisualViewport | null {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) {
    return null;
  }
  return viewport;
}

/**
 * How much of the layout viewport an on-screen keyboard leaves out of view at
 * one edge, in px: at the bottom, what the keyboard covers; at the top, how far
 * iOS Safari scrolled the page up to show the focused field above it. Only
 * browsers whose keyboard slides over the page (iOS Safari) report anything;
 * one that resizes the page instead (Android Chrome, which honors
 * `interactive-widget=resizes-content`) reports 0, as does a pinch-zoomed page.
 */
export function readVisualViewportInset(edge: VisualViewportEdge): number {
  const viewport = unzoomedVisualViewport();
  if (!viewport) {
    return 0;
  }
  if (edge === "top") {
    return Math.max(0, Math.round(viewport.offsetTop));
  }
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/** The visual viewport's whole shrink, whichever edge Safari scrolled it from. */
function readOnScreenKeyboardHeight(): number {
  const viewport = unzoomedVisualViewport();
  return viewport ? Math.max(0, Math.round(window.innerHeight - viewport.height)) : 0;
}

/**
 * Shorter than any on-screen keyboard (an iPhone's is 216px before its bars)
 * and taller than anything else that can take a little off the visible page,
 * such as a hardware keyboard's shortcut bar, which can keep the padding.
 */
const ON_SCREEN_KEYBOARD_MIN_HEIGHT_PX = 120;

/** Set on `<html>` while an on-screen keyboard covers the bottom of the screen. */
export const ON_SCREEN_KEYBOARD_ATTRIBUTE = "data-on-screen-keyboard";

/**
 * Marks `<html>` with `data-on-screen-keyboard` while an on-screen keyboard is
 * up, so CSS can drop the room it keeps for the home indicator (the bar along
 * the bottom of an iPhone) when the keyboard covers it: iOS keeps reporting
 * `env(safe-area-inset-bottom)` at full height with the keyboard open, which
 * would leave a bar padded by it floating that far above the keyboard.
 * `--safe-area-bottom` (index.css) is the safe area with this applied.
 *
 * It measures the keyboard by the whole visual viewport shrink, not by the
 * bottom edge it covers: with the composer at the bottom of the page, Safari
 * scrolls the page up until the keyboard covers none of it. The attribute only
 * changes when the keyboard comes or goes, so styles recalculate just then.
 * Returns the way to undo it.
 */
export function installOnScreenKeyboardFlag(): () => void {
  const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const root = document.documentElement;
  const sync = () => {
    root.toggleAttribute(
      ON_SCREEN_KEYBOARD_ATTRIBUTE,
      readOnScreenKeyboardHeight() >= ON_SCREEN_KEYBOARD_MIN_HEIGHT_PX,
    );
  };
  sync();
  viewport.addEventListener("resize", sync);
  return () => {
    viewport.removeEventListener("resize", sync);
    root.removeAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE);
  };
}
