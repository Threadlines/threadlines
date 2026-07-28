# UI polish checklist

Run against every user-facing change, on a screenshot, before it ships. This
list is how taste gets taught: every reviewed defect — Will's catches during
the sidebar redesign, and the genres in t3code PR #4700 (33 fixes, ~8 kinds) —
becomes a line here. When a new kind of defect is found, add it; never fix an
instance without recording its genre.

## Spacing and alignment

- Padding is symmetric unless asymmetry is deliberate: top gap == bottom gap,
  left inset == right inset. (Will: scope-row gap; PR: add-project, settle
  button, top controls.)
- Rows of like elements share one left edge — icon + label columns align
  across every row, including "All"/aggregate rows. No orphan indents.
  (Will: gap left of project name; icon-less "All projects" row.)
- Overlays and backings hug their content exactly — no slab wider than its
  buttons, no lead-in padding over neighbouring text. (Will: hover cluster.)
- Fixed sizes are suspicious: panels get min/max derived from content, and
  full-width rows stretch with their pane, pinned elements riding the edge.
  (Will: scope trigger; PR: project picker min-width.)

## States

- Selected ≠ hover ≠ active: three visually distinct treatments, checked in
  dark mode where token deltas collapse. One percent of white is not a state.
  (Will: dropdown selected-vs-hover.)
- Hover reveals replace, in place: swapped-in controls occupy the footprint of
  what they replace (time label ⇄ action icons) with no height or offset jump.
- Exactly one popup per hover target. A tooltip and a hover card on the same
  element is a defect regardless of each being correct. (Will: title tooltip;
  PR: tooltip padding/truncation.)
- Tooltip and preview content truncates; unbounded strings (errors, paths)
  never blow a popup open. (PR: error tooltip.)
- Empty states are designed, not blank: quiet copy plus the one action that
  fills the space.

## Interaction

- The whole row is the control: headers with a chevron collapse from anywhere
  on the row, list rows navigate from anywhere not claimed by an inner button.
  Hit targets are the visual row, not the glyph. (Will: Tied off header.)
- No auto-behaviour that moves or hides what the user arranged: no auto-hide,
  no auto-collapse, no reordering underfoot. Lifecycle transitions only.
  (Will: sidebar auto-collapse; T3: static sort.)
- Nothing the user might be standing in disappears: collapsing a section keeps
  the routed row; hiding blocked-on-you work is forbidden everywhere.
- Text that shouldn't select doesn't: labels and chrome are select-none; no
  selection underlines on click-drag. (PR: project text underline.)

## Scroll

- Section headers in scrolling panes stay sticky, with an opaque background so
  rows slide under, not through. (PR: sidebar header sticky.)
- Scroll containers fade or clip cleanly at both ends — content doesn't shear
  against chrome. (PR: scrollbar fades on top.)
- Menus and popovers never show a scrollbar for one row of overflow; size to
  content up to a max, then scroll. (PR: context-menu scrollbar.)

## Drawing

- Layered or translucent icons: overlapping transparent paths double up where
  they cross; use a single path or opaque stacking. (PR: icon path overlap.)
- One radius scale, from the design system; a rounded card next to a square
  sibling is a defect. (PR: notification radius.)
- Hairlines are structural: under section headers and between dense rows that
  need them — never both a header rule and a divider a few pixels apart, and
  never edge-to-edge where the surface's other rules are inset.
- Live-updating labels (timers, counts) are tabular-nums so they don't wiggle.

## Language

- Labels answer a question someone has; a heading that restates the obvious
  ("Threads" over a list of threads) is dropped.
- Display language may diverge from internal names (Tie off / done), but one
  surface never mixes both.

## Testing the pixels

- A browser test that asserts layout (widths, truncation, position) must load
  the production stylesheet (`index.css` + waitForProductionStyles); without it
  every Tailwind class is inert and the test measures unstyled DOM. Found
  live: ThreadHoverCard's four layout tests all passed while blind. Text and
  behaviour assertions don't need styles — only layout ones do.
- Screenshot review is part of acceptance for user-facing change: capture via
  a temporary browser-suite test, read the image, check this list against it.
