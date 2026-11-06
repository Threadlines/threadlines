/**
 * How much tint each glass surface gets (docs/design/custom-themes.md, "Glass
 * in the app" and "The backdrop runtime"). Pure.
 *
 * - The floors are the theme's `glass`, with the reading column's moved by
 *   the user's "Art in threads": None makes it opaque, Some keeps the
 *   theme's, Full halves it.
 * - While the backdrop frame runs, it paints every zone's tint over the art
 *   itself (raising it for readability), so the app's own surfaces are clear
 *   and alpha never compounds.
 * - When the app shows the still instead (Still, a phone, a failed or paused
 *   frame), the frame can't measure, so the surfaces paint the tint in CSS,
 *   each raised to the still's layout-independent minimum.
 * - Before the backdrop reports anything, surfaces are opaque.
 */
import type { ThemeArtInThreads, ThemeGlass } from "@threadlines/contracts";

import type { ThemeBackdropStatus } from "../components/theme/backdrop/ThemeBackdropHost";

export interface GlassFloors {
  readonly frame: number;
  readonly list: number;
  readonly column: number;
  readonly composer: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The column floor "Art in threads" sets from the theme's. */
export function columnFloor(themeColumn: number, artInThreads: ThemeArtInThreads): number {
  switch (artInThreads) {
    case "none":
      return 1;
    case "some":
      return clamp01(themeColumn);
    case "full":
      return clamp01(themeColumn / 2);
  }
}

/** The tint floors the frame gets for its zones. The composer is never clearer than the column it sits in. */
export function glassFloors(glass: ThemeGlass, artInThreads: ThemeArtInThreads): GlassFloors {
  const column = columnFloor(glass.column, artInThreads);
  return {
    frame: clamp01(glass.frame),
    list: clamp01(glass.list),
    column,
    composer: Math.max(clamp01(glass.composer), column),
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
  if (status === null) return { frame: 1, list: 1, column: 1, composer: 1 };
  if (status.kind === "running" && !tooHeavy) {
    return { frame: 0, list: 0, column: 0, composer: 0 };
  }
  const minimum = status.kind === "running" ? 1 : clamp01(status.minimumTint);
  return {
    frame: Math.max(floors.frame, minimum),
    list: Math.max(floors.list, minimum),
    column: Math.max(floors.column, minimum),
    composer: Math.max(floors.composer, minimum),
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
  ].join(" ");
}
