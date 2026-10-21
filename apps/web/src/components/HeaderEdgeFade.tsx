/**
 * The bottom edge of a header inside the work panel: no rule, just a short,
 * light fade that content passes into as it scrolls under the header. A rule
 * there would meet the thread list's divider in a square T; the fade leaves
 * that divider one clean line from top to bottom (the thread list's search row
 * ends the same way).
 *
 * `below` hangs it under a positioned header that spans only its own page.
 * `top` lays it at the top of a positioned scroll region, for a header that
 * also spans docked panels (the thread's header over the browser and side
 * panels): there it covers only the conversation, never a panel beside it.
 */
export function HeaderEdgeFade({ at }: { readonly at: "below" | "top" }) {
  return (
    <span
      aria-hidden="true"
      className={
        at === "below"
          ? "pointer-events-none absolute inset-x-0 top-full z-10 h-2.5 bg-linear-to-b from-background/75 to-transparent"
          : "pointer-events-none absolute inset-x-0 top-0 z-10 h-2.5 bg-linear-to-b from-background/75 to-transparent"
      }
    />
  );
}
