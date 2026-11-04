/**
 * Named page sizes for the browser panel, shared by the device toolbar's size
 * menu and the Settings row that picks the size new tabs open at.
 *
 * Shortcuts for a width and height rather than the only way to choose one:
 * the toolbar's fields reach any other size by typing it. Sizes are the CSS
 * viewport each device reports to a page.
 */

import { MAX_BROWSER_PAGE_DIMENSION } from "@threadlines/contracts";
import {
  BROWSER_PAGE_SIZE_PRESETS,
  RESPONSIVE_PAGE_SIZE_ID,
  RESPONSIVE_PAGE_SIZE_LABEL,
} from "@threadlines/shared/browserPageSizes";

export {
  BROWSER_PAGE_SIZE_PRESETS,
  RESPONSIVE_PAGE_SIZE_ID,
  RESPONSIVE_PAGE_SIZE_LABEL,
} from "@threadlines/shared/browserPageSizes";

/** null dimensions mean the page fills the panel and reflows with it. */
export interface BrowserViewport {
  width: number | null;
  height: number | null;
}

export const RESPONSIVE_VIEWPORT: BrowserViewport = Object.freeze({ width: null, height: null });

const PRESETS = BROWSER_PAGE_SIZE_PRESETS;

export function isResponsiveViewport(viewport: BrowserViewport): boolean {
  return viewport.width === null || viewport.height === null;
}

export function sameViewport(a: BrowserViewport, b: BrowserViewport): boolean {
  if (isResponsiveViewport(a) || isResponsiveViewport(b)) {
    return isResponsiveViewport(a) && isResponsiveViewport(b);
  }
  return a.width === b.width && a.height === b.height;
}

function settingDimension(value: number): number {
  return Math.min(MAX_BROWSER_PAGE_DIMENSION, Math.max(1, Math.round(value)));
}

/**
 * `viewport` as the size setting stores it: its dimensions, or null to fill
 * the panel. Kept within what the setting accepts, since dragging the page's
 * edge can make a size the fields would not.
 */
export function fixedPageSize(viewport: BrowserViewport): { width: number; height: number } | null {
  return viewport.width === null || viewport.height === null
    ? null
    : { width: settingDimension(viewport.width), height: settingDimension(viewport.height) };
}

/** The named size `viewport` is, if it is one: Responsive or a preset. */
export function pageSizeChoiceId(viewport: BrowserViewport): string | null {
  if (isResponsiveViewport(viewport)) return RESPONSIVE_PAGE_SIZE_ID;
  return (
    PRESETS.find((preset) => preset.width === viewport.width && preset.height === viewport.height)
      ?.id ?? null
  );
}

/** The viewport a choice id stands for, or null for an id that names nothing. */
export function viewportForPageSizeChoice(id: string): BrowserViewport | null {
  if (id === RESPONSIVE_PAGE_SIZE_ID) return RESPONSIVE_VIEWPORT;
  const preset = PRESETS.find((entry) => entry.id === id);
  return preset === undefined ? null : { width: preset.width, height: preset.height };
}

/** "402 × 874", as the size menus print a width and height. */
export function formatPageDimensions(width: number, height: number): string {
  return `${width} × ${height}`;
}

/** What a size is called: its preset's name, or its dimensions when it has none. */
export function pageSizeName(viewport: BrowserViewport): string {
  if (isResponsiveViewport(viewport)) return RESPONSIVE_PAGE_SIZE_LABEL;
  const preset = PRESETS.find(
    (entry) => entry.width === viewport.width && entry.height === viewport.height,
  );
  return preset?.label ?? formatPageDimensions(viewport.width ?? 0, viewport.height ?? 0);
}
