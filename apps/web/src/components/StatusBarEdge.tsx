import { isIPhone } from "../env";

/**
 * A see-through strip pinned along the top of the page, so iPhone Safari reads
 * the page as having a top bar.
 *
 * Since iOS 26, Safari and the home-screen app draw a soft blur under the
 * status bar that reaches a little way into the page, smearing the top of
 * every page's header. WebKit skips that blur when a pinned (fixed or sticky)
 * element spans the top edge, and fills the status bar with that element's
 * color instead. Our headers sit in the page's normal flow, so this strip
 * stands in for them: wider than 90% of the screen, taller than 10px and
 * with a painted background, which is what WebKit's check asks for. Its
 * background is the page color at 1%, invisible over a header and blended by
 * WebKit with the page background, so the status bar keeps the page color in
 * both themes.
 * It sits above the page but below toasts and dialogs, and never takes a tap.
 *
 * iPhone only: an iPad draws a solid bar there instead of the blur, and stops
 * rechecking the strip's color once the page is used, so a theme switch would
 * leave its status bar in the old color.
 */
export function StatusBarEdge() {
  if (!isIPhone()) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-30 h-3 bg-background/1"
      data-slot="status-bar-edge"
    />
  );
}
