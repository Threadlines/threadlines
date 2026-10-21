/**
 * The bottom edge of a page header inside the work panel: no rule, just a
 * short fade the content passes into as it scrolls under the header. A rule
 * there would meet the thread list's divider in a square T; the fade leaves
 * that divider one clean line from top to bottom (the thread list's search
 * row ends the same way). The header that holds it must be positioned.
 */
export function HeaderEdgeFade() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-full z-10 h-3 bg-linear-to-b from-background to-transparent"
    />
  );
}
