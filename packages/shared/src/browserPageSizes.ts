/**
 * The named page sizes of the browser panel: its size menu, the Settings row
 * for new tabs, and what agents may ask that row to be.
 *
 * One size per kind of screen. What a size check usually asks is which layout
 * a page switches to, and devices of one kind sit within a few dozen pixels of
 * each other, so more of them would lengthen the menu without showing more.
 * Sizes are the CSS viewport each device reports to a page.
 */
export interface BrowserPageSizePreset {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export const BROWSER_PAGE_SIZE_PRESETS: ReadonlyArray<BrowserPageSizePreset> = [
  { id: "phone", label: "Phone", width: 402, height: 874 },
  { id: "tablet", label: "Tablet", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1920, height: 1080 },
];

/** The choice id for a page that fills the panel. */
export const RESPONSIVE_PAGE_SIZE_ID = "responsive";
export const RESPONSIVE_PAGE_SIZE_LABEL = "Responsive";
