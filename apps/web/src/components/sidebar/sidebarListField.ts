/**
 * The quiet surface the top of the thread list shares: the search bar and the
 * project picker under it look like one pair. 32px tall so the rail's first
 * button and the page-list headers sit on the same line (center 28px below the
 * panel's top edge, which is one hairline below the rail's top).
 */
export const SIDEBAR_LIST_FIELD_CLASS =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 text-muted-foreground transition-colors select-none hover:border-border hover:bg-muted/50 hover:text-foreground focus-ring";
