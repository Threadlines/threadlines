/**
 * The composer's box: the one raised box on the canvas, a card fill and a
 * border, its border taking the focus color while a control inside has
 * keyboard focus. In light mode a white box on the near-white canvas also
 * needs the soft drop to read; in dark the lighter fill does that on its own.
 * The scheduled task editor is drawn in the same box.
 */
export const COMPOSER_SURFACE_CLASS_NAME =
  "rounded-4xl border bg-card not-dark:elevate-raised transition-colors duration-200 has-focus-visible:border-focus-ring/45";
