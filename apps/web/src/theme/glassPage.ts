/**
 * The marks a page puts on its parts so a theme's art shows behind it
 * (docs/design/custom-themes.md, "Where the art shows"). Spread them on the
 * elements; backdropZones.ts frosts what they mark and index.css clears or
 * tints them under glass.
 *
 * - `shell`: a wrapper that paints the page's background: clear under glass.
 * - `content`: a scrolling area: frosted the full height of the area around
 *   its column, or whole when it has none.
 * - `column`: the column of text inside a content area: the art shows crisp
 *   beside it.
 * - `header`: a strip above the content (the page's title row): tinted, like
 *   the chat's header.
 *
 * A page with none of them is frosted whole, so the art never shows raw
 * behind text.
 */
export const glassPage = {
  shell: { "data-glass-page-shell": "" },
  content: { "data-glass-page-content": "" },
  column: { "data-glass-page-column": "" },
  header: { "data-glass-page-header": "" },
} as const;

/** Selectors for the marks, for measuring them. */
export const GLASS_PAGE_SELECTOR = {
  shell: "[data-glass-page-shell]",
  content: "[data-glass-page-content]",
  column: "[data-glass-page-column]",
  header: "[data-glass-page-header]",
} as const;
