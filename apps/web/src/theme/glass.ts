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
 * - The last quarter, toward Clear, gives that up on purpose (`clarity`):
 *   the frost and the tint readability adds fade out together, so Clear
 *   shows the art as it is, with nothing between it and the text. The
 *   user picked that; Solid to three quarters keeps every promise above.
 * - While the backdrop frame runs, it paints every zone's tint over the art
 *   itself (raising it for readability), so the app's own surfaces are clear
 *   and alpha never compounds.
 * - Motion: Still keeps the frame (and phones always use it): it draws one
 *   frame of the art for this screen and stands, tinting it the same way, so
 *   the surfaces stay clear.
 * - When the app shows the still image instead (a failed frame, art found too
 *   heavy, or before the frame draws), the frame can't measure, so the
 *   surfaces paint the tint in CSS, each raised to the still's
 *   layout-independent minimum.
 * - Before the backdrop reports anything, surfaces are opaque.
 */
import type { ThemeBackdropStatus } from "../components/theme/backdrop/ThemeBackdropHost";
import type { GlassFloors } from "@threadlines/shared/themeGlassFloors";

export {
  glassClarity,
  glassFloorAt,
  glassFloors,
  glassTextRatio,
  type GlassFloors,
} from "@threadlines/shared/themeGlassFloors";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The tint each surface paints in CSS. Opaque until the backdrop reports,
 * clear while it runs (the frame tints), floors raised to the still's
 * minimum otherwise, that raise fading by `clarity` as the frame's does.
 * Frame, list and column never overlap; the composer card lies on the
 * column, and keeps its own tint there (so its fill stays the card's
 * color): that only ever makes it more opaque than asked.
 */
export function cssGlassTints(
  floors: GlassFloors,
  status: ThemeBackdropStatus | null,
  tooHeavy: boolean,
  clarity: number,
): GlassFloors {
  if (status === null) return { frame: 1, list: 1, column: 1, composer: 1, page: 1 };
  // The frame tints over the art itself: live, or one frame standing for Motion: Still.
  if ((status.kind === "running" && !tooHeavy) || (status.kind === "still" && status.framed)) {
    return { frame: 0, list: 0, column: 0, composer: 0, page: 0 };
  }
  const minimum = status.kind === "running" ? 1 : clamp01(status.minimumTint) * (1 - clarity);
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
