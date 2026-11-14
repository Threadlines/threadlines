export type VisualViewportEdge = "top" | "bottom";

/**
 * The least of the window a visual viewport can show and still be read as a
 * page with a keyboard over it. No on-screen keyboard takes nine tenths of
 * its window (a small phone on its side keeps about a third). A reading
 * under this is taken to mean the page is off screen for a moment. That is
 * the best explanation, not a measured one, for an iPhone Duo's sheets and
 * drawers opening squeezed to nothing after a fold: read as a keyboard, a
 * visual viewport of about no height pads them by the whole window, and
 * the reading can outlast the fold with no resize event to correct it.
 */
const VISIBLE_PAGE_MIN_SHARE_OF_WINDOW = 0.1;

/**
 * The visual viewport, when what it has lost can be an on-screen keyboard's
 * doing. Pinch zoom shrinks it too, so only a 1:1 scale counts, and so does
 * only a viewport that still shows some of the page.
 */
function keyboardVisualViewport(): VisualViewport | null {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (
    !viewport ||
    Math.abs(viewport.scale - 1) > 0.01 ||
    viewport.height < window.innerHeight * VISIBLE_PAGE_MIN_SHARE_OF_WINDOW
  ) {
    return null;
  }
  return viewport;
}

/**
 * Calls back when an on-screen keyboard may have come, gone or moved the
 * page. The window's own resize counts too: the readings compare the visual
 * viewport with the window, and the window can change size (a folding phone,
 * a turned one) with no event on the visual viewport. Returns the way to stop.
 */
export function watchOnScreenKeyboard(onChange: () => void): () => void {
  const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!viewport) {
    return () => {};
  }
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/**
 * How much of the layout viewport an on-screen keyboard leaves out of view at
 * one edge, in px: at the bottom, what the keyboard covers; at the top, how far
 * iOS Safari scrolled the page up to show the focused field above it. Only
 * browsers whose keyboard slides over the page (iOS Safari) report anything;
 * one that resizes the page instead (Android Chrome, which honors
 * `interactive-widget=resizes-content`) reports 0, as does a pinch-zoomed page
 * and one that is off screen for a moment.
 */
export function readVisualViewportInset(edge: VisualViewportEdge): number {
  const viewport = keyboardVisualViewport();
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
  const viewport = keyboardVisualViewport();
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
  if (typeof window === "undefined" || !window.visualViewport) {
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
  const stopWatching = watchOnScreenKeyboard(sync);
  return () => {
    stopWatching();
    root.removeAttribute(ON_SCREEN_KEYBOARD_ATTRIBUTE);
  };
}
