/**
 * How much tint each glass surface gets (docs/design/custom-themes.md, "Glass
 * in the app" and "The backdrop runtime"). Pure.
 *
 * - The floors are the theme's `glass`, every surface moved by the user's
 *   Glass slider (0 to 100): solid at 0, the theme's own at 50, clear at 100.
 *   It covers threads, the sidebar, the title bar, the message box and every
 *   page alike.
 * - Text over the art keeps 4.5:1, easing to 3:1 as the slider goes past the
 *   theme's own toward Clear (3:1 throughout for a theme that puts its art
 *   first). The frame raises any patch's tint until its text passes.
 * - While the backdrop frame runs, it paints every zone's tint over the art
 *   itself (raising it for readability), so the app's own surfaces are clear
 *   and alpha never compounds.
 * - When the app shows the still instead (Still, a phone, a failed or paused
 *   frame), the frame can't measure, so the surfaces paint the tint in CSS,
 *   each raised to the still's layout-independent minimum.
 * - Before the backdrop reports anything, surfaces are opaque.
 */
import type { ThemeGlass } from "@threadlines/contracts";
import { GLASS_TEXT_RATIO } from "@threadlines/shared/themeContrast";

import type { ThemeBackdropStatus } from "../components/theme/backdrop/ThemeBackdropHost";

export interface GlassFloors {
  readonly frame: number;
  readonly list: number;
  readonly column: number;
  readonly composer: number;
  /** A page's column (glassPage.ts), as a thread's. */
  readonly page: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A surface's floor at a Glass level: opaque at 0, the theme's at 50, none at 100, linear between. */
export function glassFloorAt(themeFloor: number, level: number): number {
  const theme = clamp01(themeFloor);
  const k = clamp01(level / 100);
  // From the theme's own outward, so the middle is exactly the theme's.
  return k <= 0.5 ? theme + (1 - theme) * (1 - k / 0.5) : theme * (1 - (k - 0.5) / 0.5);
}

/**
 * The contrast text over the art keeps: 4.5:1 up to the theme's own glass,
 * easing to 3:1 by three quarters of the way to Clear. A theme that puts its
 * art first (`readability: "relaxed"`) keeps 3:1 at every level.
 */
export function glassTextRatio(glass: ThemeGlass, level: number): number {
  const { standard, relaxed } = GLASS_TEXT_RATIO;
  if (glass.readability === "relaxed") return relaxed;
  return standard + (relaxed - standard) * clamp01((level / 100 - 0.5) / 0.25);
}

/** The tint floors the frame gets for its zones. The composer is never clearer than the column it sits in. */
export function glassFloors(glass: ThemeGlass, level: number): GlassFloors {
  const column = glassFloorAt(glass.column, level);
  return {
    frame: glassFloorAt(glass.frame, level),
    list: glassFloorAt(glass.list, level),
    column,
    composer: Math.max(glassFloorAt(glass.composer, level), column),
    page: column,
  };
}

/**
 * The tint each surface paints in CSS. Opaque until the backdrop reports,
 * clear while it runs (the frame tints), floors raised to the still's
 * minimum otherwise. Frame, list and column never overlap; the composer
 * card lies on the column, and keeps its own tint there (so its fill stays
 * the card's color): that only ever makes it more opaque than asked.
 */
export function cssGlassTints(
  floors: GlassFloors,
  status: ThemeBackdropStatus | null,
  tooHeavy: boolean,
): GlassFloors {
  if (status === null) return { frame: 1, list: 1, column: 1, composer: 1, page: 1 };
  if (status.kind === "running" && !tooHeavy) {
    return { frame: 0, list: 0, column: 0, composer: 0, page: 0 };
  }
  const minimum = status.kind === "running" ? 1 : clamp01(status.minimumTint);
  return {
    frame: Math.max(floors.frame, minimum),
    list: Math.max(floors.list, minimum),
    column: Math.max(floors.column, minimum),
    composer: Math.max(floors.composer, minimum),
    page: Math.max(floors.page, minimum),
  };
}

const percent = (value: number) => `${Math.round(clamp01(value) * 1000) / 10}%`;

/** The custom properties index.css's glass rules read. */
export function glassTintCss(tints: GlassFloors): string {
  return [
    `--glass-frame: ${percent(tints.frame)};`,
    `--glass-list: ${percent(tints.list)};`,
    `--glass-column: ${percent(tints.column)};`,
    `--glass-composer: ${percent(tints.composer)};`,
    `--glass-page: ${percent(tints.page)};`,
  ].join(" ");
}
