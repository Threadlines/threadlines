/**
 * Where the Glass slider stands (docs/design/custom-themes.md, "Glass in the
 * app"): the user's own level, else their choice from before the slider
 * ("Art in threads": None, Some, Full), else the theme's own glass.
 */
import { THEME_GLASS_LEVEL_DEFAULT, type ThemeArtInThreads } from "@threadlines/contracts";

/** Old "Art in threads" choices on the slider: None solid, Some the theme's, Full most of the way clear. */
const FROM_ART_IN_THREADS: Readonly<Record<ThemeArtInThreads, number>> = {
  none: 0,
  some: THEME_GLASS_LEVEL_DEFAULT,
  full: 75,
};

/** The Glass level, 0 to 100, for these settings. */
export function themeGlassLevel(settings: {
  readonly themeGlass?: number | undefined;
  readonly themeArtInThreads?: ThemeArtInThreads | undefined;
}): number {
  if (settings.themeGlass !== undefined) return settings.themeGlass;
  return settings.themeArtInThreads === undefined
    ? THEME_GLASS_LEVEL_DEFAULT
    : FROM_ART_IN_THREADS[settings.themeArtInThreads];
}
