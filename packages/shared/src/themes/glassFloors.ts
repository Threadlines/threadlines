/**
 * The Glass slider's math (docs/design/custom-themes.md, "Glass in the app"):
 * how much tint each glass surface gets at a Glass level (0 solid, 50 the
 * theme's own, 100 clear), how far the frost has faded, and the contrast text
 * over the art keeps. Pure; the app (apps/web theme/glass.ts) and the
 * marketing site's hero window share it.
 */
import type { ThemeGlass } from "@threadlines/contracts";

import { GLASS_TEXT_RATIO } from "./contrast.ts";

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
 * How far the frost and the readability tint have faded, 0 to 1: none up to
 * three quarters of the way, all of it at Clear, linear between.
 */
export function glassClarity(level: number): number {
  return clamp01((level / 100 - 0.75) / 0.25);
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
