/**
 * The palette's filters (docs/design/command-palette.md, section 8): All,
 * Threads, Commands, Settings, Projects. In All each kind's group shows five
 * rows and a row that switches to that kind's filter for the rest; a single
 * filter shows its group whole. Pure: the palette hands in its sections.
 */
import type { PaletteSearchResult, PaletteSource } from "./paletteSearch";

export type PaletteFilter = "all" | PaletteSource;

export const PALETTE_FILTERS: ReadonlyArray<{
  readonly id: PaletteFilter;
  readonly label: string;
}> = [
  { id: "all", label: "All" },
  { id: "threads", label: "Threads" },
  { id: "commands", label: "Commands" },
  { id: "settings", label: "Settings" },
  { id: "projects", label: "Projects" },
];

/** Rows a kind's group shows in All before its "Show all N" row. */
export const ALL_FILTER_GROUP_CAP = 5;

/** The filter Tab (step 1) or Shift+Tab (step -1) moves to, wrapping around. */
export function stepPaletteFilter(current: PaletteFilter, step: 1 | -1): PaletteFilter {
  const index = PALETTE_FILTERS.findIndex((filter) => filter.id === current);
  const next = (index + step + PALETTE_FILTERS.length) % PALETTE_FILTERS.length;
  return PALETTE_FILTERS[next]!.id;
}

/** Each filter's row count for a search: what that filter shows, close matches included. */
export function paletteFilterCounts<T>(
  result: PaletteSearchResult<T>,
): Readonly<Record<PaletteFilter, number>> {
  const count = (filter: PaletteFilter) => {
    const shown = filterPaletteSearch(result, filter);
    return (
      shown.sections.reduce((total, section) => total + section.total, 0) +
      shown.closeMatches.length
    );
  };
  return {
    all: count("all"),
    threads: count("threads"),
    commands: count("commands"),
    settings: count("settings"),
    projects: count("projects"),
  };
}

export interface PaletteFilteredSection<T> {
  readonly source: PaletteSource;
  /** The rows shown, at most five in All. */
  readonly rows: ReadonlyArray<T>;
  /** How many the kind found; more than `rows` means a "Show all" row follows. */
  readonly total: number;
}

/**
 * The search's sections as a filter shows them: in All every kind, five rows
 * each; in a single filter only its kind, whole. Close matches show only when
 * the filter found nothing itself: under the filter of their kind, or all of
 * them in All. So a thread match never hides a command's close match from
 * the Commands filter.
 */
export function filterPaletteSearch<T>(
  result: PaletteSearchResult<T>,
  filter: PaletteFilter,
): {
  readonly sections: ReadonlyArray<PaletteFilteredSection<T>>;
  readonly closeMatches: ReadonlyArray<T>;
} {
  const sections = result.sections
    .filter((section) => filter === "all" || section.source === filter)
    .map((section) => {
      const rows = section.rows.map((row) => row.value);
      return {
        source: section.source,
        rows: filter === "all" ? rows.slice(0, ALL_FILTER_GROUP_CAP) : rows,
        total: rows.length,
      };
    });
  const closeMatches =
    sections.length > 0
      ? []
      : result.closeMatches
          .filter((match) => filter === "all" || match.source === filter)
          .map((match) => match.value);
  return { sections, closeMatches };
}
